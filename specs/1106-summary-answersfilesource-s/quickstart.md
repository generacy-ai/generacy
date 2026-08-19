# Quickstart: Case-insensitive gateKey/epicRef repo-scope filter (#1106)

## What this fixes

On a multi-repo cluster, `/cockpit:auto` gate answers whose `gateKey` owner/repo
differs from the bound `epicRef` only by letter case (e.g. `Painworth/doc-intel#23`
vs. bound epic `painworth/doc-intel#3`) were silently dropped as "cross-epic". The
doorbell never fired and operators had to relay answers by hand. This fix makes the
owner/repo comparison case-insensitive.

## The change

Single file: `packages/generacy/src/cli/commands/cockpit/doorbell/answers-file-source.ts`
(the `processLine` repo-scope filter, ~`:646-655`). Lowercase both sides of the
owner and repo comparison. Two lines + a comment. No wire-format, `gateId`, or
channel changes.

## Build & test

```bash
pnpm install
pnpm --filter @generacy-ai/generacy build

# Run the doorbell answers-file source suites
pnpm --filter @generacy-ai/generacy test answers-file-source
```

Expected: existing suites pass unchanged (SC-004); new case-divergence regression
cases pass (SC-002); the genuine-foreign-repo case still drops + logs (SC-003).

## Verifying the fix behaviorally

The `AnswersFileSource` is unit-tested through its `fs` façade with
`useFsWatch: false` for deterministic replay — no real cluster needed.

1. Construct `AnswersFileSource` with `epicRef: 'painworth/x#1'`.
2. Feed an answer line keyed `Painworth/x#1:clarification:batch-1`.
3. Assert exactly one `gate-answer` event is emitted and no `cross-epic drop`
   `info` log fires.
4. Feed `painworth/y#1:…` (genuinely different repo) → asserted dropped + logged.

See `doorbell/__tests__/answers-file-source.unit.test.ts` (existing cross-repo case
at `:437`, child-issue-delivered case at `:465`) for the harness pattern to copy.

## Changeset (required for CI)

```
.changeset/1106-case-insensitive-repo-scope.md
```

```md
---
"@generacy-ai/generacy": patch
---

Cockpit doorbell: compare gateKey/epicRef owner and repo case-insensitively (#1106).

GitHub owner/repo names are case-insensitive, but the AnswersFileSource repo-scope
filter compared them with a raw `!==`. On multi-repo clusters this silently dropped
every child-issue gate answer whose canonical casing differed from the bound epic
ref, so the /cockpit:auto doorbell never fired. Both sides of the owner/repo
comparison are now lowercased; issue-number matching and foreign-repo drop behavior
are unchanged.
```

## Troubleshooting

- **Answers still dropped after the fix**: confirm the drop is casing-only. If
  owner/repo differ beyond case, that is a genuine foreign-repo answer and is
  correctly dropped (FR-003). Check the `cross-epic drop` `info` log — it prints
  `scope=` and `boundEpic=` with observed casing.
- **CI fails on changeset gate**: ensure `.changeset/1106-*.md` is a *newly added*
  file in the PR diff (the gate greps `--diff-filter=A`).

## Follow-up (not in this PR)

A separate issue tracks removing the repo-scope filter entirely / adding cross-repo
`epicRef` support (clarification Q1=C option B, FR-008).
