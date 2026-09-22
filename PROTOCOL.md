# GPUI Agent protocol v1

UTF-8 newline-delimited JSON over inherited stdin/stdout. One request outstanding at a time. No listener, global app discovery, shell expressions, arbitrary selectors or model-supplied coordinates. Host logs belong on stderr. The launching controller owns the dedicated fixture process and supplies a fresh session token. This is **not authentication for a remotely exposed service**; do not put the bridge on an unauthenticated socket.

## Envelope

```json
{"protocol":1,"session":"32-hex-fixture-token","id":1,"command":{"method":"observe"}}
```

`id` is a strictly increasing positive integer; every request (including verification/close) carries the exact session. Unknown request fields/operations are refused by the Rust decoder. Malformed, unterminated or >65,536-byte request lines close the connection. A normal response is:

```json
{"protocol":1,"id":1,"ok":true,"result":{},"error":null}
```

Errors use `ok:false`, `result:null` and a stable error string. The client refuses wrong version/request IDs, malformed snapshots, non-finite bounds, ambiguous IDs, and oversized (>1 MiB) response lines. EOF terminates the owned session; it does not authorize replay.

## Observe

`result` contains `{protocol, session, revision, surface}`. `surface` contains:

- `title`: app/window context.
- `ready`: whether interactions may be considered.
- `facts`: observed UI context, no secret/test-oracle instructions. The shared bridge uses `accessibility_content` from GPUI's native tree.
- `controls`: at most 512 rendered controls, each with:
  - `id`, `role`, `label`, `value` strings;
  - `enabled`, `selected` booleans;
  - `actions`: a subset of `click`, `double_click`, `type_text`, `scroll_up`, `scroll_down`;
  - `bounds`: finite positive-sized `{x,y,width,height}` in GPUI logical pixels.

A snapshot revision is issued by the server, not selected by the caller. The shared bridge uses `ax-<native-node-id>` identities, independent of ephemeral model answer indices. Only current discovered controls/actions are offered to the model; discovery is not an app-specific authority allowlist. Geometry stays in the local executor; the Jev policy omits it from requests.

## Act

```json
{
  "protocol":1,"session":"32-hex-fixture-token","id":2,
  "command":{"method":"act","action":{
    "revision":1,"operation":"click","target":"ax-123"
  }}
}
```

Text replacement adds `"text":"exact replacement"` to the action. It is required only for `type_text`, bounded to 1,024 UTF-8 bytes, and cannot contain control characters. GPUI's native SetValue action calls the actual input component handler. Scroll is a fixed ±240 logical-pixel vertical wheel event at the observed region's clipped center, offered on native scroll-action nodes and semantic rows/list items. It can bubble to an ancestor or be a no-op. Double-click sends native GPUI down/up pairs with click counts 1 and 2. No keyboard shortcuts, uploads, clipboard, window switching, arbitrary text generation or backend commands are implicit in v1.

The server freshly renders the window, compares its current native-tree surface to the one offered, checks session/request/revision/target/enablement/action compatibility, and consumes the observation **before** executing. Changes to observed semantics/geometry refuse with `stale_observation`; callers must observe and decide again. A response `{"executed":true}` means input was dispatched, not that the business outcome succeeded. Input acknowledgements are never automatically replayed after an uncertain transport failure.

Hidden/password subtrees and unavailable geometry are excluded, disabled ancestry is inherited, and read-only fields cannot be edited. Native semantics must truthfully describe the app; clipping is not complete occlusion detection. The host's fixture/admission boundary remains essential—this protocol is not an OS sandbox.

## Verify

```json
{"protocol":1,"session":"32-hex-fixture-token","id":3,"command":{"method":"verify","check":"count-two"}}
```

Checks are optional in the shared bridge (`serve` versus `serve_with_checks`) and the TypeScript/pi free-form runner. The Python CLI and Swamp wrapper require a check in their task file. Host-owned checks return at least `{ "passed": true|false }`, with optional evidence. Unknown checks must never pass. Checks cannot be executable assertions supplied by the model, nor may the model replace the verifier. The check name comes from the operator's task file or tool call, not from a Jev answer.

File-Bro implements `review-f1` and `search-inspect-review`; the latter retains observed milestones across steps. Its separate `window-info` check reports only this process's visible window IDs and never returns `passed:true`. It exists for optional already-authorized native evidence capture, not task completion.

## Close and independent limits

```json
{"protocol":1,"session":"32-hex-fixture-token","id":4,"command":{"method":"close"}}
```

The server acknowledges and closes the **dedicated test process**. Never attach this implementation to an existing interactive process. A native 180-second/512-command watchdog also applies. The external runner has separate time/step/model-request budgets; a late model decision is not applied. All artifacts are retained.

## Python runner report v1

The TypeScript/pi runner has a separate compact report with `completed`, optional-check outcomes, and `visual_verification: "unavailable"`; see [its guide](typescript/README.md). The native wire protocol above is shared by both runners.

For the Python CLI, `stdout` is one JSON object with `protocol`, `status`, `passed`, `steps`, `model_requests`, independent `verification`, `elapsed_ms`, `model_ms`, token `usage`, `engine`, requested `model`, `resolved_models`, `session`, `artifacts`, `goal`, and `limits`. Host `metadata` and an optional native `checkpoint` may be included. `timings_ms` records observe/verify/decide/act/sleep phases; `policy` records `decision_mode` and `keepalive`; `limits.settle_ms` records the bounded input delay. Trace events include `elapsed_ms`. Optional complete-action Choice maps a selected local key to a fully bound allowed action, without changing native admission. These are additive runner fields, not a new native wire method. Setup errors have the smaller `{protocol,status:"error",passed:false,error}` envelope.

Statuses include `passed`, `blocked`, `verification_failed`, `budget_exceeded`, `error`. Never treat model `done`, exit of an individual action, confidence, or a recorded report as success without `passed:true`. API error responses and credentials are never logged. Transcripts remain local; live policies send only explicit task/observation/action-history state.
