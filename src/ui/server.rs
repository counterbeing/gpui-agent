//! One opted-in window, native tree discovery, native input, optional independent test checks.
use crate::{Method, Response, Session};
use gpui::{App, Context, Entity, Render, Window};
use std::{
    sync::mpsc::TryRecvError,
    time::{Duration, Instant},
};

/// Start the generic bridge. No app-specific controls, input callbacks or test checks required.
pub fn serve<T: Render>(
    view: Entity<T>,
    token: String,
    window: &mut Window,
    cx: &mut App,
) -> Result<(), &'static str> {
    serve_with_checks(
        view,
        token,
        window,
        cx,
        |_, _, _, _| serde_json::json!({"passed": false, "error": "no_check_configured"}),
    )
}

/// The same bridge with optional independent assertions for a test harness.
/// Assertions never provide the control tree or execute actions.
pub fn serve_with_checks<T: Render>(
    view: Entity<T>,
    token: String,
    window: &mut Window,
    cx: &mut App,
    mut verify: impl FnMut(&mut T, &str, &Window, &mut Context<T>) -> serde_json::Value + 'static,
) -> Result<(), &'static str> {
    window.enable_local_automation()?;
    let requests = crate::transport::stdio();
    let handle = window.window_handle();
    let mut session = Session::new(token);
    cx.spawn(async move |cx| {
        let started = Instant::now();
        let mut commands = 0;
        loop {
            cx.background_executor()
                .timer(Duration::from_millis(20))
                .await;
            if started.elapsed() > Duration::from_secs(180) || commands >= 512 {
                cx.update(|cx| cx.quit());
                break;
            }
            let pending = match requests.try_recv() {
                Ok(pending) => pending,
                Err(TryRecvError::Empty) => continue,
                Err(TryRecvError::Disconnected) => {
                    cx.update(|cx| cx.quit());
                    break;
                }
            };
            commands += 1;
            let closing = matches!(pending.request.method, Method::Close);
            let result = handle.update(cx, |_, window, cx| {
                let request = &pending.request;
                if let Err(error) = session.accept(request) {
                    return Response::failure(request.id, &error.to_string());
                }
                view.update(cx, |_, cx| cx.notify());
                window.draw(cx).clear(cx);
                window.refresh();
                let current = match super::surface(window) {
                    Ok(surface) => surface,
                    Err(error) => return Response::failure(request.id, error),
                };
                match &request.method {
                    Method::Observe => match session.observe(current) {
                        Ok(snapshot) => Response::success(request.id, snapshot),
                        Err(error) => Response::failure(request.id, &error.to_string()),
                    },
                    Method::Act { action } => {
                        let control = match session.admit(action, &current) {
                            Ok(control) => control,
                            Err(error) => return Response::failure(request.id, &error.to_string()),
                        };
                        let result = super::dispatch(
                            &control,
                            action.operation,
                            action.text.as_deref(),
                            window,
                            cx,
                        );
                        window.refresh();
                        match result {
                            Ok(()) => {
                                Response::success(request.id, serde_json::json!({"executed": true}))
                            }
                            Err(error) => Response::failure(request.id, error),
                        }
                    }
                    Method::Verify { check } => Response::success(
                        request.id,
                        view.update(cx, |view, cx| verify(view, check, window, cx)),
                    ),
                    Method::Close => {
                        Response::success(request.id, serde_json::json!({"closing": true}))
                    }
                }
            });
            match result {
                Ok(response) => {
                    let close = closing && response.ok;
                    pending.reply(response);
                    if close {
                        cx.background_executor()
                            .timer(Duration::from_millis(100))
                            .await;
                        cx.update(|cx| cx.quit());
                        break;
                    }
                }
                Err(_) => {
                    pending.reply(Response::failure(0, "window_closed"));
                    break;
                }
            }
        }
    })
    .detach();
    Ok(())
}
