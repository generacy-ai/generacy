# Feature Specification: `wizard-credentials.env` written without trailing newline

**Branch**: `877-found-during-cockpit-v1` | **Date**: 2026-07-09 | **Status**: Draft | **Issue**: [#877](https://github.com/generacy-ai/generacy/issues/877) | **Workflow**: speckit-bugfix

## Summary

`wizard-env-writer` (control-plane) writes `/var/lib/generacy/wizard-credentials.env` without a terminating newline. Any later append — by an operator, a script, or a future writer adding a key — silently corrupts the last key/value pair. The entrypoint sources the file and the corrupted var simply doesn't exist, with no error surfaced anywhere.

Observed live during a manual repair on the sniplink test cluster:

```
GH_EMAIL=christrudelpw@users.noreply.github.comCLUSTER_ACTING_LOGIN=generacy-ai
```

The merged value both breaks the existing key (`GH_EMAIL` value is polluted) and loses the new one (`CLUSTER_ACTING_LOGIN` never becomes a valid env var).

## Root Cause

`packages/control-plane/src/services/wizard-env-writer.ts:83-86` — `formatEnvFile()` joins entries with `\n` but does not append a trailing newline:

```typescript
export function formatEnvFile(entries: EnvEntry[]): string {
  if (entries.length === 0) return '';
  return entries.map((e) => `${e.key}=${e.value}`).join('\n');
}
```

`fs.writeFile` at `wizard-env-writer.ts:141` then writes the result verbatim, leaving the file without a POSIX-standard final newline.

## Fix

Terminate the file with `\n` in the writer. Add a regression test asserting:
1. The written file ends with `\n`.
2. A subsequent naive append (e.g., `echo "NEW=value" >> file`) produces a file that parses to distinct, correct key/value pairs.

## User Stories

### US1: Operator or script appends to `wizard-credentials.env` without corruption

**As a** cluster operator (or a future writer inside control-plane),
**I want** appending a new line to `/var/lib/generacy/wizard-credentials.env` to produce a valid, parseable env file,
**So that** post-activation scripts sourcing the file see every key as its own env var — including the last one.

**Acceptance Criteria**:
- [ ] `writeWizardEnvFile()` produces a file whose final byte is `\n`.
- [ ] `echo "NEW_KEY=value" >> /var/lib/generacy/wizard-credentials.env` followed by `source` results in both the previous last key and `NEW_KEY` being present with their intended values.
- [ ] Empty credential set (no entries) still produces a file that either is empty or ends with `\n` — never partially written.

### US2: No silent data loss when future writers are added

**As a** future contributor adding a new writer that appends to the env file,
**I want** the existing file format to guarantee a terminating newline,
**So that** my appends land as new lines rather than being concatenated onto the previous key's value.

**Acceptance Criteria**:
- [ ] Regression test locks in the trailing-newline invariant so a future change that removes it fails CI.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `formatEnvFile(entries)` MUST return a string terminated by `\n` when `entries.length > 0`. | P1 | One-line change: append `+ '\n'` to the join. |
| FR-002 | `formatEnvFile([])` MAY return an empty string (existing behaviour) OR a single `\n` — either is safe. | P2 | Preserve existing behaviour to keep the diff minimal. |
| FR-003 | `writeWizardEnvFile()` MUST write the file with mode `0600` (unchanged). | P1 | Regression guard — the fix must not alter permissions. |
| FR-004 | A regression test MUST assert the written file's final byte is `\n` for at least one non-empty case. | P1 | |
| FR-005 | A regression test MUST assert that appending a line via naive concatenation (`existing + 'NEW=v\n'`) parses to a superset of the original keys plus `NEW`. | P1 | Captures the actual bug shape from the sniplink incident. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Trailing-newline regression test passes. | Green | `pnpm --filter @generacy-ai/control-plane test wizard-env-writer` |
| SC-002 | Zero behavioural change for readers (sourced env vars unchanged). | 0 test failures elsewhere | Full control-plane test suite green. |
| SC-003 | Corruption pattern from the sniplink incident cannot recur under naive append. | Regression test exercises append + parse and asserts distinct keys. | Test in `packages/control-plane/__tests__/services/wizard-env-writer.test.ts`. |

## Assumptions

- Downstream consumers (`entrypoint-post-activation.sh` sourcing the file) tolerate a trailing empty line — this is standard POSIX behaviour, no consumer will regress.
- No other writer currently reads-modify-writes this file; the only append pattern in the wild is manual/ad-hoc during repairs (which is exactly what the bug affected).

## Out of Scope

- **`CLUSTER_ACTING_LOGIN` env-var plumbing** — the original issue proposed this; it is superseded by [#878](https://github.com/generacy-ai/generacy/issues/878) (GraphQL `viewerDidAuthor` replaces the configured-identity comparison and retires the env var entirely). Do not implement.
- Refactoring `formatEnvFile()` beyond adding the trailing newline.
- Changes to `credentials.yaml` parsing, backend fetch, or the credential-to-env-name mapping (`mapCredentialToEnvEntries`).
- Changes to file mode, ownership, or path.

---

*Generated by speckit*
