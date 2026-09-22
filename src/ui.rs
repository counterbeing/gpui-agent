//! Shared GPUI accessibility-tree bridge. No per-control probes or application input adapters.
//! Requires the pinned additive GPUI patch; see `prepare-native-tree.py`.
mod server;
pub use server::{serve, serve_with_checks};

use crate::{Control, Operation, Rect, Surface};
use gpui::accesskit::{Action, ActionData, ActionRequest, NodeId, Role, TreeId, TreeUpdate};
use gpui::{
    App, InputEvent, MouseDownEvent, MouseMoveEvent, MouseUpEvent, ScrollDelta, ScrollWheelEvent,
    Window, point, px,
};
use std::collections::{BTreeMap, BTreeSet};

/// Convert the real GPUI tree. The bounds resolver uses GPUI's rendered content masks.
pub fn tree_surface(
    tree: &TreeUpdate,
    mut bounds: impl FnMut(NodeId) -> Option<Rect>,
) -> Result<Surface, &'static str> {
    if tree.nodes.len() > 10_000 {
        return Err("accessibility_tree_too_large");
    }
    let nodes: BTreeMap<_, _> = tree.nodes.iter().map(|(id, node)| (*id, node)).collect();
    if nodes.len() != tree.nodes.len() {
        return Err("duplicate_accessibility_node");
    }
    let mut excluded = BTreeSet::new();
    let mut disabled = BTreeSet::new();
    for (id, node) in &tree.nodes {
        if node.is_hidden() || node.role() == Role::PasswordInput {
            descendants(*id, &nodes, &mut excluded);
        }
        if node.is_disabled() {
            descendants(*id, &nodes, &mut disabled);
        }
    }
    let mut controls = Vec::new();
    let mut content = Vec::new();
    for (id, node) in &tree.nodes {
        if excluded.contains(id) {
            continue;
        }
        let label = node
            .label()
            .or_else(|| node.placeholder())
            .unwrap_or_default();
        let value = node.value().unwrap_or_default();
        if label.len() > 4096 || value.len() > 4096 {
            return Err("accessibility_text_too_large");
        }
        let role = format!("{:?}", node.role());
        let visible = bounds(*id).filter(Rect::valid);
        if visible.is_none() {
            continue;
        }
        if !label.is_empty() || !value.is_empty() {
            content.push(
                serde_json::json!({"role": role, "label": label, "value": value,
                "selected": node.is_selected(), "disabled": disabled.contains(id)}),
            );
        }
        let mut actions = Vec::new();
        if node.supports_action(Action::Click) {
            actions.extend([Operation::Click, Operation::DoubleClick]);
        }
        if node.supports_action(Action::SetValue) && !node.is_read_only() {
            actions.push(Operation::TypeText);
        }
        // A wheel gesture over a semantic content row bubbles through GPUI's real
        // scroll ancestors. It need not be an AccessKit ScrollUp/Down action.
        let wheel_target = matches!(node.role(), Role::ListItem | Role::Row);
        if wheel_target || node.supports_action(Action::ScrollUp) {
            actions.push(Operation::ScrollUp);
        }
        if wheel_target || node.supports_action(Action::ScrollDown) {
            actions.push(Operation::ScrollDown);
        }
        if !actions.is_empty() {
            controls.push(Control {
                id: format!("ax-{}", id.0),
                role,
                label: label.into(),
                value: value.into(),
                enabled: !disabled.contains(id),
                selected: node.is_selected().unwrap_or(false),
                actions,
                bounds: visible.ok_or("missing_bounds")?,
            });
        }
    }
    let surface = Surface {
        title: tree
            .tree
            .as_ref()
            .and_then(|tree| nodes.get(&tree.root))
            .and_then(|node| node.label())
            .unwrap_or("GPUI window")
            .into(),
        ready: !tree.nodes.is_empty(),
        controls,
        facts: BTreeMap::from([("accessibility_content".into(), content.into())]),
    };
    surface
        .validate()
        .map_err(|_| "invalid_accessibility_surface")?;
    Ok(surface)
}

fn descendants(
    id: NodeId,
    nodes: &BTreeMap<NodeId, &gpui::accesskit::Node>,
    result: &mut BTreeSet<NodeId>,
) {
    let mut pending = vec![id];
    while let Some(id) = pending.pop() {
        if result.insert(id)
            && let Some(node) = nodes.get(&id)
        {
            pending.extend(node.children());
        }
    }
}

pub(crate) fn surface(window: &Window) -> Result<Surface, &'static str> {
    let tree = window
        .local_automation_tree()
        .ok_or("accessibility_tree_not_ready")?;
    tree_surface(tree, |id| {
        window.local_automation_bounds(id).map(|bounds| Rect {
            x: bounds.origin.x.into(),
            y: bounds.origin.y.into(),
            width: bounds.size.width.into(),
            height: bounds.size.height.into(),
        })
    })
}

