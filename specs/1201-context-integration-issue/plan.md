# Implementation Plan: P1 route plumbing end-to-end verification

**Feature**: Integration/golden/phase-loop tests + docs note closing P1 of the LLM gateway model routing epic (generacy-ai/generacy#1197)
**Branch**: `1201-context-integration-issue`
**Status**: Complete

## Summary

#1201 ships **no new mechanism**. It proves the P1 stack (#1198 route resolution +
`CLAUDE_CONFIG_DIR` launch env, #1199 route-aware session invalidation +
`agent.route.transition` log, #1200 validate/doctor surfaces) works end-to-end, and — the
load-bearing guarantee — that subscription-only clusters are **byte-for-byte unchanged**.
Deliverables: one launcher-level integration test, one golden byte-identity test with a
checked-in fixture, one phase-loop route-transition test, one committed `--settings`
source-grep guard, one docs note, one changeset.

**⚠ Dependency gate (clarification Q3=A)**: none of the sibling contracts exist on this
branch today — `grep -rn "resolveRoute\|GatewayRouteUnavailableError\|agent.route.transition"
packages/` returns zero production hits. The implement phase MUST dependency-block (skip and
requeue) until #1198, #1199, and #1200 are merged to `develop` and this branch is rebased on
them (matches the #1127 precedent). This plan pins *behavior + seams*; exact API bindings for
#1199's session-drop hook are resolved at implement time against merged code.

## Technical Context

- **Language/runtime**: TypeScript, Node >= 20/22, ESM, pnpm monorepo
- **Test framework**: Vitest (both packages already configured)
- **Packages touched**:
  - `packages/orchestrator` — test files only (launcher `__tests__/`, worker `__tests__/`)
  - `packages/generacy-plugin-claude-code` — covered by the guard scan; no source change expected
  - `docs/` — Docusaurus (outside `pnpm-workspace.yaml`; `onBrokenLinks: 'throw'`)
- **Key existing seams (verified this session)**:
  - `AgentLauncher.launch` (`packages/orchestrator/src/launcher/agent-launcher.ts:69-190`):
    injectable `ProcessFactory` map keyed by stdio profile; final `{command, args, env}` is
    observable by spying `factory.spawn` (`:159-166`). Env merge at `:105-114` spreads
    `process.env` ← `launchSpec.env` ← `request.env` — **`process.env` is hardcoded**, so
    determinism (Q2=A) is achieved by stubbing `process.env` in the test, not via a seam.
  - Credentials interceptor (`packages/orchestrator/src/launcher/credentials-interceptor.ts`):
    `wrapCommand()` at `:36-47` builds `{ command: 'sh', args: ['-c', '. "$GENERACY_SESSION_DIR/env" && exec "$@"', '_', command, ...args] }`;
    `applyCredentials()` merges session env at `:77` (`{ ...env, ...sessionEnv }`) — the
    wrapper never strips inherited env; env reaches `factory.spawn` unchanged.
  - Launch builders (`packages/generacy-plugin-claude-code/src/launch/claude-code-launch-plugin.ts`):
    `buildPhaseLaunch` (:134), `buildPrFeedbackLaunch` (:164), `buildMergeConflictLaunch`
    (:189), `buildReviewLaunch` (:217), `buildRemediateLaunch` (:247),
    `buildConversationTurnLaunch` (:284, `stdioProfile: 'interactive'`, python3 PTY wrapper).
    Today no builder sets `env` (implicitly `undefined`) — #1198 adds the gateway env here.
  - Test precedents: `multi-provider.test.ts` (direct `new AgentLauncher(new Map([...]))` +
    mock factory), `source-grep.test.ts` (readFileSync + `.includes()` negative assertions),
    `spawn-e2e.test.ts` (real-process spawn precedent for the FR-003 wrapper proof).
  - Phase-loop session state: `currentSessionId` local at `phase-loop.ts:331`, captured from
    `result.sessionId`, threaded via `CliSpawnOptions.resumeSessionId` →
    `buildPhaseLaunch` `--resume`. No generic drop helper exists yet — #1199 adds it.

## Contracts Under Test (shipped by siblings, asserted here)

| Contract | Owner | Assertion in #1201 |
|---|---|---|
| `resolveRoute(model)`: `gateway` iff resolved model contains `/`; `undefined` + `claude-*`/aliases → `subscription` | #1198 | consumed via the plugin's public export (dependency direction: orchestrator → plugin) |
| Gateway launches set `CLAUDE_CONFIG_DIR=<gatewayConfigDir>` (default `/home/node/.claude-gateway`, env override `GENERACY_CLAUDE_GATEWAY_CONFIG_DIR`); subscription launches set nothing | #1198 | US1 launcher test (FR-001/002/003) |
| `GatewayRouteUnavailableError` on gateway route without gateway config | #1198 | launcher test negative case |
| Route-aware session invalidation on subscription⇄gateway crossings + `agent.route.transition` log keyed on `(provider, route)` | #1199 | US3 phase-loop test (FR-006/007) |
| `generacy validate` gateway warning + `generacy doctor` `llm-gateway` check | #1200 | out of direct test scope here (shipped with own tests in #1200); not re-asserted |

## Project Structure (files added/modified)

```
packages/orchestrator/src/launcher/__tests__/
  route-launch-env.test.ts                  NEW  US1/FR-001..003: gateway vs subscription env
  golden-subscription-spawns.test.ts        NEW  US2/FR-004..005: byte-identity vs fixture
  no-settings-flag.test.ts                  NEW  FR-009: --settings source-grep guard
  fixtures/subscription-baseline.json       NEW  golden fixture (captured at pre-P1 merge-base)
  fixtures/README.md                        NEW  provenance SHA + regeneration procedure
packages/orchestrator/src/worker/__tests__/
  phase-loop.route-transition.test.ts       NEW  US3/FR-006..007: 2 drops + log lines
docs/docs/getting-started/configuration.md  MOD  US4/FR-008: "Model routing" note
.changeset/1201-p1-route-verification.md    NEW  FR-011 (see Changeset section)
```

No production source changes are planned. If the golden or launcher test uncovers a genuine
untestable seam, a ≤ small surgical fix may land with a linking comment (mirrors the #1024
seam-fix budget); anything larger is a follow-up.

## Design Decisions

- **D-1 — Golden test sits at the launcher level, not the builder level.** The real
  `ClaudeCodeLaunchPlugin` + real credentials interceptor + spy `ProcessFactory` compose so
  the fixture covers the full pipeline (builder args, 3-layer env merge, `sh -c` wrapper).
  Both stdio profiles (`default`, `interactive`) get spy factories so `conversation-turn` is
  covered. Six spawn kinds exactly: phase, pr-feedback, merge-conflict, review, remediate,
  conversation-turn (`invoke` is deliberately excluded — spec enumerates six).
- **D-2 — Determinism per Q2=A**: the test saves and replaces `process.env` wholesale with a
  fixed minimal map in `beforeEach` (restores in `afterEach`), injects a stub
  `CredhelperClient` returning a fixed session (`sessionDir: '/fixed/session'`, fixed env),
  fixed `cwd`. The complete `{command, args, env}` triple is then deterministic by
  construction and compared byte-for-byte (`JSON.stringify` with sorted keys vs fixture).
- **D-3 — Fixture provenance per Q1=C**: captured once from the pre-P1 merge-base commit
  (the `develop` commit immediately before #1198's merge) via a capture harness run in a git
  worktree; the SHA is recorded in `fixtures/README.md`. Thereafter the fixture is a
  forward-stability pin; regeneration = `GOLDEN_UPDATE=1 vitest run golden` + PR-description
  justification. Full procedure in `research.md § Decision 2` and `quickstart.md`.
- **D-4 — FR-003 wrapper proof is a real spawn**, not arg-shape inspection alone: spawn
  actual `sh -c '. "$GENERACY_SESSION_DIR/env" && exec "$@"' _ /usr/bin/env` with a temp
  session-dir env file and `CLAUDE_CONFIG_DIR` in the parent env; assert stdout contains the
  var (spawn-e2e.test.ts precedent). Guards the "wrapper must not strip inherited env"
  requirement against shell semantics, not our mental model of them.
- **D-5 — `--settings` guard scope per Q4=A**: recursive `readdirSync` walk of
  `packages/orchestrator/src/launcher/**` and
  `packages/generacy-plugin-claude-code/src/launch/**`, non-test `.ts` sources only
  (excludes `__tests__/`/`*.test.ts` — the guard file itself contains the literal), asserting
  zero `--settings` occurrences. Committed permanent guard, source-grep.test.ts precedent.
- **D-6 — Phase-loop test binding deferred**: #1199's exact hook (where the route comparison
  lives, the log call shape) is unknowable pre-merge. The test contract is pinned as
  *behavior*: three-phase sequence whose resolved per-phase agents alternate
  subscription → gateway → subscription ⇒ exactly 2 session drops (session NOT passed as
  `resumeSessionId` across the crossing) + one `agent.route.transition` log line per
  crossing, observed via the injected recording logger. Bind to the merged API at implement.
- **D-7 — Docs link per Q5=A**: link to the epic (generacy-ai/generacy#1197) and the P2
  issue (generacy#1203). External GitHub URLs are not checked by Docusaurus
  `onBrokenLinks: 'throw'`, so the build stays green; swap for a docs link when P2 ships.

## Changeset (FR-011)

The expected diff is tests + fixtures + docs only — the changeset gate's test-only exemption
would skip it, but FR-011 requires a changeset regardless. Add
`.changeset/1201-p1-route-verification.md` as an **empty changeset** (`pnpm changeset --empty`)
unless a seam fix under `packages/*/src/` lands, in which case bump that package **patch**.

## Constitution Check

No `.specify/memory/constitution.md` exists in this repo → constitution check skipped.

## Risks

- **Sibling API drift**: #1198/#1199 are open; their final shapes may differ from the epic
  design. Mitigated by Q3=A dependency-block + implement-time binding (D-6).
- **Fixture capture friction**: the pre-P1 worktree needs `pnpm install && pnpm -r build`
  before the capture harness can import built seams. Documented step-by-step in quickstart.
- **CI env leakage**: any test forgetting to stub `process.env` produces runner-dependent
  bytes. D-2 centralizes the stub in a shared `beforeEach` helper within the golden test.
