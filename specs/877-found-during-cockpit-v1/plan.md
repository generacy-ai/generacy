# Implementation Plan: `wizard-credentials.env` trailing newline fix

**Feature**: Terminate `formatEnvFile()` output with `\n` so naive appends don't corrupt the last entry.
**Branch**: `877-found-during-cockpit-v1`
**Status**: Complete
**Issue**: [#877](https://github.com/generacy-ai/generacy/issues/877)
**Workflow**: speckit-bugfix

## Summary

`formatEnvFile()` in `packages/control-plane/src/services/wizard-env-writer.ts` joins env entries with `\n` but omits a terminating newline. Any subsequent append (operator repair, script, future writer) silently concatenates onto the previous line, corrupting the last key/value and losing the appended key. Fix is a one-line change plus two regression tests locking in the invariant.

The bug was observed live on the sniplink test cluster during a manual repair:

```
GH_EMAIL=christrudelpw@users.noreply.github.comCLUSTER_ACTING_LOGIN=generacy-ai
```

Both `GH_EMAIL` (polluted value) and `CLUSTER_ACTING_LOGIN` (never a valid var) are lost. Post-activation scripts source the file and see nothing wrong — the failure is silent.

## Technical Context

- **Language**: TypeScript (Node.js >=22, ESM)
- **Package**: `@generacy-ai/control-plane`
- **Test framework**: Vitest (existing `packages/control-plane/__tests__/services/wizard-env-writer.test.ts`)
- **Dependencies**: none added; pure-function change in existing module
- **Runtime surface**: `writeWizardEnvFile()` is invoked by the `bootstrap-complete` lifecycle handler (`packages/control-plane/src/routes/lifecycle.ts`) and produces `/var/lib/generacy/wizard-credentials.env` (mode 0600) consumed by `entrypoint-post-activation.sh` in cluster-base.

## Root Cause Location

- `packages/control-plane/src/services/wizard-env-writer.ts:83-86` — `formatEnvFile()`:
  ```typescript
  export function formatEnvFile(entries: EnvEntry[]): string {
    if (entries.length === 0) return '';
    return entries.map((e) => `${e.key}=${e.value}`).join('\n');
  }
  ```
- Callsite at `wizard-env-writer.ts:141`: `await fs.writeFile(envFilePath, formatEnvFile(entries), { mode: 0o600 });` writes the un-terminated string verbatim.

## Fix Design

**Single-line change** — append `+ '\n'` to the non-empty branch of `formatEnvFile()`:

```typescript
export function formatEnvFile(entries: EnvEntry[]): string {
  if (entries.length === 0) return '';
  return entries.map((e) => `${e.key}=${e.value}`).join('\n') + '\n';
}
```

Empty-entries branch keeps existing behaviour (`''`) per FR-002 — no diff churn, still safe because there's no last entry to corrupt.

## Project Structure

Files touched:

| Path | Change |
|------|--------|
| `packages/control-plane/src/services/wizard-env-writer.ts` | Append `+ '\n'` at line 85. |
| `packages/control-plane/__tests__/services/wizard-env-writer.test.ts` | Update existing `formatEnvFile` two-entry assertion (line 372) to expect trailing `\n`. Add two new regression tests: (1) written-file-ends-with-newline, (2) naive-append-parses-cleanly. |

No new files, no schema changes, no API changes, no dependencies.

## Test Plan

1. **Unit — `formatEnvFile` trailing newline (FR-001, FR-004)**
   Update existing assertion at `wizard-env-writer.test.ts:372` from `'KEY1=val1\nKEY2=val2'` to `'KEY1=val1\nKEY2=val2\n'`. Empty-array test at line 364 unchanged (FR-002).

2. **Unit — written file's final byte is `\n` (FR-004)**
   New test: mock `credentials.yaml` + backend with two credentials, call `writeWizardEnvFile()` against a temp path, read the file, assert `contents.endsWith('\n')`.

3. **Unit — naive append parses to distinct keys (FR-005, SC-003)**
   New test: run `writeWizardEnvFile()`, then `fs.appendFile(envFilePath, 'NEW_KEY=value\n')`, then parse the file line-by-line (`\n`-split, `KEY=VALUE` split-on-first-`=`), assert every original key retains its exact value AND `NEW_KEY` maps to `value`. This exact scenario reproduces the sniplink corruption pattern.

4. **File mode regression (FR-003)**
   No test change needed — existing coverage asserts mode `0o600`. New tests must not override; use `fs.writeFile` on the produced file only in the naive-append test.

## Constitution Check

No `.specify/memory/constitution.md` present in repo. N/A.

Cross-cutting considerations:
- **Scope discipline** (CLAUDE.md "Don't add features"): implementation is a single `+ '\n'` — no refactor of `formatEnvFile`, no changes to `mapCredentialToEnvEntries`, no changes to `writeWizardEnvFile()` call flow, no file-mode/ownership changes. Aligns with out-of-scope carve-outs in spec §"Out of Scope".
- **No comments unless non-obvious** (CLAUDE.md): the newline invariant is obvious; no explanatory comment required in `formatEnvFile()`.
- **Backwards compatibility**: sourced env files with a trailing newline are POSIX-standard; downstream `entrypoint-post-activation.sh` `source`ing is unaffected. No consumer regresses.
- **`CLUSTER_ACTING_LOGIN`**: explicitly out of scope per spec — superseded by [#878](https://github.com/generacy-ai/generacy/issues/878).

## Risks & Mitigations

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| A downstream consumer relied on the missing newline. | Very low — POSIX-standard files end with `\n`; `source`/`bash` treat both cases identically. | Full control-plane test suite (SC-002) must stay green. |
| A future writer removes the trailing `\n` again. | Low. | Regression test FR-004 fails CI if the invariant is dropped. |
| Empty-credentials path (`entries.length === 0`) differs from non-empty path. | Trivial. | FR-002 explicitly permits both; existing empty-string test at line 364 stays. |

## Success Criteria (from spec)

- **SC-001**: `pnpm --filter @generacy-ai/control-plane test wizard-env-writer` green.
- **SC-002**: Full control-plane suite green — zero behavioural regression.
- **SC-003**: Regression test exercising naive append + parse asserts distinct, correct keys.

## Next Step

`/speckit:tasks` to generate the task list.
