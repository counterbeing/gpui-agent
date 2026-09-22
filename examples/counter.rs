//! Independent GPUI app. Normal accessibility semantics; no automation probes or Host trait.
use gpui::{App, Context, Role, Window, WindowOptions, div, prelude::*, rgb};
use gpui_agent::ui;

struct Counter {
    value: u32,
    clipped: bool,
}
impl Render for Counter {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .size_full()
            .p_8()
            .bg(rgb(0x252525))
            .text_color(rgb(0xffffff))
            .child(
                div()
                    .id("count")
                    .role(Role::Label)
                    .aria_label(format!("Count: {}", self.value))
                    .child(format!("Count: {}", self.value)),
            )
            .child(
                div()
                    .when(self.clipped, |container| {
                        container.h(gpui::px(36.)).overflow_hidden()
                    })
                    .child(
                        div()
                            .id("increment")
                            .role(Role::Button)
                            .aria_label("Increment")
                            .p_4()
                            .mt_4()
                            .bg(rgb(0x454545))
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.value += 1;
                                cx.notify();
                            }))
                            .child("Increment"),
                    ),
            )
    }
}
fn main() {
    let args: Vec<_> = std::env::args().skip(1).collect();
    let [flag, token] = args.as_slice() else {
        eprintln!("Usage: counter --agent|--agent-clipped TOKEN");
        return;
    };
    if !matches!(flag.as_str(), "--agent" | "--agent-clipped")
        || token.len() != 32
        || !token.bytes().all(|b| b.is_ascii_hexdigit())
    {
        eprintln!("An explicit test-session token is required");
        return;
    }
    let clipped = flag == "--agent-clipped";
    let token = token.clone();
    gpui_platform::application().run(move |cx: &mut App| {
        if cx.open_window(WindowOptions { focus: false, ..Default::default() }, move |window, cx| {
            let view = cx.new(|_| Counter { value: 0, clipped });
            // Optional test oracle; ordinary bridge use needs only ui::serve(view, token, window, cx).
            if ui::serve_with_checks(view.clone(), token, window, cx, |view, check, _, _| {
                serde_json::json!({"passed": check == "count-two" && view.value == 2, "count": view.value})
            }).is_err() { cx.quit(); }
            view
        }).is_err() { cx.quit(); }
    });
}
