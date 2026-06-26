# Research: `cockpit queue <phase>` — Phase 0 Decisions

## R1: Phase enumeration source

**Decision**: Read `.generacy/epics/*.yaml` via `@generacy-ai/cockpit`'s `readManifest`. Match by `phase.tier` (e.g. `P3`) OR `phase.name` (e.g. `foundation`). Hard error with a "run `cockpit manifest init` first" hint if no manifest is found. (Clarifications Q1, answer A.)

**Why**:
- The manifest IS the source of truth for phase→issues grouping. G0.1 (`@generacy-ai/cockpit#readManifest`) is already shipped.
- A `phase:*` label-based search (Q1 option C) would collide with the orchestrator's `phase:plan` / `phase:specify` / … namespace.
- A label-fallback (Q1 option B) is unnecessary: a committed manifest already exists at `.generacy/epics/epic-cockpit.yaml`, and the upcoming `cockpit manifest init` (G3.1 / #790) writes new ones.

**Alternatives**:
- Pure label-search → rejected (namespace collision).
- Manifest + label fallback → rejected (dead branch given existing manifest).
- GitHub Projects v2 API → rejected (out of scope; not the source of truth for phase grouping).

**References**:
- `packages/cockpit/src/manifest/io.ts` — `readManifest` / `EpicManifestSchema`.
- `packages/cockpit/src/__tests__/fixtures/epic-cockpit.yaml` — reference shape.
- Clarifications Q1.

## R2: Cluster account login source

**Decision**: Default to `gh api user --jq .login` (resolved once via the existing `CockpitGh.getCurrentUser()`); accept `--assignee <login>` CLI override. Do NOT add a `cockpit.clusterAccount` config field. (Clarifications Q2, answer B + C.)

**Why**:
- Inside the orchestrator container, the `gh`-authenticated identity IS the cluster account.
- Adding a required schema field (Q2 option A) would expand the merged `CockpitConfigSchema` for one verb's edge case — premature.
- An optional config hook can be added later if dev identity ever diverges from cluster identity in real scenarios.

**Alternatives**:
- Add a config field → rejected (out of scope per Q2's "no schema change" directive and the spec's Out of Scope).
- Read from `CLUSTER_ACCOUNT` env var → rejected (no orchestrator code sets this; introducing a new env var without a clear injection point is over-engineering).

**References**:
- `packages/generacy/src/cli/commands/cockpit/gh-ext.ts:227-235` — `getCurrentUser()`.
- Clarifications Q2.

## R3: Per-issue workflow label derivation

**Decision**: For each issue, inspect its current labels: `type:bug` → `process:speckit-bugfix`; otherwise → `process:speckit-feature`. (Clarifications additional directive.)

**Why**:
- Generalises FR-005's original hard-coded `process:speckit-feature` so mixed-type phases (one `type:bug` + several feature issues) queue correctly. SC-004 explicitly measures this.
- The `type:` namespace is established (`type:bug`, `type:feature`, `type:chore`, etc.); only `type:bug` needs special handling because the `process:speckit-bugfix` workflow is the only non-feature workflow we ship.
- Resolution per issue (not per phase) is critical: per-phase derivation would force every issue in a phase to take the same workflow label, which the spec explicitly rejects.

**Alternatives**:
- Derive from manifest `phase.tier` → rejected (loses per-issue granularity).
- Pass workflow label as a CLI flag → rejected (operator has to remember it; loses idempotency UX).

**References**:
- Spec FR-005.
- Clarifications "Additional Directives" section.

## R4: Cross-repo phase handling

**Decision**: One repo per invocation. If `phases[X].issues` span multiple repos, require `--repo <owner/repo>`; error (not silent-pick) when absent. Cross-repo refs appear as `[SKIP: cross-repo]` in the preview. (Clarifications Q3, answer A + B guard.)

**Why**:
- Cross-repo fan-out in one invocation breaks the per-repo automation constraint that the rest of the cockpit honours (one `gh` auth context, one PR per repo, etc.).
- Silent filtering (picking, say, `epic.repo` automatically) is too magical — the operator could queue the "wrong" repo by accident on a multi-repo phase.
- Visibility of `[SKIP: cross-repo]` rows in the preview is a deliberate operator-trust feature: the operator sees that issues exist and were intentionally not touched.

**Alternatives**:
- Use `manifest.epic.repo` automatically → rejected (silent filtering).
- Fan out across repos in one invocation → rejected (Out of Scope explicitly excludes this).

**References**:
- Spec Out of Scope.
- Clarifications Q3.

## R5: Partial-failure semantics

**Decision**: Best-effort across issues. Process every eligible row regardless of failures; exit non-zero with a structured per-issue summary if any error occurred. (Clarifications Q4, answer A.)

**Why**:
- SC-003 (idempotency) makes rerun trivial: a partial run + rerun reaches the same end state as a fail-fast retry.
- Maximises per-invocation progress: an auth blip or a missing label on issue #3 doesn't block #4 and #5.
- The structured summary tells the operator exactly which rows to retry (or fix-and-retry).

**Alternatives**:
- Fail-fast on first error → rejected (worse operator UX given idempotency; amplifies retry cost).
- Best-effort within a single issue only → rejected (sub-issue continuation is already the default per D7; the question is about issue-boundary continuation, which is the same answer).

**References**:
- Clarifications Q4.

## R6: Ineligible issue handling

**Decision**: Include `[SKIP: closed]` / `[SKIP: cross-repo]` / `[SKIP: not found]` rows in the preview; only mutate eligible rows on confirm. `[SKIP: no phase]` is reserved for the schema but unreachable in v1 (manifest IS the phase classification). (Clarifications Q5, answer B.)

**Why**:
- Operator trust: silently filtering is invisible; the operator can't tell whether an issue was forgotten or deliberately skipped.
- Non-blocking: presence of skip rows does NOT prevent confirm; the operator decides.
- The `[SKIP: no phase]` slot keeps the contract stable for when G3.1's `manifest sync` adds a reconciliation step that may report issues without a clear classification.

**Alternatives**:
- Silent filter → rejected (loss of visibility).
- Hard error on any ineligible → rejected (operator gets stuck because of a closed sibling; bad UX).

**References**:
- Clarifications Q5.

## R7: Confirmation prompt — `@clack/prompts`

**Decision**: Use `p.confirm({ message: 'Proceed?' })` from `@clack/prompts ^0.9` — the same dependency and pattern already used by `commands/destroy/index.ts`. Inject the prompt function via `deps.prompt` so tests can replace it with `() => Promise<boolean>`.

**Why**:
- Already a workspace dependency (no new deps).
- Same UX vocabulary the operator already knows from `generacy destroy`, `generacy down --volumes`.
- `p.isCancel(answer)` handles Ctrl-C cleanly; the verb prints `Cancelled. No mutations made.` and exits 0.

**Alternatives**:
- `readline.question` → rejected (extra wiring; no native cancel handling).
- `prompts` package → rejected (not already a dep; same shape as `@clack/prompts`).

**References**:
- `packages/generacy/src/cli/commands/destroy/index.ts:19-26`.

## R8: `gh issue edit --add-assignee` — one flag per login

**Decision**: Add `addAssignees(repo, n, logins[])` to `CockpitGh` (`gh-ext.ts`). Implementation: one `gh issue edit <n> --repo <repo> --add-assignee <login>` invocation per login. Idempotency is observed pre-mutation by comparing against the assignees list returned by `fetchIssueState` (extended to include assignees).

**Why**:
- `gh issue edit` already accepts `--add-assignee` repeated per login (see `packages/workflow-engine/src/actions/github/client/gh-cli.ts:224-227`).
- Pre-mutation idempotency check avoids a needless `gh` write call when the issue is already assigned to the cluster account — important for SC-003 (rerun reports `already`).
- Keeping the method on `CockpitGh` (not on `@generacy-ai/cockpit`'s `GhWrapper`) preserves the existing split: the foundation wrapper is shaped for the watcher's batch reads; per-verb adapters carry single-issue helpers.

**Trade-off**:
- `fetchIssueState` currently returns `{ state, closedAt, labels }`. The queue verb needs `assignees` too. We have two options:
  - **Extend** `fetchIssueState` to include `assignees` — touches an adapter shared by other verbs, but the change is additive and zero-risk.
  - **Add** a separate `fetchIssueQueueState` method that returns the wider shape — strictly additive, but duplicates 90% of the existing call.

  **Chosen**: extend `fetchIssueState` (additive field; trivially zero-impact on `advance.ts`). Update the unit tests for `advance.ts` only if they assert exhaustive object shape (they don't — they read `labels`/`state` selectively).

**References**:
- `packages/generacy/src/cli/commands/cockpit/gh-ext.ts:121-141` — `fetchIssueState`.
- `packages/workflow-engine/src/actions/github/client/gh-cli.ts:224-227` — `--add-assignee` shape.

## R9: Exit code taxonomy

**Decision**:

| Exit code | Condition                                                                                              |
|-----------|--------------------------------------------------------------------------------------------------------|
| 0         | All eligible rows succeeded or were already-queued; or user declined the prompt; or no eligible rows.  |
| 1         | At least one row failed (assign or label).                                                             |
| 2         | Usage error: missing `<phase>`, unknown phase, multi-repo phase without `--repo`, `--repo` not in phase's repos, malformed `--assignee`, manifest directory missing, no manifest found. |
| 3         | (Reserved — not used by queue; mirrors the `cockpit advance` "gate refusal" code.)                     |

**Why**: matches the established cockpit-verb convention (`advance` uses 2 for usage / 3 for refusal / 1 for gh failures). Distinct codes let the `/cockpit:queue` slash command and CI scripts react differently to usage errors vs. mutation failures.

## R10: Test fixtures and adapter stubs

**Decision**: Unit tests inject:
- `runner: CommandRunner` (stubbed gh responses keyed by argv).
- `gh: CockpitGh` (higher-level stub for verbs that don't need raw gh JSON).
- `loadConfig` (returns inline `LoadedCockpitConfig`).
- `prompt: () => Promise<boolean>` (decline by default in decline tests; accept in confirm tests).
- `stdout`, `stderr` (capture into arrays for assertion).
- `now`: not used by queue (no timestamps in output).
- `manifestRoot`: a `tmpdir` path written with inline YAML.

**Reference patterns**:
- `__tests__/advance.test.ts` — verb-level test seam.
- `__tests__/state.test.ts` — gh-stub vocabulary.
- `__tests__/helpers/` — shared test utilities (verify nothing forces a `gh` exec).

**Coverage target**:
1. Phase resolved by `tier` (e.g. `P3`).
2. Phase resolved by `name` (e.g. `foundation`).
3. Unknown phase → exit 2 with hint.
4. Multi-repo phase without `--repo` → exit 2 with repo list.
5. `--repo` outside phase's repos → exit 2.
6. Mixed `type:bug` + feature → correct per-issue labels.
7. Closed issue in phase → `[SKIP: closed]`, not mutated.
8. Confirm decline → zero `gh` write calls (SC-002).
9. `--yes` skips prompt, mutates eligible only.
10. Rerun on already-queued phase → all `already`, exit 0 (SC-003).
11. Label call fails on one issue, others succeed → exit 1 with structured summary (Q4).
12. `--assignee custom-bot` overrides default.

## Key Sources

- `specs/791-epic-generacy-ai-tetrad/spec.md` — feature spec.
- `specs/791-epic-generacy-ai-tetrad/clarifications.md` — Q1–Q5 + additional directives.
- `specs/786-epic-generacy-ai-tetrad/plan.md` — G0.1 cockpit package design (manifest reader, gh wrapper).
- `packages/generacy/src/cli/commands/cockpit/advance.ts` — verb-shape reference.
- `packages/generacy/src/cli/commands/cockpit/gh-ext.ts` — adapter to extend.
- `packages/generacy/src/cli/commands/destroy/index.ts` — `@clack/prompts` confirm pattern.
- `packages/workflow-engine/src/actions/github/client/gh-cli.ts:226` — `gh issue edit --add-assignee` shape.
