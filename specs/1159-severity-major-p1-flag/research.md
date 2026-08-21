# Research: External-feedback re-entry budget bounding + charter fencing + head-ref checkout

**Feature**: `1159-severity-major-p1-flag`
**Status**: Complete

This document records the technology decisions, alternatives considered, and
implementation patterns behind the three fixes in `plan.md`. Every decision is
anchored to a clarification answer (Q1→A, Q2→B, Q3→A, Q4→C, Q5→A) and to an
existing precedent in the codebase — no new dependencies, no new persisted state.

---

## Decision 1 — Bound the remediation budget by suppressing spurious re-enqueue, not by changing the artifact clear

**Context**: FR-001 (Q1→A) requires `remediationCount` to persist across
`address-pr-feedback` re-entries, with the review artifact as the single source
of truth. The naive read of "stop calling `clearReviewArtifact` on re-entry"
collides with the fact that `claude-cli-worker.ts:593` *already* calls it, and
the D-2 reset comment at `:580-592` says that clear is intentional on two
occasions.

**Decision**: Do **not** touch the `clearReviewArtifact` call. The real defect is
that the monitor re-enqueues the same unaddressed feedback on `failed:*`
escalations (the skip gate covers `blocked:*` and
`waiting-for:remediation-limit` but not `failed:*`). Add a blanket `failed:*`
prefix skip to the monitor. Once same-feedback re-enqueue is suppressed, the
worker reaches `clearReviewArtifact` **only** on the two legitimate reset
occasions (Q2→B): operator resume of the gate, or a genuinely new review that
changed the unresolved-thread set. On those occasions the reset is correct; on
every other occasion the artifact survives and the seed executor's existing
`remediationCount: prior?.remediationCount ?? 0` (`seed-aware-review-executor.ts:96`)
carries the budget forward.

**Why this is the root cause**: The `on-remediation-limit` cap
(`phase-loop.ts:1419-1438`) is `remediationCount >= maxRemediations` — a global
comparison. It only fails to fire because the count keeps getting reset to 0. The
count only resets to 0 because the artifact keeps getting cleared. The artifact
only keeps getting cleared because the monitor keeps re-enqueuing on `failed:*`.
The monitor skip gap is the single upstream cause; fixing it makes the cap
global for free.

**Alternatives rejected**:
- **B (separate per-PR budget store, e.g. a Redis key)** — Q1 rejected: adds a
  redundant parallel source of truth alongside the artifact, plus a new key
  lifecycle (TTL, invalidation) of exactly the class that produced #849's
  stale-key stranding. The artifact already holds the count.
- **C (preserve `remediationCount` across the clear but discard prior findings)**
  — Q1 rejected: duplicates what the executor already does with
  `prior?.remediationCount ?? 0`, and forces a partial-artifact write path that
  does not exist today.
- **Guarding the `clearReviewArtifact` call with a condition** — rejected:
  the two reset occasions are exactly the occasions on which the worker legitimately
  reaches that call *after the monitor skip is in place*. Adding a condition would
  duplicate the monitor's skip logic inside the worker and risk the two drifting.

---

## Decision 2 — Blanket `failed:*` prefix skip in the monitor (no allow-list)

**Context**: FR-003 (Q3→A). The monitor must suppress re-enqueue for `failed:*`
escalations (`failed:review`, `failed:validate-repeated`, and any future
`failed:*`).

**Decision**: Mirror the existing `blocked:*` short-circuit at
`pr-feedback-monitor-service.ts:557` — a blanket `startsWith('failed:')` check,
no enumerated allow-list. Place it alongside the `blocked:*` gate, after the
`waiting-for:remediation-limit` (`:473`) and `blocked:fixer-timeout` (`:505`)
retry-eligible carve-outs so those remain reachable. Log shape mirrors the
`blocked:*` skip. Operator clears it by removing the `failed:*` label — already
the resume convention for these escalations.

**Why blanket, not allow-list**: The file's own contract (`:445-449`) states any
`blocked:*` prefix skips with no allow-list. An allow-list for `failed:*` (option
B) would contradict that established contract and silently let any *future*
`failed:*` label fall through to per-poll re-enqueue — reintroducing the runaway
for the next escalation label someone adds.

**Alternatives rejected**:
- **B (enumerate `failed:review` + `failed:validate-repeated` only)** — Q3
  rejected: contradicts the no-allow-list contract; brittle against new labels.
- **C (skip on `failed:*` OR unresolved-thread-with-parked-state, cleared only by
  explicit resume action)** — Q3 rejected: introduces parked-state machinery that
  does not exist on this path and a second clear convention.

**Ordering note**: The skip must sit *after* the `waiting-for:remediation-limit`
and `blocked:fixer-timeout` branches. Those are retry-eligible states with their
own handling; a blanket `failed:*` skip placed before them would not affect them
(they are not `failed:*`), but keeping the placement adjacent to `blocked:*`
keeps the "terminal-until-operator-clears" gates grouped and readable.

---

## Decision 3 — Fence untrusted `detail` at the two ingestion sites, not in the charter

**Context**: FR-004/FR-005 (Q5→A). Seed findings set `detail` to the raw
trusted-author comment body (`seed-aware-review-executor.ts:75`, `detail: f.body`)
and validate findings set `detail` to raw validate stdout/stderr tails
(`phase-loop.ts:1037`). Both land unfenced in the remediate charter
(`remediate-charter.ts:60`, `- **Detail:** ${finding.detail}`).

