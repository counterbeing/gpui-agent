# Swamp adapter pre-test review

This is a **model factory example** distributed as GitHub source, not an installed Swamp extension or a Swamp registry review approval. `swamp model type search gpui` and `swamp extension search gpui --content-type models --json` returned no matches. Selection of a model method follows the Swamp architecture guide's single external-action rule (`design/models.md` reference); workflow orchestration remains with Swamp.

Mechanical checks (source inspection before tests):
- Schema/write conformance: PASS. The sole `writeResource("result", "review", result)` receives `Report.parse(...)`; the resource uses that exact strict envelope. Optional report fields correspond to runner success/error paths. No fabricated placeholders.
- Truncation honesty: PASS. Oversized output refuses; it is never truncated into a successful resource.
- Instance names: PASS. One method, one result shape, versioned `review` instance.
- Schema field coverage: PASS. Envelope fields map to runner reports; nested verification/metadata are intentionally host-defined JSON records.

Universal/model review:
- Credentials: PASS. No key parameter, embedded key, logging, or resource field. Runner reads explicit local env/file; native child receives a credential-free environment.
- Logging: PASS. Entry/outcome only, no UI state, command arguments or secrets.
- Errors: PASS. Configuration/parse/protocol errors throw before writes. A completed unsuccessful review is intentionally stored with `passed=false`; workflows must assert this field.
- Resilience: PASS. Fresh sessions; no implicit retry, model fallback, or repeated billing. Separate invocations intentionally create new runs, not idempotent reuse.
- API contract: PASS. Literal argv and version-1 report, no shell interpolation. HTTP remains in the separately tested Python policy.
- Resources: PASS. Bounded stdout, 190-second watchdog, only its child is terminated; the native server independently expires at 180 seconds/512 commands.
- Schema/lifetime/preflight: PASS. Typed configuration, explicit cloud approval, required session placeholder, fixed resource schema, retained results. The **operator** must configure a fixture-only app entry point; this example does not certify an arbitrary app's confinement.
- CRUD/version migration: N/A. One-shot review, initial version; no remote resources to create/delete.
- Tests: pure argv/report/factory cases are in `swamp_test.ts`; no live app/model call from tests. Runtime registration in the user's Swamp workspace is not claimed.

Speed-options review (before the added tests): optional `decisionMode` is an enum, `keepalive` a boolean and `settleMs` a bounded number. All remain literal argv, not shell/code. The strict report adds only policy configuration and numeric phase timings; no credential field or resource write bypass. HTTP reuse is fixed-origin HTTPS, rejects redirects, closes on failure without retry, and refuses rather than bypassing a configured HTTPS proxy. Zero settle never bypasses native scene admission or independent verification. Existing callers retain fan-out/80 ms defaults. These options do not grant a new aggregate spending allowance. Pure argv/report cases cover the new fields; no live Swamp workspace registration is claimed.

Publishing to the Swamp registry requires choosing the user's collective, a manifest, registry review and explicit release approval. None is performed here; GitHub source publication does not perform Swamp registration.
