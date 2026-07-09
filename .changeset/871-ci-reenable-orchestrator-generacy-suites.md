---
"@generacy-ai/orchestrator": patch
---

Re-enable the orchestrator and generacy test suites in CI and add a dedicated integration job, surfacing tests that were silently excluded (#871).

CI's `Test (packages)` step previously filtered out `@generacy-ai/orchestrator` and `@generacy-ai/generacy`, hiding their failures on develop. The filter is removed so both suites run, a new `integration` job runs `test:integration` across packages against a Redis service, and the launcher classes (`AgentLauncher`, `GenericSubprocessPlugin`) are now exported as runtime values from `@generacy-ai/orchestrator` (previously type-only) so cross-package spawn-snapshot parity tests can construct them. The red tests this exposed are fixed: the `health-code-server` test now passes config via the `{ config }` options shape, the `relay-bridge` metadata test mocks `node:fs/promises` so `collectMetadata()` is deterministic under fake timers, and the `setup workspace` no-config test mocks `readdirSync` so the workspace scan reaches the intended `exit(1)`.
