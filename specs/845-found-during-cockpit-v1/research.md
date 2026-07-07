# Research: `cockpit advance` label-pair fix (#845)

## Problem Restatement

`cockpit advance --gate <name>` adds `completed:<gate>` and removes `waiting-for:<gate>`. The orchestrator's poll-path resume detector requires **both** labels present at scan time. On poll-only clusters (no webhook delivery), the resume event never fires; the issue strands.

## Evidence

### Observed failure

- `/cockpit:clarify` executed on `christrudelpw/sniplink#2/#3/#4` — answers posted, `cockpit advance --gate clarification` reported success.
- Post-advance labels observed: `{completed:clarification, agent:in-progress, agent:paused}`. **No** `waiting-for:clarification`.
- Issues never resumed. Manual repair: re-added `waiting-for:clarification` — worker resumed and cleaned up all three labels itself.

### Control case (positive)

- generacy#805 and tetrad#87 dogfooding: manual label add of `completed:clarification` **only** — `waiting-for:clarification` left in place — worker resumed correctly on next poll cycle.
- Confirms: worker's resume path already owns cleanup of `waiting-for:*`, `completed:*`, and `agent:paused`.

### Root-cause site (source-verified 2026-07-07)

- `packages/generacy/src/cli/commands/cockpit/advance.ts:169–176` — the `removeLabel(waitingLabel)` call.
- `packages/orchestrator/src/services/label-monitor-service.ts:156–180` — `completed:*` handler branch. `if (issueLabels.includes(waitingLabel))` returns `resume`; else logs orphan and returns `null`.

## Decision 1 — Where to fix

**Chosen**: fix the CLI (`advance.ts`), not the monitor (`label-monitor-service.ts`).

**Rationale**:
- The monitor's label-pair check is the documented resume contract (per `tetrad-development/docs/label-protocol.md`: "the monitor watches for a matching completed:* label to resume").
- The worker owns cleanup — control-case evidence confirms.
- Weakening the monitor to accept orphan `completed:*` would hide future advance-side regressions (any wrapper that accidentally drops `waiting-for:*` would silently work-around the check).
- The catalog was in error, not the monitor. Fix the caller.

**Alternative rejected**: teach `label-monitor-service.ts` to emit `resume` on orphan `completed:*`. Rejected: hides regressions; contradicts the label-protocol doc; requires a follow-up to also make the worker's cleanup path idempotent when `waiting-for:*` is already absent (currently fine, but the coupling is fragile).

## Decision 2 — Operator-visible phrasing

Per clarifications Q1→C: update **all three** surfaces consistently:

1. CLI stdout summary (`advance.ts:178–181`)
2. Marker comment body (`manual-advance-marker.ts:30–31`)
3. Any `#788` cockpit docs / quickstart referencing `waiting-for:X → completed:X`.

**Rationale**:
- The arrow-form (`waiting-for:X → completed:X`) is indistinguishable from a label-diff claim to an operator staring at the labels tab.
- The marker comment lives permanently in the issue thread — leaving old wording there teaches future readers the wrong story.
- Q1→A (leave everything) was rejected because it perpetuates the mental model that produced the bug.
- Q1→B (update stdout only) was rejected on the same grounds — the marker comment is the more durable surface.

**Chosen phrasing** (implemented across surfaces):
- Stdout: `advanced <ref>: completed:<gate> added — waiting-for:<gate> left in place for the worker to clear on resume (comment: <url>)`
- Marker sentence (with actor): ``Marked `completed:<gate>` by **@<actor>** — `waiting-for:<gate>` left in place for the worker to clear on resume.``
- Marker sentence (no actor): ``Marked `completed:<gate>` — `waiting-for:<gate>` left in place for the worker to clear on resume.``

## Decision 3 — `advance.ts` header comment scope

Per clarifications Q2→C: rewrite the header around the label-pair invariant, not around numbered steps.

**Rationale**:
- Numbered-recipe framing is what invited the bug — an omitted step looks load-bearing.
- Stating the invariant (poll-path resume requires both labels; worker owns cleanup) forecloses the failure mode at the level of intent, not by discipline.
- Subsumes Q2→B's one-line pointer.

## Decision 4 — Marker HTML prelude byte-stability

The `<!-- generacy-cockpit:manual-advance gate=… actor=… ts=… -->` prelude MUST NOT change.

**Rationale**:
- It is scanned by `packages/generacy/src/cli/commands/cockpit/clarification-comment-finder.ts` (and potentially other cockpit surfaces) to identify manual-advance markers.
- Only the human-facing sentence below the prelude changes.
- Existing marker parser tests remain unchanged.

## Decision 5 — Regression test shape

Add a positive assertion that `gh.removeLabel` is never called with any `waiting-for:*` label on the happy path.

**Rationale**:
- A negative assertion on the specific label works, but the general "any label starting with `waiting-for:`" form catches the failure mode more broadly (someone adding a second gate that repeats the pattern).
- Cheap: one line in the existing happy-path test.
- SC-003 signal: deleting the fix reintroduces the bug and this test fails deterministically.

## References

- Spec: `specs/845-found-during-cockpit-v1/spec.md`
- Clarifications: `specs/845-found-during-cockpit-v1/clarifications.md`
- Sibling contract (unchanged prelude, changed sentence): `specs/830-found-during-cockpit-v1/contracts/manual-advance-marker.md`
- Label protocol (out-of-repo, authoritative): `tetrad-development/docs/label-protocol.md`
- Related incident logs: generacy-ai/tetrad-development#88 (finding #11); generacy#805; tetrad#87.