/// Native accessibility handlers perform ordinary clicks and text replacement. Double-clicks
/// and wheel events use the same window-local GPUI input path, with native discovered geometry.
pub(crate) fn dispatch(
    control: &Control,
    operation: Operation,
    text: Option<&str>,
    window: &mut Window,
    cx: &mut App,
) -> Result<(), &'static str> {
    let id = control
        .id
        .strip_prefix("ax-")
        .and_then(|id| id.parse::<u64>().ok())
        .map(NodeId)
        .ok_or("invalid_accessibility_target")?;
    if matches!(operation, Operation::Click | Operation::TypeText) {
        return window.dispatch_local_automation_action(
            ActionRequest {
                target_tree: TreeId::ROOT,
                target_node: id,
                action: if operation == Operation::Click {
                    Action::Click
                } else {
                    Action::SetValue
                },
                data: text.map(|text| ActionData::Value(text.into())),
            },
            cx,
        );
    }
    let b = &control.bounds;
    let position = point(px(b.x + b.width / 2.), px(b.y + b.height / 2.));
    window.dispatch_event(
        MouseMoveEvent {
            position,
            ..Default::default()
        }
        .to_platform_input(),
        cx,
    );
    match operation {
        Operation::DoubleClick => {
            for click_count in 1..=2 {
                window.dispatch_event(
                    MouseDownEvent {
                        position,
                        click_count,
                        ..Default::default()
                    }
                    .to_platform_input(),
                    cx,
                );
                window.dispatch_event(
                    MouseUpEvent {
                        position,
                        click_count,
                        ..Default::default()
                    }
                    .to_platform_input(),
                    cx,
                );
            }
        }
        Operation::ScrollUp | Operation::ScrollDown => {
            window.dispatch_event(
                ScrollWheelEvent {
                    position,
                    delta: ScrollDelta::Pixels(point(
                        px(0.),
                        px(if operation == Operation::ScrollDown {
                            -240.
                        } else {
                            240.
                        }),
                    )),
                    ..Default::default()
                }
                .to_platform_input(),
                cx,
            );
        }
        _ => return Err("operation_not_allowed"),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::accesskit::{Node, Tree};
    fn tree(nodes: Vec<(NodeId, Node)>) -> TreeUpdate {
        TreeUpdate {
            nodes,
            tree: Some(Tree::new(NodeId(1))),
            tree_id: TreeId::ROOT,
            focus: NodeId(1),
        }
    }
    fn bounds(_: NodeId) -> Option<Rect> {
        Some(Rect {
            x: 0.,
            y: 0.,
            width: 40.,
            height: 20.,
        })
    }
    fn button() -> Node {
        let mut node = Node::new(Role::Button);
        node.set_label("Increment");
        node.add_action(Action::Click);
        node
    }
    #[test]
    fn native_roles_labels_and_actions_are_discovered_without_a_registry() {
        let surface = tree_surface(&tree(vec![(NodeId(1), button())]), bounds).unwrap();
        assert_eq!(surface.controls[0].label, "Increment");
        assert_eq!(
            surface.controls[0].actions,
            [Operation::Click, Operation::DoubleClick]
        );
    }
    #[test]
    fn hidden_ancestor_and_password_subtrees_never_enter_observations() {
        for password in [false, true] {
            let mut parent = Node::new(if password {
                Role::PasswordInput
            } else {
                Role::GenericContainer
            });
            if !password {
                parent.set_hidden();
            }
            parent.set_children(vec![NodeId(2)]);
            let mut secret = button();
            secret.set_label("private-value");
            let surface = tree_surface(
                &tree(vec![(NodeId(1), parent), (NodeId(2), secret)]),
                bounds,
            )
            .unwrap();
            assert!(
                !serde_json::to_string(&surface)
                    .unwrap()
                    .contains("private-value")
            );
        }
    }
    #[test]
    fn disabled_ancestor_disables_descendant_actions() {
        let mut parent = Node::new(Role::GenericContainer);
        parent.set_disabled();
        parent.set_children(vec![NodeId(2)]);
        let surface = tree_surface(
            &tree(vec![(NodeId(1), parent), (NodeId(2), button())]),
            bounds,
        )
        .unwrap();
        assert!(!surface.controls[0].enabled);
    }
    #[test]
    fn absent_or_clipped_geometry_is_not_actionable() {
        let surface = tree_surface(&tree(vec![(NodeId(1), button())]), |_| None).unwrap();
        assert!(surface.controls.is_empty());
    }
    #[test]
    fn read_only_input_does_not_offer_set_value() {
        let mut node = Node::new(Role::TextInput);
        node.add_action(Action::SetValue);
        node.set_read_only();
        assert!(
            tree_surface(&tree(vec![(NodeId(1), node)]), bounds)
                .unwrap()
                .controls
                .is_empty()
        );
    }
    #[test]
    fn semantic_rows_offer_window_local_wheel_input_without_probes() {
        let mut row = Node::new(Role::ListItem);
        row.set_label("A file");
        let result = tree_surface(&tree(vec![(NodeId(1), row)]), bounds).unwrap();
        assert_eq!(
            result.controls[0].actions,
            vec![Operation::ScrollUp, Operation::ScrollDown]
        );
    }

    #[test]
    fn duplicate_node_identity_refuses() {
        assert!(
            tree_surface(
                &tree(vec![(NodeId(1), button()), (NodeId(1), button())]),
                bounds
            )
            .is_err()
        );
    }
}
