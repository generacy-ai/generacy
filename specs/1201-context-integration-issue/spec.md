# Feature Specification: P1 route plumbing end-to-end verification

**Branch**: `1201-context-integration-issue` | **Date**: 2026-08-26 | **Status**: Draft

## Summary

This is the integration issue that closes **P1** of the LLM gateway model routing epic
(generacy-ai/generacy#1197). The three sibling issues ship the mechanism:

- **#1198** — `generacy-plugin-claude-code`: `resolveRoute(model)`, per-launch
  `CLAUDE_CONFIG_DIR` gateway env in every launch builder, `GatewayRouteUnavailableError`.
- **#1199** — orchestrator: route-aware session invalidation + `agent.route.transition`
  logging keyed on the `(provider, route)` tuple.
- **#1200** — config/cli: `generacy validate` gateway-route warning + `generacy doctor`
  `llm-gateway` check.

#1201 adds **no new mechanism**. It proves the P1 stack works together and — critically —
that clusters on Claude subscriptions are **byte-for-byte unchanged**. It delivers a set of
integration/golden/phase-loop tests plus one short docs note. The load-bearing guarantee of
the whole epic is "flag-free by construction: no gateway configured → no behavior change,"
and this issue is where that guarantee is nailed down in CI.

## Context

Integration issue closing P1 (route resolution + launch plumbing). Contracts under test:
`resolveRoute` export, `CLAUDE_CONFIG_DIR` env on gateway launches, `GatewayRouteUnavailableError`,
route-aware session drop, and the `validate`/`doctor` surfaces. Full design:
`docs/llm-gateway-model-routing-plan.md` in generacy-ai/tetrad-development; a condensed design
summary lives in the epic body.

## User Stories

### US1: Gateway launches carry the config dir; subscription launches do not (P1)

**As a** platform engineer relying on model-name routing,
**I want** confidence that a gateway-shaped model (`provider/model`) produces a spawn whose
environment sets `CLAUDE_CONFIG_DIR` to the gateway config dir, while an Anthropic model
produces a spawn with no such env,
**So that** non-Anthropic models reach the gateway and Claude subscription launches keep
using the default config dir.

**Acceptance Criteria**:
- [ ] A launcher-level test drives `AgentLauncher.launch` through the credentials interceptor
      and asserts the spawned env contains `CLAUDE_CONFIG_DIR=<gatewayConfigDir>` **only** for
      gateway-route intents.
- [ ] The same test asserts a subscription-route intent's spawned env contains **no**
      `CLAUDE_CONFIG_DIR`.
- [ ] The test asserts the `sh -c '. "$GENERACY_SESSION_DIR/env" && exec "$@"'` credentials
      wrapper **preserves** `CLAUDE_CONFIG_DIR` through to the final `exec`.

### US2: Subscription-only clusters are byte-for-byte unchanged (P1 — load-bearing)

**As a** developer running a cluster on a Claude subscription with a fully Anthropic config
and no gateway configured,
**I want** every launch to be identical to the pre-P1 baseline,
**So that** adopting the P1 packages carries zero risk of behavioral drift.

**Acceptance Criteria**:
- [ ] A golden test captures a fixture baseline of `{command, args, env}` for every spawn
      kind: phase, pr-feedback, merge-conflict, review, remediate, conversation-turn.
- [ ] With no gateway configured and a fully Anthropic config, each spawn kind produces
      `{command, args, env}` **byte-identical** to the captured baseline.

### US3: A cross-route phase transition drops the CLI session (P1)

**As a** workflow author sequencing phases across different backends,
**I want** the orchestrator to drop the CLI session whenever a phase transition crosses the
subscription⇄gateway boundary,
**So that** `--resume` never fails against a config dir that doesn't know the session.

**Acceptance Criteria**:
- [ ] A phase-loop test runs a three-phase sequence subscription → gateway → subscription and
      asserts **two** session drops occur.
- [ ] The same test asserts the expected `agent.route.transition` log lines are emitted for
      each crossing.

### US4: Operators can discover model routing from the docs (P1)

**As an** operator reading the getting-started docs,
**I want** a short note explaining gateway-shaped model names and where the gateway comes from,
**So that** I understand routing exists and know it requires a gateway-enabled cluster.

**Acceptance Criteria**:
- [ ] `docs/docs/getting-started/configuration.md` gains a short "Model routing" note covering
      gateway-shaped names and where the gateway comes from, with a link to P2.
- [ ] The note is explicitly marked "requires a gateway-enabled cluster."

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | A launcher-level test in `packages/orchestrator/src/launcher/__tests__/` (alongside `multi-provider.test.ts`) drives `AgentLauncher.launch` through the credentials interceptor. | P1 | Uses the real interceptor path, not a mock of it. |
| FR-002 | The launcher test asserts the spawned env contains `CLAUDE_CONFIG_DIR` for gateway-route intents and does not contain it for subscription-route intents. | P1 | |
| FR-003 | The launcher test asserts the `sh -c '. "$GENERACY_SESSION_DIR/env" && exec "$@"'` wrapper preserves `CLAUDE_CONFIG_DIR` through to `exec`. | P1 | Wrapper must not strip inherited env. |
| FR-004 | A golden test captures a pre-P1 baseline of `{command, args, env}` for every spawn kind (phase, pr-feedback, merge-conflict, review, remediate, conversation-turn) in a fixture. | P1 | Baseline is checked into the repo as a fixture. Per Q1 (C): captured once from the pre-P1 merge-base commit (before #1198/#1199/#1200) to prove true parity in the initial PR, then treated as a forward-stability pin with a documented regeneration procedure for legitimate future spawn changes. |
| FR-005 | With no gateway configured and a fully Anthropic config, each spawn kind is byte-identical to the captured baseline. | P1 | This is the epic's flag-free guarantee. Per Q2 (A): determinism via fully controlled input env — the test injects a fixed base env (empty or minimal allowlist) and fixed session/config paths, so the complete `{command, args, env}` triple is compared byte-for-byte. |
| FR-006 | A phase-loop test runs subscription → gateway → subscription and asserts two session drops. | P1 | |
| FR-007 | The phase-loop test asserts the expected `agent.route.transition` log lines. | P1 | Matches #1199's log contract. |
| FR-008 | `docs/docs/getting-started/configuration.md` gains a "Model routing" note (gateway-shaped names, gateway source, link to P2), marked "requires a gateway-enabled cluster." | P1 | Per Q5 (A): the "link to P2" target is the epic (generacy-ai/generacy#1197) and/or the P2 issue (generacy#1203) — accurate today, to be replaced with a docs link when P2 ships. No docs-page link (would break `onBrokenLinks: 'throw'`). |
| FR-009 | No `--settings` usage is introduced anywhere in the change. | P1 | Per Q4 (A): guarded by a committed source-grep test scanning `packages/orchestrator/src/launcher/**` and `packages/generacy-plugin-claude-code/src/launch/**` for zero `--settings` occurrences — a permanent regression guard, following the existing `source-grep.test.ts` precedent. |
| FR-010 | No changes to `AgentEntrySchema`. | P1 | `model` is already free-form. |
| FR-011 | A changeset is present in the PR. | P1 | generacy PRs require one (CI gate). |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | New/updated tests (launcher, golden, phase-loop) | All green in CI | `pnpm -r build` + test run |
| SC-002 | Subscription-only spawn drift vs baseline | Zero byte differences across all six spawn kinds | Golden fixture comparison |
| SC-003 | Cross-route session drops in the three-phase sequence | Exactly 2 | Phase-loop test assertion |
| SC-004 | `--settings` occurrences introduced by this change | 0 | grep / source-grep guard |
| SC-005 | `AgentEntrySchema` changes | 0 | diff review |
| SC-006 | Changeset added | 1 newly-added `.changeset/*.md` | changeset-bot gate |

## Assumptions

- Siblings #1198, #1199, and #1200 are merged (or co-present on the branch base) before this
  issue's tests can be green — this issue asserts their shipped contracts, it does not
  re-implement them. Per Q3 (A): if any sibling is not yet merged when implement starts,
  the implement phase dependency-blocks — skip and requeue until all three are merged to
  develop and this branch is rebased on them (matches the #1127 precedent for phase-N
  integration issues).
- The gateway config dir default is `/home/node/.claude-gateway` (env override
  `GENERACY_CLAUDE_GATEWAY_CONFIG_DIR`), per #1198.
- Route resolution is `gateway` iff the resolved model contains `/`; `undefined` and all
  `claude-*`/alias forms resolve to `subscription`, per #1198's `resolveRoute`.
- The pre-P1 golden baseline can be captured deterministically so byte-comparison is stable
  across runs — achieved per Q2 (A) by injecting a fully controlled input env (fixed base env,
  fixed session/config paths) rather than normalizing or delta-comparing ambient env.
- `resolveRoute` is consumed from the plugin's public export; the orchestrator does not
  duplicate the routing rule (dependency direction: orchestrator → plugin).

## Out of Scope

- Any new routing mechanism, launch builder, session-invalidation logic, or validate/doctor
  behavior — those are #1198/#1199/#1200. This issue is tests + one docs note only.
- The Bifrost/LiteLLM gateway sidecar, entrypoint config-dir setup, and dev-cluster bring-up
  (P2: tetrad-development#109/#110, generacy#1203).
- Scaffolder / cluster-base / cloud-template gateway stanzas (P3).
- Cockpit auto route rules, credhelper `llm-provider` kind, wizard provider step (P4).
- Verifying tool-use streaming fidelity through the gateway (P2 integration responsibility).

---

*Generated by speckit*
