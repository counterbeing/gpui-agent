//! Opt-in, in-process development access to the existing AccessKit tree.
//! No sockets, OS accessibility activation, global input or application callbacks.
use super::*;

impl Window {
    /// Build the normal accessibility tree locally, without activating assistive technology.
    /// Only an explicitly opted-in development window should call this method.
    pub fn enable_local_automation(&mut self) -> Result<(), &'static str> {
        if !self.a11y.enable_local_automation() {
            return Err("accessibility_disabled_for_window");
        }
        self.refresh();
        Ok(())
    }

    /// The actual last rendered tree, not an application-maintained control registry.
    pub fn local_automation_tree(&self) -> Option<&accesskit::TreeUpdate> {
        self.a11y.local_automation_tree()
    }

    /// Current content-mask-clipped, logical-pixel bounds of a real accessible element.
    pub fn local_automation_bounds(&self, id: accesskit::NodeId) -> Option<Bounds<Pixels>> {
        self.a11y.automation_bounds.get(&id).copied()
    }

    /// Dispatch a supported accessibility action through the normal GPUI/AccessKit handlers.
    /// The external bridge must additionally bind this call to its current snapshot/revision.
    #[cfg(not(target_family = "wasm"))]
    pub fn dispatch_local_automation_action(
        &mut self,
        request: accesskit::ActionRequest,
        cx: &mut App,
    ) -> Result<(), &'static str> {
        let tree = self
            .local_automation_tree()
            .ok_or("automation_not_enabled")?;
        let node = tree
            .nodes
            .iter()
            .find(|(id, _)| *id == request.target_node)
            .map(|(_, node)| node)
            .ok_or("target_not_available")?;
        if node.is_disabled() || node.is_hidden() || !node.supports_action(request.action) {
            return Err("operation_not_allowed");
        }
        match (&request.action, &request.data) {
            (accesskit::Action::Click, None) => {}
            (accesskit::Action::SetValue, Some(accesskit::ActionData::Value(text)))
                if !node.is_read_only()
                    && node.role() != accesskit::Role::PasswordInput
                    && text.len() <= 1024
                    && !text.chars().any(char::is_control) => {}
            _ => return Err("operation_not_allowed"),
        }
        let bounds = self
            .local_automation_bounds(request.target_node)
            .ok_or("target_not_available")?;
        if bounds.size.width <= px(0.) || bounds.size.height <= px(0.) {
            return Err("target_not_available");
        }
        // Reuse native action handling at visible geometry without modifying GPUI's bounds.
        self.handle_a11y_action_at(request, Some(bounds.center()), cx);
        Ok(())
    }
}
