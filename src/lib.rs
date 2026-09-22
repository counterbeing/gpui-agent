//! Versioned, opt-in native UI automation. The host owns authority and verification.
//!
//! No networking, model credentials, global input, filesystem operations, or shell execution.
//! Use [`Session`] to bind an action to exactly the observation on which it was chosen.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub mod transport;
#[cfg(feature = "native-tree")]
pub mod ui;

pub const VERSION: u32 = 1;
pub const MAX_MESSAGE: u64 = 65_536;
pub const MAX_CONTROLS: usize = 512;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Rect {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}
impl Rect {
    pub fn valid(&self) -> bool {
        [self.x, self.y, self.width, self.height]
            .iter()
            .all(|n| n.is_finite())
            && self.width > 0.0
            && self.height > 0.0
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Operation {
    Click,
    DoubleClick,
    TypeText,
    ScrollUp,
    ScrollDown,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Control {
    pub id: String,
    pub role: String,
    pub label: String,
    pub value: String,
    pub enabled: bool,
    pub selected: bool,
    pub actions: Vec<Operation>,
    pub bounds: Rect,
}
impl Control {
    pub fn button(id: impl Into<String>, label: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            role: "button".into(),
            value: String::new(),
            enabled: true,
            selected: false,
            actions: vec![Operation::Click],
            bounds: Rect {
                x: 0.,
                y: 0.,
                width: 0.,
                height: 0.,
            },
        }
    }
}

/// Only observed, user-visible facts should be sent to a model. Test oracles stay in the host.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Surface {
    pub title: String,
    pub ready: bool,
    pub controls: Vec<Control>,
    pub facts: BTreeMap<String, serde_json::Value>,
}
impl Surface {
    pub fn validate(&self) -> Result<(), Error> {
        if self.controls.len() > MAX_CONTROLS {
            return Err(Error::InvalidSurface);
        }
        let mut ids = std::collections::BTreeSet::new();
        for node in &self.controls {
            if node.id.is_empty()
                || node.id.len() > 256
                || node.label.len() > 4096
                || node.value.len() > 4096
                || !node.bounds.valid()
                || !ids.insert(&node.id)
            {
                return Err(Error::InvalidSurface);
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Snapshot {
    pub protocol: u32,
    pub session: String,
    pub revision: u64,
    pub surface: Surface,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Action {
    pub revision: u64,
    pub operation: Operation,
    pub target: String,
    #[serde(default)]
    pub text: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "method", rename_all = "snake_case", deny_unknown_fields)]
pub enum Method {
    Observe,
    Act { action: Action },
    Verify { check: String },
    Close,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub protocol: u32,
    pub session: String,
    pub id: u64,
    #[serde(rename = "command")]
    pub method: Method,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Response {
    pub protocol: u32,
    pub id: u64,
    pub ok: bool,
    pub result: serde_json::Value,
    pub error: Option<String>,
}
impl Response {
    pub fn success(id: u64, result: impl Serialize) -> Self {
        match serde_json::to_value(result) {
            Ok(result) => Self {
                protocol: VERSION,
                id,
                ok: true,
                result,
                error: None,
            },
            Err(_) => Self::failure(id, "serialization_failed"),
        }
    }
    pub fn failure(id: u64, error: &str) -> Self {
        Self {
            protocol: VERSION,
            id,
            ok: false,
            result: serde_json::Value::Null,
            error: Some(error.into()),
        }
    }
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum Error {
    #[error("invalid_surface")]
    InvalidSurface,
    #[error("wrong_session_or_protocol")]
    WrongSession,
    #[error("replayed_request")]
    ReplayedRequest,
    #[error("stale_observation")]
    Stale,
    #[error("target_not_available")]
    Unavailable,
    #[error("operation_not_allowed")]
    NotAllowed,
    #[error("invalid_text")]
    InvalidText,
}

/// One window/session, one outstanding observation, consume-before-execute semantics.
/// The host MUST refresh render geometry/state before calling `admit` and execute synchronously.
pub struct Session {
    token: String,
    revision: u64,
    request_id: u64,
    offered: Option<Surface>,
}
impl Session {
    pub fn new(token: String) -> Self {
        Self {
            token,
            revision: 0,
            request_id: 0,
            offered: None,
        }
    }
    pub fn accept(&mut self, request: &Request) -> Result<(), Error> {
        if request.protocol != VERSION || request.session != self.token {
            return Err(Error::WrongSession);
        }
        if request.id <= self.request_id {
            return Err(Error::ReplayedRequest);
        }
        self.request_id = request.id;
        Ok(())
    }
    pub fn observe(&mut self, surface: Surface) -> Result<Snapshot, Error> {
        surface.validate()?;
        self.revision += 1;
        self.offered = Some(surface.clone());
        Ok(Snapshot {
            protocol: VERSION,
            session: self.token.clone(),
            revision: self.revision,
            surface,
        })
    }
    pub fn admit(&mut self, action: &Action, current: &Surface) -> Result<Control, Error> {
        let offered = self.offered.take().ok_or(Error::Stale)?;
        current.validate()?;
        if action.revision != self.revision || &offered != current {
            return Err(Error::Stale);
        }
        if !current.ready {
            return Err(Error::Unavailable);
        }
        let control = current
            .controls
            .iter()
            .find(|node| node.id == action.target)
            .ok_or(Error::Unavailable)?;
        if !control.enabled {
            return Err(Error::Unavailable);
        }
        if !control.actions.contains(&action.operation) {
            return Err(Error::NotAllowed);
        }
        match (&action.operation, &action.text) {
            (Operation::TypeText, Some(text))
                if text.len() <= 1024 && !text.chars().any(char::is_control) => {}
            (Operation::TypeText, _) | (_, Some(_)) => return Err(Error::InvalidText),
            _ => {}
        }
        Ok(control.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn surface() -> Surface {
        let mut button = Control::button("review", "Review");
        button.bounds = Rect {
            x: 10.,
            y: 20.,
            width: 100.,
            height: 26.,
        };
        Surface {
            title: "Fixture".into(),
            ready: true,
            controls: vec![button],
            facts: BTreeMap::new(),
        }
    }
    fn action(revision: u64) -> Action {
        Action {
            revision,
            operation: Operation::Click,
            target: "review".into(),
            text: None,
        }
    }
    #[test]
    fn action_is_consumed_even_when_replayed() {
        let mut session = Session::new("fixture".into());
        let snap = session.observe(surface()).unwrap();
        assert!(session.admit(&action(snap.revision), &surface()).is_ok());
        assert_eq!(
            session.admit(&action(snap.revision), &surface()),
            Err(Error::Stale)
        );
    }
    #[test]
    fn changed_label_geometry_and_facts_each_refuse() {
        for change in 0..3 {
            let mut session = Session::new("fixture".into());
            let snap = session.observe(surface()).unwrap();
            let mut current = surface();
            match change {
                0 => current.controls[0].label = "Delete".into(),
                1 => current.controls[0].bounds.x += 1.,
                _ => {
                    current.facts.insert("page".into(), "other".into());
                }
            }
            assert_eq!(
                session.admit(&action(snap.revision), &current),
                Err(Error::Stale)
            );
        }
    }
    #[test]
    fn duplicate_ids_and_nonfinite_bounds_refuse() {
        let mut current = surface();
        current.controls.push(current.controls[0].clone());
        assert_eq!(current.validate(), Err(Error::InvalidSurface));
        current.controls.pop();
        current.controls[0].bounds.x = f32::NAN;
        assert_eq!(current.validate(), Err(Error::InvalidSurface));
    }
    #[test]
    fn unavailable_and_unsupported_actions_refuse() {
        for disabled in [true, false] {
            let mut current = surface();
            current.controls[0].enabled = !disabled;
            let mut session = Session::new("fixture".into());
            let snap = session.observe(current.clone()).unwrap();
            let mut request = action(snap.revision);
            if !disabled {
                request.operation = Operation::TypeText;
            }
            assert_eq!(
                session.admit(&request, &current),
                Err(if disabled {
                    Error::Unavailable
                } else {
                    Error::NotAllowed
                })
            );
        }
    }
    #[test]
    fn text_is_bounded_and_never_an_executable_instruction() {
        for text in ["ok", "", "bad\n", "bad\0"] {
            let mut current = surface();
            current.controls[0].actions = vec![Operation::TypeText];
            let mut session = Session::new("fixture".into());
            let snap = session.observe(current.clone()).unwrap();
            let mut request = action(snap.revision);
            request.operation = Operation::TypeText;
            request.text = Some(text.into());
            assert_eq!(
                session.admit(&request, &current).is_ok(),
                !text.chars().any(char::is_control)
            );
        }
    }
    #[test]
    fn protocol_session_and_request_replay_are_checked() {
        let mut session = Session::new("fixture".into());
        let mut req = Request {
            protocol: VERSION,
            session: "wrong".into(),
            id: 1,
            method: Method::Observe,
        };
        assert_eq!(session.accept(&req), Err(Error::WrongSession));
        req.session = "fixture".into();
        assert!(session.accept(&req).is_ok());
        assert_eq!(session.accept(&req), Err(Error::ReplayedRequest));
    }
    #[test]
    fn request_wire_roundtrips_and_unknown_operations_refuse() {
        let req = Request {
            protocol: VERSION,
            session: "fixture".into(),
            id: 1,
            method: Method::Act { action: action(1) },
        };
        let wire = serde_json::to_string(&req).unwrap();
        assert!(serde_json::from_str::<Request>(&wire).is_ok());
        assert!(serde_json::from_str::<Request>(&wire.replace("click", "shell")).is_err());
    }
}
