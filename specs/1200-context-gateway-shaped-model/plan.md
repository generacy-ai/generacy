# Implementation Plan: Gateway-route validate warning + doctor llm-gateway check

**Feature**: Warn at validate time when a gateway-routed model has no gateway env; add a `generacy doctor` `llm-gateway` health check
**Branch**: `1200-context-gateway-shaped-model`
**Status**: Complete

## Summary

Two operator-facing safety nets for the LLM-gateway epic (generacy-ai/generacy#1197),
both classifying model strings through the shared `resolveRoute` helper owned by
sibling issue generacy-ai/generacy#1198:

1. **Validate warning** — `collectGatewayWarnings(config, env?)` in
   `packages/generacy/src/config/loader.ts`, called by `loadConfigWithWarnings`
   alongside `collectEffortWarnings`. For every resolved agent entry that explicitly
   sets a `model` resolving to the `gateway` route, emit one warning when
   `GENERACY_LLM_GATEWAY_URL` is unset. Warnings-only channel; exit code stays 0.
2. **Doctor check** — new `llm-gateway` `CheckDefinition` at
   `packages/generacy/src/cli/commands/doctor/checks/llm-gateway.ts`, registered in
   `createDefaultRegistry()`. Skips when the gateway URL is unset; fails fast on a
   missing token; probes `GET /v1/models` with `Authorization: Bearer`, falling back
   to a 1-token `POST /v1/messages` on 404/405.

**Hard dependency (Q1=A)**: `resolveRoute` must be shipped by #1198 in
`@generacy-ai/generacy-plugin-claude-code` before implementation starts. If the
export is absent at implement time, this issue blocks/requeues — it must NOT define
the helper or ship a local classifier. Verify with:
`grep -rn "export.*resolveRoute" packages/generacy-plugin-claude-code/src/`.

## Technical Context

- **Language/runtime**: TypeScript (ESM), Node >= 22
- **Package**: `@generacy-ai/generacy` (`packages/generacy`) — sole code-change package
- **New workspace dependency**: `packages/generacy/package.json` gains
  `"@generacy-ai/generacy-plugin-claude-code": "workspace:*"` (currently absent;
  required for the FR-011 `resolveRoute` import)
- **Test framework**: vitest, stubbed `fetch` via `vi.stubGlobal` for the doctor check,
  `vi.mock` on the plugin package for warning-matrix tests
- **resolveRoute contract (pinned from #1198's spec, corrects #1200's loose naming)**:
  `resolveRoute(model?: string): 'subscription' | 'gateway'` — returns `'gateway'`
  iff the model string contains `/`; `undefined`/no-slash → `'subscription'`.
  The #1200 spec's `anthropic` route name maps to `'subscription'`.

## Project Structure

```
packages/generacy/
├── package.json                                  # MOD: + @generacy-ai/generacy-plugin-claude-code
├── src/config/
│   ├── loader.ts                                 # MOD: + collectGatewayWarnings, wire into loadConfigWithWarnings
│   ├── schema.ts                                 # MOD: GeneracyConfigSchema + cockpit: z.unknown().optional()
│   └── __tests__/gateway-warnings.test.ts        # NEW: SC-001/SC-004 warning matrix
└── src/cli/commands/
    ├── doctor.ts                                 # MOD: register llmGatewayCheck in createDefaultRegistry()
    └── doctor/checks/
        ├── llm-gateway.ts                        # NEW: the check (mirrors anthropic-key.ts shape)
        └── __tests__/llm-gateway.test.ts         # NEW: SC-002 matrix with stubbed fetch
.changeset/1200-llm-gateway-doctor-validate.md    # NEW at implement: @generacy-ai/generacy minor
```

## Key Decisions (full rationale in research.md)

| # | Decision |
|---|----------|
| D-1 | `resolveRoute` imported from `@generacy-ai/generacy-plugin-claude-code`; contract `'subscription' \| 'gateway'`; hard block if unshipped (Q1=A). |
| D-2 | Warn only at entries that **explicitly set** `model` (mirrors `collectEffortWarnings`' `!entry?.effort` early-return). No inheritance-driven warning multiplication. |
| D-3 | `GeneracyConfigSchema` gains lenient `cockpit: z.unknown().optional()` passthrough; `collectGatewayWarnings` duck-types tolerantly into `cockpit.auto.agents.{default,clarifier,reviewer,validator,fixer,diagnoser}`. Never crashes when absent/malformed (spec Assumption). |
| D-4 | Doctor check declares `dependencies: ['config']`, NOT `['env-file']` — env-file **fails** on a missing `generacy.env` and the runner skip-propagates `fail`/`skip`, which would skip the check on exactly the compose-env clusters Q2=C protects. Env read: `context.envVars?.[K] ?? process.env[K]`. |
| D-5 | Probe: `GET <url>/v1/models`, `Authorization: Bearer <token>`; 404/405 → 1-token `POST /v1/messages` using the first gateway-routed model found in config; **no gateway-routed model available for the fallback → `warn`** (not fail). Per-request `AbortSignal.timeout(2_000)` so primary+fallback fit the runner's 5 s `services` budget. |
| D-6 | Check identity: `id: 'llm-gateway'`, `label: 'LLM Gateway'`, `category: 'services'`, `priority: 'P1'`. |
| D-7 | Warning text mirrors the effort-warning format: `` `${path}.model — set to '<model>' which resolves to the gateway route, but GENERACY_LLM_GATEWAY_URL is not set in this environment. The model will not route anywhere at spawn time.` `` |
| D-8 | Changeset: `@generacy-ai/generacy` **minor** (new doctor check + new validate warning = user-visible capability). |

## Constitution Check

No `.specify/memory/constitution.md` exists in this repo — check skipped.

## Functional Requirement → Design Mapping

| FR | Where |
|----|-------|
| FR-001 | `loadConfigWithWarnings` returns `[...collectEffortWarnings(config), ...collectGatewayWarnings(config)]` |
| FR-002 | `collectGatewayWarnings` tier-walk: `agents.default`, `workflows.<wf>.default`, `workflows.<wf>.phases.<p>`, plus cockpit duck-walk (D-3) |
| FR-003 | Warn iff `resolveRoute(entry.model) === 'gateway' && !env.GENERACY_LLM_GATEWAY_URL` (env param defaults `process.env`, injectable for tests) |
| FR-004 | Warning names exact config path + model (D-7) |
| FR-005 | No new error path; warnings channel already exits 0 |
| FR-006 | `llmGatewayCheck` registered in `createDefaultRegistry()` after `agencyMcpCheck` (Service category) |
| FR-007 | URL unset (envVars-then-process.env read) → `{ status: 'skip' }` |
| FR-008 | Primary `GET /v1/models`; 404/405 → `POST /v1/messages` `{ model, max_tokens: 1, messages: [{role:'user',content:'ping'}] }` |
| FR-009 | 200 on `/v1/models` → parse `data[].id` best-effort into `detail` |
| FR-010 | 401 → fail (token suggestion); other non-200 → fail (`HTTP <status>` in detail); network/timeout → fail (reachability suggestion + error message in detail) |
| FR-011 | Both consumers `import { resolveRoute } from '@generacy-ai/generacy-plugin-claude-code'` |
| FR-012 | URL set + token missing/empty → fail with token suggestion, **before** any fetch |

## Test Plan (Success Criteria)

- **SC-001/SC-004** — `gateway-warnings.test.ts`: gateway model + no URL → 1 warning
  with exact path; gateway model + URL set → silent; subscription-route model →
  silent regardless of env; all four tiers covered incl. `cockpit.auto.agents.*`;
  malformed/absent cockpit block → no crash, no warning.
- **SC-002** — `llm-gateway.test.ts` with `vi.stubGlobal('fetch', ...)`: URL unset →
  skip; URL set + token missing → fail without fetch (assert fetch not called);
  200 → pass (+ model list in detail); 401 → fail token; 404 on `/v1/models` →
  asserts `POST /v1/messages` issued, maps its response per FR-010; ECONNREFUSED →
  fail reachability; envVars-vs-process.env precedence.
- **SC-003** — `pnpm -r build` + package tests green.

## Risks / Open Items

- **#1198 not merged** (specify+clarify only, non-develop branch as of 2026-08-26):
  implementation blocks per Q1=A. This plan is written against #1198's pinned FR-001
  contract; if that contract shifts (route names or signature), revisit D-1 only —
  everything else is contract-agnostic.
- **Tier-concurrency caveat (D-4)**: with `dependencies: ['config']` the check shares
  a tier with `env-file`, whose `data` merge lands a microtask after same-tier checks
  begin — so `context.envVars` is typically still `null` and `process.env` dominates
  in practice. The `envVars ?? process.env` read still implements Q2=C's letter and
  behaves correctly under `--check llm-gateway` (env-file excluded). Accepted;
  alternative (`dependencies: ['env-file']`) is explicitly rejected by Q2=C.

---
Part of epic generacy-ai/generacy#1197. Generated by speckit.