**Decision**: Wrap `detail` with `wrapUntrustedData(body, sourceLabel)` at the
**two ingestion sites only**. Leave the charter untouched — it embeds the
already-fenced string verbatim. Leave engine-authored review findings (from the
real review executor) untouched.

**Why the ingestion sites**: The charter is a single embed point but it receives
findings from three sources: engine-authored review findings (trusted), seed
findings (untrusted comment bodies), and validate-evidence findings (untrusted
tool output). Fencing centrally in the charter (option B) would wrap
engine-authored detail too. Even though "wrap exactly once" avoids a literal
double-wrap, it fences trusted engine text as if it were untrusted, which changes
the meaning of engine-authored findings and violates US2 AC3 ("engine-authored
finding detail is not altered in a way that changes its meaning"). Fencing at the
two untrusted ingestion points is surgical and matches the existing pattern at
`validate-fix-handler.ts:235` and `pr-feedback-handler.ts:855`.

**Source labels**: seed site → a label identifying the review comment / author
(e.g. `pr-review-comment` or the author login); validate site → `validate-output`.
`wrapUntrustedData` escapes the label, so an attacker-controlled author login
cannot break out of the `source="…"` attribute.

**Alternatives rejected**:
- **B (central charter-level wrap of every finding `detail`)** — Q5 rejected:
  fences engine-authored findings, altering their meaning.
- **C (ingestion-site wrap + a per-finding marker so the charter asserts-and-skips
  already-fenced detail)** — Q5 rejected: adds belt-and-suspenders complexity
  beyond the wrap-once guarantee the two-site approach already provides.

---

## Decision 4 — Resolve the working branch from the PR head ref, with a zero/one/many rule

**Context**: FR-006/FR-007 (Q4→C). The re-entry derives the branch via
`createFeature({ number: issueNumber })` (`claude-cli-worker.ts:491-495`). Under
slug drift (#1043) this can differ from the PR's real `head.ref`, landing
remediation commits on the wrong branch and letting
`commitPushAndEnsurePr('remediate')` open a duplicate PR.

**Decision**: On the `address-pr-feedback` path only, resolve the branch from the
PR head ref and `switchBranch` to it, exactly as the legacy fixer does at
`pr-feedback-handler.ts:225` (`const branchName = pr.head.ref;` →
`repoCheckout.switchBranch(checkoutPath, branchName)`). Apply the Q4→C
resolution rule for linked-PR ambiguity:

| Linked open PRs | Action |
|---|---|
| exactly one | use its `head.ref` (`switchBranch`) |
| zero | fresh-request: budget 0, keep the current `createFeature` path |
| more than one | park this poll and surface for operator attention |

Keep `createFeature` for every non-`address-pr-feedback` command.

**Why head-ref is authoritative**: The PR's `head.ref` is the branch the commits
must land on to update the existing PR. The issue-derived slug is a *guess* that
happens to match when slug generation is stable, and diverges when it is not
(#1043). Using `head.ref` removes the guess.

**Why park on `>1` rather than guess**: Two linked open PRs is genuine ambiguity;
guessing a branch risks committing to the wrong PR or opening a third. Parking
surfaces the ambiguity to a human without mutating state — the conservative choice
matching Q4→C.

**Alternatives rejected**:
- **A (fall back to `createFeature` + warn on ambiguity)** — Q4 rejected:
  preserves the exact dup-PR risk this fix exists to remove.
- **B (refuse/park on any lookup difficulty)** — Q4 rejected: over-parks the
  common single-PR case, which is unambiguous and safe to resolve.

**Single-PR resolution mechanism**: The re-entry already knows the PR number
(`metadata.prNumber`, asserted non-null at `claude-cli-worker.ts:519`). Resolve
`head.ref` via `getPullRequest(prNumber).head.ref`. The zero/many cases require a
linked-PR lookup (issue → open PRs); the plan uses the existing GitHub client's
open-PR enumeration filtered to the issue.

---

## Decision 5 — No changeset-gate surprises; single orchestrator patch

**Context**: CLAUDE.md requires a newly-added `.changeset/*.md` when a diff
touches a non-test file under `packages/*/src/`.

**Decision**: All three fixes are non-test changes under
`packages/orchestrator/src/` (monitor, worker, seed executor, phase-loop). The
one cross-package touch is a `wrapUntrustedData` *import* from
`@generacy-ai/workflow-engine` — a consumer of an existing export, not a change to
that package's `src/`. So exactly one changeset is needed:
`@generacy-ai/orchestrator` **patch** (`workflow:speckit-bugfix`). No
`workflow-engine` changeset (its `src/` is not modified). No new label vocabulary
(`failed:*` and `waiting-for:remediation-limit` already ship).

**Bump level**: **patch** — defect fix, no new public exports. The
`untrusted-data-fence.ts` export is reused, not added.

---

## Test-runner and harness reuse

- **Vitest**, reusing existing harnesses:
  - `pr-feedback-monitor-service.*.test.ts` for the `failed:*` skip (SC-002).
  - `claude-cli-worker.*.test.ts` / helpers for the re-entry budget (SC-001) and
    head-ref / dup-PR path (SC-004).
  - `seed-aware-review-executor.test.ts` for seed detail fencing (SC-003).
  - `phase-loop.*.test.ts` for validate-evidence detail fencing (SC-003).
- Flag-OFF parity (SC-005) is covered by existing flag-OFF path tests, which must
  pass unchanged — all new behavior is on the flag-ON `address-pr-feedback` path
  or the monitor's `failed:*` skip (which only affects issues already carrying a
  `failed:*` label).
