# Research: Zero-question clarify phase must not strand an issue

## History of the flag

| Change | Behaviour of missing `clarifications.md` | Outcome |
|--------|------------------------------------------|---------|
| #332 ("skip clarification gate when no pending questions") | missing file ⇒ no pending ⇒ gate skips | Zero-question runs advance, but *every* fs failure also advanced — too open |
| #958 FR-007 (679d2e71, "fail closed") | **any** `readFileSync` failure ⇒ pending ⇒ pause | Unknown states pause correctly, but the zero-question normal case strands forever (#1240) |
| This fix (#1246) | ENOENT with spec dir present ⇒ no pending; all other failures ⇒ pending | Both guarantees held simultaneously |

The #958 fix assumed the no-questions path produces an *empty file* (the one `false` branch
it kept). In reality the `/clarify` playbook only writes `clarifications.md` on its
has-questions (append) path — nothing ever produces the empty file, so the kept branch was
dead code for the zero-question case. Verified on #1240: three clarify runs, zero questions
each, no file, three pauses.

## Decision 1 — Where to fix: gate helper vs playbook

**Chosen**: narrow the catch in `hasPendingClarifications`.

**Rejected**: make the `/clarify` playbook write an empty `clarifications.md` on the
no-questions branch. Spec rules this out of scope: it depends on the agent following the
prompt — exactly the drift class #958 documents — and commits an empty file into every spec
dir. (Interim workaround commit b04460f0 on this very branch did exactly this by hand, which
is the manual toil this fix removes.)

**Rejected**: special-case in `phase-loop.ts`'s `on-questions` branch. The spec's stated
assumption is the gate consumes the helper unchanged; the helper is also the unit with the
existing regression suite, so the decision table belongs there.

## Decision 2 — How to detect "file missing" vs other errors

**Chosen**: `(err as NodeJS.ErrnoException).code === 'ENOENT'` inside the existing catch.

**Rejected**: `existsSync(clarificationsPath)` probe before the read. TOCTOU between probe
and read; and it cannot distinguish EACCES (fail closed) from absent (advance) on the probe
itself — the error `code` is both race-free at the point of failure and precise.

**Rejected**: `statSync` on the spec dir inside the catch to re-confirm dir presence. The
precondition is already established: `findSpecDir` (backed by `readdirSync(specsDir)`)
returned a match immediately before, so the dir existed at decision time. A dir deleted in
the microseconds between the two calls degenerates to a state the gate cannot act on anyway,
and the next poll re-evaluates from scratch.

## Decision 3 — Logging (FR-002)

**Chosen**: optional trailing `logger?: Logger` parameter on `hasPendingClarifications`;
phase-loop passes `this.logger`.

**Rejected**: module-level logger import — the orchestrator has no ambient logger singleton;
every module in `worker/` receives a pino-style `Logger` by injection (see
`postClarifications`, `integrateClarificationAnswers` in the same file).

**Rejected**: required parameter — would force churn in the unit test suite's 8 existing
call sites for no behavioural gain; optional keeps the diff minimal.

## Decision 4 — SC-004 regression test placement

**Chosen**: extend `phase-loop.resume-gates.integration.test.ts`. It already runs the real
phase loop against a real temp checkout, writes `specs/<n>-*/clarifications.md` to disk, and
asserts on the `waiting-for:clarification` label set — the inverse case (dir present, file
absent, labels NOT applied, loop advances) slots directly into the same harness and proves
SC-001 end-to-end rather than just the helper boolean.

**Fallback** (if harness coupling proves heavy): a mocked-fs gate-branch test. Noted in the
plan, not preferred.

## Implementation patterns referenced

- `NodeJS.ErrnoException` code checks: standard Node pattern, used widely in the repo
  (e.g. control-plane app-config store's EACCES/EPERM/EROFS fallback chain).
- Existing unit suite `has-pending-clarifications.test.ts` mocks `node:fs` with `vi.mock`;
  new ENOENT case follows the same pattern but must set `err.code = 'ENOENT'` on the thrown
  error (plain `Error` has no `code` and correctly stays on the fail-closed branch).

## Key sources

- `packages/orchestrator/src/worker/clarification-poster.ts:495-519` — the function under change
- `packages/orchestrator/src/worker/phase-loop.ts:1972-1982` — sole gate consumer
- `packages/orchestrator/src/worker/__tests__/has-pending-clarifications.test.ts` — #958 SC-006 suite
- Issue #1240 — observed stranding; commits 51fc16f5 / b04460f0 / 6793466d on this branch show the manual workaround loop
- Issue #958 / commit 679d2e71 — origin of the fail-closed catch
- Issue #332 — the original skip-gate behaviour
