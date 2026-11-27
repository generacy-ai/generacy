# Implementation Plan: Zero-question clarify phase must not strand an issue

**Feature**: ENOENT on `clarifications.md` (spec dir present) must read as "no pending questions" so the `on-questions` gate skips and the workflow advances to `plan`
**Branch**: `1246-problem-if-clarify-phase`
**Status**: Complete
**Issue**: [#1246](https://github.com/generacy-ai/generacy/issues/1246) | **Workflow**: speckit-bugfix

## Summary

`hasPendingClarifications` (`packages/orchestrator/src/worker/clarification-poster.ts:495`)
currently returns `true` on **any** `readFileSync` failure (#958 FR-007 fail-closed). But a
missing `clarifications.md` with the spec dir present is the *normal* output of a
zero-question clarify run — the `/clarify` playbook only writes the file on its has-questions
path. The blanket catch therefore strands unambiguous specs at `waiting-for:clarification`
forever (observed on #1240).

The fix narrows the catch: distinguish `ENOENT` (file missing, spec dir already confirmed
present by `findSpecDir`) from every other read error. `ENOENT` → `false` (gate skips,
workflow advances); everything else keeps the #958 fail-closed behaviour. One function, one
branch, plus test updates.

## Technical Context

- **Language**: TypeScript (ESM, Node >= 22)
- **Package**: `packages/orchestrator` (vitest for tests)
- **No new dependencies.** `node:fs` error `code` property (`NodeJS.ErrnoException`) is the
  only discriminator needed.
- **Changeset**: required (non-test `src/` change in `packages/orchestrator`) — `patch`
  bump (defect fix, speckit-bugfix workflow).

## Design

### Change 1 — `hasPendingClarifications` ENOENT branch (FR-001..FR-004)

File: `packages/orchestrator/src/worker/clarification-poster.ts` (~L495-519)

Current:

```ts
  let content: string;
  try {
    content = readFileSync(clarificationsPath, 'utf-8');
  } catch {
    return true;
  }
```

New behaviour (decision table in `contracts/has-pending-clarifications.md`):

```ts
export function hasPendingClarifications(
  checkoutPath: string,
  issueNumber: number,
  logger?: Logger,
): boolean {
  ...
  let content: string;
  try {
    content = readFileSync(clarificationsPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // Spec dir exists (findSpecDir returned it above) but no
      // clarifications.md — the normal output of a zero-question clarify
      // run; the playbook only writes the file on its has-questions path.
      logger?.info(
        { issueNumber, clarificationsPath },
        'no clarifications.md — clarify produced no questions; gate will skip',
      );
      return false;
    }
    return true; // EACCES / EIO / … — unknown state, fail closed (#958 FR-007)
  }
  ...
}
```

Key points:

- **Spec-dir presence is already established** before the read: `findSpecDir` returns
  `undefined` (→ `true`, FR-003) when `specs/` is unreadable or no `<issue>-*` dir matches.
  Reaching the `readFileSync` call means the dir exists, so no extra `existsSync` probe is
  needed — ENOENT at this point can only mean the file itself is missing. (The ENOENT could
  in principle come from the spec dir being deleted between `readdirSync` and `readFileSync`;
  that race is acceptable — it is semantically identical to a zero-question state for gate
  purposes and cannot strand anything.)
- **Optional `logger?: Logger` third parameter** (the pino-style `Logger` from
  `./types.js`, already imported in this file) satisfies FR-002 without breaking the two
  existing callers. The gate call site passes the phase-loop logger; test callers may omit it.
- All other branches are untouched: missing spec dir → `true`, non-ENOENT error → `true`,
  non-empty-zero-parse → `true`, empty file → `false`, unanswered questions → `true`.

### Change 2 — gate call site passes the logger (FR-002)

File: `packages/orchestrator/src/worker/phase-loop.ts` (~L1976)

```ts
gateActive = hasPendingClarifications(context.checkoutPath, context.item.issueNumber, this.logger);
```

No other change to the gate — the `on-questions` branch stays a pure boolean check (spec
assumption: only the helper's missing-file branch changes).

### Change 3 — update #958 unit tests (SC-003) + new cases

File: `packages/orchestrator/src/worker/__tests__/has-pending-clarifications.test.ts`

- The existing "readFileSync throws" test uses `new Error('EACCES: permission denied')`
  (no `code` property) — keep it returning `true`, but set `(err as any).code = 'EACCES'`
  explicitly so the test exercises the real discriminator, and add an un-coded plain
  `Error` case (also `true` — no `code` ≠ ENOENT).
- **New**: readFileSync throws with `code: 'ENOENT'`, spec dir present → `false` (FR-001).
- All other existing assertions (missing dir, no matching subdir, non-empty-zero-parse,
  empty file, pending/answered/placeholder) remain unchanged — they pin FR-003..FR-006.

### Change 4 — regression test at the gate level (SC-004)

File: `packages/orchestrator/src/worker/__tests__/phase-loop.resume-gates.integration.test.ts`
(extend) — this suite already drives the real `on-questions` gate against a real temp
checkout (it writes `specs/<issue>-*/clarifications.md` on disk and asserts pause labels).

New case: create the spec dir but write **no** `clarifications.md`; run the clarify phase;
assert:
- `waiting-for:clarification` / `agent:paused` are **not** applied (gate skipped), and
- the loop proceeds past clarify (advances toward `plan`),
- without any `completed:clarification` override label.

If extending that harness proves disproportionate, the fallback is a focused gate-branch test
that stubs only fs (same mock pattern as the unit suite) and asserts the gate boolean +
skip log — but the integration suite is the preferred home since it proves the end-to-end
SC-001 claim.

### Change 5 — changeset

New file `.changeset/1246-zero-question-clarify-gate.md`:

```md
---
"@generacy-ai/orchestrator": patch
---

Treat a missing clarifications.md (spec dir present) as "no pending questions" so a zero-question clarify phase advances to plan instead of stranding at waiting-for:clarification. Non-ENOENT read errors, missing spec dirs, and unparseable files still fail closed.
```

## Project Structure (files touched)

```
packages/orchestrator/src/worker/clarification-poster.ts        # ENOENT branch + logger param
packages/orchestrator/src/worker/phase-loop.ts                   # pass this.logger (one line)
packages/orchestrator/src/worker/__tests__/has-pending-clarifications.test.ts  # SC-003 updates + ENOENT case
packages/orchestrator/src/worker/__tests__/phase-loop.resume-gates.integration.test.ts  # SC-004 regression case
.changeset/1246-zero-question-clarify-gate.md                    # patch changeset
```

## Constitution Check

No `.specify/memory/constitution.md` exists in this repo — no constitution gates to verify.
Repo-level invariants from `CLAUDE.md` respected: no repo-root agent-context file changes;
changeset added as part of implementation; narrow bugfix scope (speckit-bugfix risk profile).

## Risks

- **Behavioural widening**: ENOENT → advance re-opens a sliver of the #958 surface. Bounded
  because `findSpecDir` success is a precondition — the "specify output vanished" anomaly
  (whole dir gone) still pauses. The spec explicitly accepts this trade (US2 / FR-003..FR-005).
- **Mocked-fs tests don't set `code`**: the existing unit suite throws plain `Error`s. Plain
  errors have no `code`, so they keep failing closed — the suite stays green pre-update, and
  the update makes the discriminator explicit rather than incidental.

## Next Step

Run `/speckit:tasks` to generate the task list.
