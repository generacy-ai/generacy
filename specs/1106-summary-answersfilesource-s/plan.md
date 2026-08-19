# Implementation Plan: Case-insensitive gateKey/epicRef repo-scope filter

**Feature**: Cockpit doorbell delivers gate answers when `gateKey` and `epicRef` differ only by owner/repo letter case
**Branch**: `1106-summary-answersfilesource-s`
**Status**: Complete
**Issue**: [generacy-ai/generacy#1106](https://github.com/generacy-ai/generacy/issues/1106) | **Workflow**: `speckit-bugfix`

## Summary

`AnswersFileSource`'s repo-scope filter compares the answer `gateKey` owner/repo
against the bound `epicRef` owner/repo with a raw case-sensitive `!==`
(`answers-file-source.ts:648-649`). GitHub owner/repo names are case-insensitive
and the gate producers disagree on casing (operator-typed vs. lowercase vs.
GitHub-canonical), so on multi-repo clusters every human gate answer for the
epic's child issues is silently dropped as "cross-epic" and the `/cockpit:auto`
doorbell never fires.

The fix is minimal and consumer-side only (clarification Q1=C): lowercase both
sides of the owner and repo comparison so two refs differing only in letter case
are treated as the same repo. The repo-scope filter is retained — genuine
foreign-repo answers keep today's dropped-and-logged disposition. The issue-number
comparison is unchanged (only the string owner/repo comparison semantics change,
FR-005). A follow-up issue is filed for the broader filter-removal / cross-repo
`epicRef` option (FR-008).

Per clarification Q2=B (FR-007), the doorbell + cockpit **consumer** path was
audited for other case-sensitive owner/repo comparisons. Result: the single site
at `answers-file-source.ts:648-649` is the only such comparison in that path. The
`queue.ts` (`:228`, `:453`) and `scope/writer.ts:53` comparisons are on the
dispatch/producer side (the `cockpit queue` command and scope writer), not the
answer-consumption path, and are out of the bounded audit scope. No additional
sites require a fix.

## Technical Context

- **Language / runtime**: TypeScript, ESM, Node >=22.
- **Package**: `@generacy-ai/generacy` (CLI). Fix file:
  `packages/generacy/src/cli/commands/cockpit/doorbell/answers-file-source.ts`.
- **Test framework**: Vitest. Existing suites:
  `doorbell/__tests__/answers-file-source.unit.test.ts` (already has a
  `cross-repo line … dropped` case at `:437` and a child-issue-delivered case at
  `:465`) and `answers-file-source.replay.test.ts`.
- **Dependencies**: none added. Pure string-comparison change plus tests.
- **No wire-format change**: the answers-file NDJSON shape, `gateId` derivation,
  and the `cluster.cockpit` channel are untouched (spec Out of Scope).

## Design

### The change (FR-001, FR-002, FR-005)

At `answers-file-source.ts:646-655`, replace the two raw string comparisons with
case-folded comparisons. GitHub owner/repo names are ASCII, so
`String.prototype.toLowerCase()` is a correct and locale-independent fold (no
`localeCompare`/`toLocaleLowerCase` needed). The `number` comparison is not part
of this predicate and stays as-is.

```ts
const gateScope = parseIssueRefFromGateKey(gateLine.gateKey);
if (
  gateScope != null &&
  (gateScope.owner.toLowerCase() !== this.epicScope.owner.toLowerCase() ||
    gateScope.repo.toLowerCase() !== this.epicScope.repo.toLowerCase())
) {
  this.logger.info?.(/* cross-epic drop … unchanged */);
  return;
}
```

The `cross-epic drop` log line (which prints `scope=` and `boundEpic=` with the
original as-observed casing) is preserved verbatim so operator-facing diagnostics
and existing log-assertion tests are unaffected.

The comment block at `:636-644` is updated with one sentence noting the
comparison is case-insensitive per GitHub semantics (WHY the fold exists — a
non-obvious invariant a future refactor could silently undo).

### Why not normalize at parse time

`parseIssueRefFromGateKey` and `parseEpicRef` return the raw captured owner/repo.
Folding at the single comparison site (rather than mutating the parsed structs)
keeps the log line's observed casing intact and confines the behavior change to
exactly the predicate the bug lives in. FR-006 requires the consumer-side filter
not depend on producer casing agreement — folding at compare time satisfies this
regardless of which producer wrote the gateKey.

### Audit result (FR-007)

Bounded to owner/repo string comparisons in the doorbell + cockpit consumer path:

| Site | Path role | In scope? | Action |
|---|---|---|---|
| `doorbell/answers-file-source.ts:648-649` | answer consumer (doorbell) | yes | fix (this PR) |
| `doorbell/webhook-target-resolver.ts:28` | doorbell | n/a — null/empty guard, not a case comparison | none |
| `queue.ts:228`, `queue.ts:453` | `cockpit queue` dispatch (producer) | no — not consumer path | none |
| `scope/writer.ts:53` | scope writer (producer) | no — not consumer path | none |
| `watch/poll-loop.ts:45` | watch polling (already number-scoped by resolved refs) | no — not answer consumer | none |

No sibling case-sensitive comparison exists in the doorbell answer-delivery path.

## Project Structure

```
packages/generacy/src/cli/commands/cockpit/doorbell/
  answers-file-source.ts                         # MODIFIED: case-fold at :646-655 + comment
  __tests__/
    answers-file-source.unit.test.ts             # MODIFIED: add case-divergence regression cases (FR-004)
    answers-file-source.replay.test.ts           # (optional) mixed-case replay fixture for SC-001

.changeset/
  1106-case-insensitive-repo-scope.md            # NEW: @generacy-ai/generacy patch
```

## Tests (FR-004, US3)

Add to `answers-file-source.unit.test.ts`, alongside the existing cross-repo
(`:437`) and child-issue (`:465`) cases:

1. **Forward divergence (SC-002)**: bind `epicRef: 'painworth/x#1'`, feed a line
   keyed `Painworth/x#1:clarification:…` → exactly one event emitted, no
   `cross-epic drop` log.
2. **Reverse divergence (SC-002)**: bind `epicRef: 'Painworth/x#1'`, feed a line
   keyed `painworth/x#1:…` → emitted.
3. **Repo-name case divergence**: bind `owner/Repo#1`, feed `owner/repo#1:…` →
   emitted (proves the fold covers the repo component, not just owner).
4. **Genuine foreign repo unchanged (SC-003)**: bind `painworth/x#1`, feed
   `painworth/y#1:…` (different repo beyond casing) → still dropped + logged.
5. **Foreign owner unchanged**: `other/x#1` vs `painworth/x#1` → dropped.

SC-004 (no change for uniformly-lowercase single-repo clusters) is covered by the
existing suite passing unmodified. SC-001 (replay of the observed mixed-case
same-repo pattern → 0 same-repo drops) is satisfied by cases 1–3; optionally add a
small multi-line mixed-case fixture to the replay suite for closer fidelity to the
live `answers.ndjson`.

A regression test must fail if the `!==` (non-folded) comparison is restored — the
forward/reverse divergence cases (1–2) provide exactly that guard.

## Changeset (CI gate)

`.changeset/1106-case-insensitive-repo-scope.md` — `@generacy-ai/generacy`
**patch** (defect fix per `workflow:speckit-bugfix`; no new public export surface).
Must be a newly added file in the PR diff.

## Follow-up (FR-008)

File a separate issue for removing the repo-scope filter entirely / adding
cross-repo `epicRef` support (clarification Q1=C option B). Motivation to keep it
separate: the finetooth cluster's single `answers.ndjson` carries gates from ≥4
distinct epics, so filter removal introduces real foreign-epic no-op wake-ups that
deserve their own discussion. Filing the issue is part of this work; implementing
it is not.

## Constitution Check

No `.specify/memory/constitution.md` present in the repo — no constitution gates
to evaluate. Change is a single-site, additive-safe bug fix with regression
coverage; consistent with existing doorbell code patterns.
