# Contributing

Start with the [README](README.md) setup and deterministic test commands. Keep changes small and include tests for protocol, policy, configuration, or lifecycle behavior you change.

## Safety and evidence

- Automatic tests use synthetic fixtures and mocked model transport. Never require real credentials, a native window, private sources, or OS permission prompts.
- Native GUI verification is explicit and separate. Use fresh owned fixture processes; preserve unrelated windows/data. Any mutating host needs independently enforced disposable-fixture containment, not just a test flag or temporary path.
- Do not replace an independent check with a model judgment. Distinguish `completed_unverified`, `passed`, and visual inspection.
- Do not add implicit model retries, unbounded billing, logging of keys, or credentials in native-child environments.
- Treat filenames/UI labels as untrusted observations, not instructions. Keep stale/replay/session checks on every input path.
- Reports/traces can contain private UI data. Share minimal synthetic reproductions, never credentials or unreviewed runtime artifacts.

## Development

Rust is pinned in `rust-toolchain.toml`. Use pnpm for TypeScript; keep `typescript/pnpm-lock.yaml` in sync. Python's runner uses only the standard library. Deno is needed only for the optional Swamp factory tests.

The native-tree feature must be built with the matched patched GPUI dependency. It is deliberately not silently enabled in ordinary builds. `vendor/`, build outputs, local launch profiles, and run artifacts stay outside Git. The root Cargo lockfile is local: this is an experimental library checkout with a command-line-selected path patch, not a reproducible binary distribution.

CI runs only non-GUI Rust/Python/TypeScript checks. Passing CI does not prove native rendering, cross-platform runtime, or model accuracy. Note separately which native checks you actually ran and which remain unverified.

## Distribution

GitHub is the current source distribution. Cargo `publish = false` and the TypeScript package's `private: true` intentionally prevent accidental registry publication. npm/PyPI/crates.io and Swamp registry releases need their own packaging review. Do not copy surrounding File-Bro app code, assets, configuration, or data into this standalone project.
