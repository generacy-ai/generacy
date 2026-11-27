# Contract: `hasPendingClarifications(checkoutPath, issueNumber, logger?)`

Consumer: `phase-loop.ts` `on-questions` gate — `true` ⇒ gate activates
(`waiting-for:clarification` + `agent:paused`); `false` ⇒ gate skips, phase loop advances.

## Guarantees

1. **Zero-question advance (new)**: if `specs/<issue>-*/` resolves via `findSpecDirName` and
   reading `clarifications.md` fails with `code === 'ENOENT'`, returns `false` and emits one
   info-level log `{ issueNumber, clarificationsPath }` with message
   `no clarifications.md — clarify produced no questions; gate will skip`.
2. **Fail-closed preserved (#958 FR-007)**: returns `true` for
   - missing/unresolvable spec dir,
   - any read error whose `code` is not `'ENOENT'` (including errors with no `code`),
   - non-empty content parsing to zero questions,
   - any parsed question whose answer is pending (per `isPendingAnswerValue`).
3. **Empty-file advance (unchanged)**: content trimming to `''` returns `false`.
4. **Purity**: no writes, no network, no label mutations — a read-only predicate. The
   optional logger is the only side-channel.
5. **Signature compatibility**: `logger` is optional; existing two-argument call sites
   compile and behave identically except for the ENOENT branch result.

## Non-goals

- Does not create `clarifications.md`.
- Does not distinguish "clarify never ran" from "clarify ran and found nothing" — by design:
  phase ordering guarantees clarify ran before the clarify-phase gate is evaluated.
