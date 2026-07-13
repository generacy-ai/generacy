# Feature Specification: Cockpit CLI identity resolution for App-credentialed clusters

**Branch**: `830-found-during-cockpit-v1` | **Date**: 2026-07-07 | **Status**: Draft
**Type**: Bug fix | **Upstream**: [generacy-ai/generacy#830](https://github.com/generacy-ai/generacy/issues/830)

## Summary

`generacy cockpit queue` and `generacy cockpit advance` hard-fail on GitHub App-credentialed clusters (credentials v1.5 flow) because both commands call `gh api user` to resolve the operator's GitHub username. GitHub App installation tokens have no user identity, so `GET /user` always returns 403 ("Resource not accessible by integration"), turning routine cockpit operations into a wall for any staging/production cluster provisioned via the new App flow.

Observed failure:

```
$ generacy cockpit queue 1 P1
Error: cockpit queue: gh api user: gh api user failed (exit 1): gh: Resource not accessible by integration (HTTP 403)
```

The orchestrator already solved this at `packages/orchestrator/src/services/identity.ts` (lines 48–61) — it resolves cluster identity via `CLUSTER_GITHUB_USERNAME` first, then `GH_USERNAME`, and only falls back to `gh api /user`. The cockpit CLI never adopted that chain. This spec brings the same precedence — **behaviorally identical to `identity.ts`** — into the CLI and downgrades cosmetic-only usages so that missing identity does not block gate advancement.

Call sites affected:
- `packages/generacy/src/cli/commands/cockpit/queue.ts` (~line 297–309): resolves the default assignee for issue triage → **load-bearing** on non-app clusters where assignee filtering is active.
- `packages/generacy/src/cli/commands/cockpit/advance.ts` (lines 135–141): resolves the acting user for the marked "gate advanced" comment → **cosmetic only** (comment attribution).

Workaround in use: `generacy cockpit queue 1 P1 --assignee christrudelpw`.

## User Stories

### US1: Queue issues on an App-credentialed cluster (Primary)

**As** an operator running cockpit against a staging cluster provisioned through the wizard (credentials v1.5 / GitHub App token),
**I want** `generacy cockpit queue <epic> <phase>` to resolve my identity without calling `gh api user`,
**So that** I can queue issues without hitting a 403 or having to pass `--assignee` on every invocation.

**Acceptance Criteria**:
- [ ] `cockpit queue` succeeds on an App-credentialed cluster with `CLUSTER_GITHUB_USERNAME` set, without any `gh api user` call.
- [ ] `cockpit queue` succeeds on an App-credentialed cluster with `GH_USERNAME` set (and `CLUSTER_GITHUB_USERNAME` unset), without any `gh api user` call.
- [ ] `cockpit queue` succeeds on an App-credentialed cluster with `--assignee <login>` regardless of env state.
- [ ] `cockpit queue` on an App-credentialed cluster with none of the flag, `cockpit.assignee` config, `CLUSTER_GITHUB_USERNAME`, or `GH_USERNAME` set fails with a single loud error that names the `--assignee` flag AND both env vars (`CLUSTER_GITHUB_USERNAME` and `GH_USERNAME`).
- [ ] `cockpit queue` on a legacy (non-App) cluster where `gh api user` works still succeeds and picks up the auto-detected login.
- [ ] Existing precedence — explicit `--assignee` flag beats `cockpit.assignee` config beats env — is preserved. Full chain (highest to lowest): `--assignee` flag → `cockpit.assignee` config → `CLUSTER_GITHUB_USERNAME` → `GH_USERNAME` → `gh api user`.

### US2: Advance a gate on an App-credentialed cluster

**As** an operator running `generacy cockpit advance` (invoked by `/cockpit:clarify`, `/cockpit:review`, etc.) on an App-credentialed cluster,
**I want** the gate to advance even when my acting-user identity cannot be resolved,
**So that** cosmetic comment attribution does not block workflow progression.

**Acceptance Criteria**:
- [ ] `cockpit advance` succeeds on an App-credentialed cluster with `CLUSTER_GITHUB_USERNAME` (or `GH_USERNAME`) set — the marked comment includes the configured actor.
- [ ] `cockpit advance` succeeds on an App-credentialed cluster with none of the flag, config, or env vars set — the marked comment omits the "actor:" line rather than throwing.
- [ ] The added `advanced:<gate>` label and gate transition happen in all successful paths.
- [ ] A warn-level log is emitted when identity cannot be resolved, naming the same knobs as US1's loud error (i.e., `--assignee`, `cockpit.assignee`, `CLUSTER_GITHUB_USERNAME`, `GH_USERNAME`).

### US3: Discoverable single source of truth for identity

**As** a maintainer touching future cockpit subcommands,
**I want** one identity-resolution helper in the CLI package,
**So that** new commands do not reintroduce the same `gh api user` bug.

**Acceptance Criteria**:
- [ ] One reusable helper (e.g., `resolveCockpitIdentity(...)`) exists in `packages/generacy/src/cli/commands/cockpit/` (or a shared cockpit utility module) and is the sole caller of `getCurrentUser()`.
- [ ] Both `queue.ts` and `advance.ts` call the helper; no direct `gh api user` calls remain in cockpit subcommands.

## Functional Requirements

| ID     | Requirement                                                                                                                                                                                                                                                                                             | Priority | Notes |
|--------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|----------|-------|
| FR-001 | Introduce a shared identity-resolution helper for cockpit subcommands with precedence: (1a) `--assignee` flag, (1b) `cockpit.assignee` config (flag beats config within tier 1), (2) `CLUSTER_GITHUB_USERNAME` env var, (3) `GH_USERNAME` env var, (4) `gh api user`, (5) fail loudly (or return `undefined` for cosmetic callers) with a message naming the flag, the config key, AND both env vars. | P1       | Behaviorally identical to `packages/orchestrator/src/services/identity.ts` (lines 48–61). |
| FR-002 | `cockpit queue` MUST call the helper in "required" mode — when all sources fail, throw with an error that includes `--assignee`, `cockpit.assignee`, `CLUSTER_GITHUB_USERNAME`, and `GH_USERNAME` in the message.                                                                                       | P1       | Queue depends on the assignee for triage output; degrading silently would hide misconfiguration. Precise-over-short: an operator who set `GH_USERNAME` and gets an error naming only `CLUSTER_GITHUB_USERNAME` will conclude the mechanism is broken. |
| FR-003 | `cockpit advance` MUST call the helper in "optional" mode — when all sources fail, log a warning (naming the same four knobs as FR-002) and omit the "actor:" line from the marked-advance comment; the gate transition MUST still complete.                                                            | P1       | Actor is cosmetic per issue #830 ("degrade to omitting the actor line rather than failing the gate advance"). |
| FR-004 | Neither `queue` nor `advance` MAY call `gh api user` directly on the happy path when a higher-precedence source is available.                                                                                                                                                                             | P1       | Ensures App-credentialed clusters never hit the 403. |
| FR-005 | The helper's precedence and error messages MUST be covered by unit tests exercising each precedence tier (including flag-beats-config within tier 1 and `CLUSTER_GITHUB_USERNAME`-beats-`GH_USERNAME` within the env tier) and each failure mode.                                                       | P1       | Guards against regressions. |
| FR-006 | Verify the smee-receiver's no-assignee skip path aligns with the orchestrator's `webhooks.ts` guard (which disables assignee filtering entirely when `CLUSTER_GITHUB_USERNAME` is unset). Record findings as a comment on issue #830 tagged "FR-006 investigation" — for both the "no divergence" and "divergence found" branches; if divergence is found, the comment additionally links a filed follow-up issue. | P2       | Deliverable location clarified: issue comment (not a spec file, not an assumption line). Survives branch deletion and is greppable from the motivating issue. |
| FR-007 | Add `assignee?: string` (optional) to `CockpitConfigSchema` in `@generacy-ai/cockpit` and read it in the helper (tier 1b) — sourced from the `cockpit:` block in `.generacy/config.yaml`. Field and reader land together in this PR; no dead surface.                                                     | P1       | Documented as one of the three optional cockpit keys in the rev 3 plan (`docs/epic-cockpit-plan.md` in tetrad-development) — never implemented. |

## Success Criteria

| ID     | Metric                                                                                                                          | Target                                                          | Measurement |
|--------|---------------------------------------------------------------------------------------------------------------------------------|-----------------------------------------------------------------|-------------|
| SC-001 | `generacy cockpit queue <epic> <phase>` on an App-credentialed cluster with `CLUSTER_GITHUB_USERNAME` (or `GH_USERNAME`) set     | Exits 0; no `gh api user` invocation                            | Manual smoke against staging cluster; trace `gh` calls with `GH_DEBUG=api`. |
| SC-002 | `generacy cockpit advance <ref> <gate>` on an App-credentialed cluster with none of flag, config, or env vars set                | Exits 0; label is applied; comment has no "actor:" line; warning logged | Manual smoke against staging cluster; inspect issue on GitHub. |
| SC-003 | Zero direct `gh api user` (or `getCurrentUser()`) call sites in `packages/generacy/src/cli/commands/cockpit/**` outside the new helper | grep count = 1 (the helper itself)                              | `rg 'getCurrentUser\|gh api user' packages/generacy/src/cli/commands/cockpit/` |
| SC-004 | Failure message on missing identity                                                                                              | Names `--assignee`, `cockpit.assignee`, `CLUSTER_GITHUB_USERNAME`, AND `GH_USERNAME` | Unit test assertion. |
| SC-005 | Existing `cockpit queue`/`advance` behavior on non-App clusters (where `gh api user` works)                                     | Unchanged                                                       | Existing unit + integration tests remain green. |
| SC-006 | Behavioral parity with orchestrator                                                                                              | Given the same inputs, the cockpit helper resolves the same identity `services/identity.ts` would | Unit test comparing tier order + tier semantics against a table copied from `identity.ts`. |

## Assumptions

- `cockpit.assignee` is added to `CockpitConfigSchema` in `@generacy-ai/cockpit` and read from the `cockpit:` block of `.generacy/config.yaml`. Field and reader ship together in this PR (see FR-007).
- The `GhWrapper.getCurrentUser()` method wraps `gh api user` and can continue to be used as the tier-4 fallback without modification.
- Warn-level logging in `advance` is acceptable through cockpit's existing stderr `print` mechanism (no new logger infrastructure required).
- `CLUSTER_GITHUB_USERNAME` and `GH_USERNAME` are already exposed to the cockpit process on clusters where the orchestrator reads them (v1.5 wizard clusters). No new env-var plumbing is needed.
- Extracting the resolver into a shared package (so orchestrator and cockpit import a single implementation) is a desirable follow-up but out of scope; behavioral identity — verified via SC-006 — is the requirement here.

## Out of Scope

- Deciding whether cluster scaffolding should set `CLUSTER_GITHUB_USERNAME` automatically for app-credentialed clusters at onboarding. The issue explicitly flags this as a separate open question — file a follow-up if the fix here doesn't cover the common path.
- Broader refactor of orchestrator `services/identity.ts` (already correct; we mirror its precedence, do not touch it).
- Extracting the resolver into a shared package used by both orchestrator and cockpit (desirable follow-up; behavioral identity via SC-006 is sufficient for this PR).
- Non-cockpit CLI subcommands that also call `gh api user` (e.g., generic `gh` wrappers used outside cockpit).
- Changing the `advanced:<gate>` label semantics or comment body format beyond the actor-line degradation described in FR-003.

---

*Generated by speckit*
