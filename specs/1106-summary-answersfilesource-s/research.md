# Research: Case-insensitive gateKey/epicRef repo-scope filter (#1106)

## Decision 1 — Fix strategy: case-insensitive compare (not filter removal)

**Decision**: Ship the minimal case-insensitive owner/repo comparison at
`answers-file-source.ts:648-649`; retain the repo-scope filter.

**Rationale** (clarification Q1=C): The observed failure is purely a casing
mismatch — the bound epic (`painworth/doc-intel#3`) and the affected child issues
(`Painworth/doc-intel#21`, `#23`) live in the **same** repo and differ only by a
capital `P`. Replaying the live 168-line `answers.ndjson` through the current
filter under the as-typed binding gives EMIT=4 / DROP=164; case-insensitive
comparison is unambiguously correct regardless of which producer's casing is
"right". Removing the filter is a behavior change with a measured cost (foreign-epic
no-op wake-ups on shared-`answers.ndjson` clusters) and is deferred to FR-008.

**Alternatives considered**:
- *Remove the repo-scope filter (Q1 option B)*: over-delivers foreign-epic answers
  (neutralized downstream by `gateId` matching) and incidentally fixes the
  documented cross-repo `epicRef` limitation, but causes real no-op wake-ups on the
  finetooth cluster's ≥4-epic shared answers file. Deferred to a follow-up issue.
- *Producer-side casing normalization*: out of scope (FR-006). The consumer filter
  must not depend on producers agreeing on casing; folding at compare time is
  independent of producer behavior and fixes all three producer families at once.

## Decision 2 — Fold location: at the comparison, not at parse time

**Decision**: Apply `.toLowerCase()` at the two comparison operands in
`processLine`, leaving `parseIssueRefFromGateKey` / `parseEpicRef` returning raw
captured casing.

**Rationale**: The `cross-epic drop` log line prints `scope=` and `boundEpic=` and
is more useful showing the casing as it actually appeared on disk. Confining the
change to the predicate keeps the diff to two lines and makes the regression
guard (restore `!==` → test fails) precise. Mutating the parsed structs would ripple
into the log message and any future consumer of the parsed scope.

**Alternatives considered**:
- *Normalize inside the parse functions*: broader blast radius, alters log output,
  no benefit for this single-consumer predicate.

## Decision 3 — `toLowerCase` vs. locale-aware folding

**Decision**: Plain `String.prototype.toLowerCase()`.

**Rationale**: GitHub owner and repo names are restricted to ASCII
(`[A-Za-z0-9-_.]`), so `toLowerCase()` is a correct, locale-independent case fold.
`toLocaleLowerCase` / `localeCompare` would add locale-sensitivity (e.g. Turkish
dotless-i) with no upside for an ASCII-only namespace.

## Decision 4 — Audit scope (FR-007 / Q2=B)

**Decision**: Bound the audit to owner/repo string comparisons in the doorbell +
cockpit **consumer** (answer-delivery) path. Conclusion: the only case-sensitive
owner/repo comparison in that path is `answers-file-source.ts:648-649`.

**Evidence**: `grep` for `.owner`/`.repo` `===`/`!==` across
`packages/generacy/src/cli/commands/cockpit/`:
- `doorbell/answers-file-source.ts:648-649` — the fix site (consumer path).
- `doorbell/webhook-target-resolver.ts:28` — null/empty guard, not a case compare.
- `queue.ts:228`, `queue.ts:453`, `queue.ts:245` — `cockpit queue` dispatch
  (producer side; not answer consumption).
- `scope/writer.ts:53` — scope writer (producer side).
- `watch/poll-loop.ts:45` — watch polling, refs already number-scoped.

The baseline `toLowerCase` grep across `dist/cli/commands/cockpit/` (from the spec)
returned only three unrelated hits, confirming no existing case normalization. No
sibling fix is warranted; `queue.ts` / `scope/writer.ts` are outside the bounded
consumer-path audit and left untouched.

## Implementation patterns / references

- Existing filter + log at `answers-file-source.ts:636-655`.
- Existing regression coverage to extend:
  `doorbell/__tests__/answers-file-source.unit.test.ts:437` (foreign-owner drop) and
  `:465` (child-issue delivered). New cases mirror these with mixed-case refs.
- `fs` façade + `useFsWatch: false` deterministic replay pattern in
  `answers-file-source.replay.test.ts` for optional SC-001 multi-line fixture.
- Changeset shape: mirror `.changeset/1005-adopt-existing-smee-channel.md`
  (single package, `patch`, prose describing the behavior change).
