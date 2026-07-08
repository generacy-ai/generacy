# Contract: `GhCliWrapper.getPullRequestCheckRuns`

**File**: `packages/cockpit/src/gh/wrapper.ts:587-606`

## Signature

```ts
async getPullRequestCheckRuns(
  repo: string,
  prNumber: number,
): Promise<CheckRunSummary[]>
```

Unchanged from post-#855.

## Behavior matrix (post-fix)

| gh exit | gh stderr contains `no checks reported` (case-insensitive) | Wrapper behavior                                                      |
|---------|------------------------------------------------------------|-----------------------------------------------------------------------|
| `0`     | (any)                                                       | Parse `stdout` via `parseCheckRuns`; return the list. No log.        |
| `1`     | yes                                                         | **Return `[]`.** No log. No throw. (NEW in #857.)                     |
| `1`     | no                                                          | `logger.warn({ repo, prNumber, ghStderr }, 'gh pr checks failed')`; throw `Error('gh pr checks failed (exit 1): ' + stderr)`. |
| `2`+    | (any)                                                       | Same as `exit 1` + `no === false`: warn + throw.                     |

The gh process failure modes covered:
- **exit 0**: normal — one or more checks reported, stdout is valid JSON array.
- **exit 1 + `no checks reported` in stderr**: repo/branch has no CI reporting → return `[]`.
- **exit 1 + other stderr**: one or more checks failed OR gh call itself failed (auth, permissions, network via gh's HTTP client, malformed response) → warn + throw.
- **exit ≥ 2**: gh's own process error → warn + throw.

## Detection substring — invariants

- **Case-insensitive** (`stderr.toLowerCase().includes(...)`).
- **Fixed literal**: `no checks reported`.
- **No anchoring**: substring test, not `startsWith`. Robust to gh's leading `!` prefix, TTY color codes, or wrapping quotes.
- **No regex**: deliberate — no capture groups, no anchor edge cases.
- **Fallback direction on non-match is throw** (fail-loud). A gh version that changes the exact wording will surface as a hard merge failure + wrapper warn log — an operator can grep the log, see the actual stderr, and update the substring in a one-line fix.

## Preserved semantics from #855

- `logger.warn` structured object shape: `{ repo, prNumber, ghStderr }` (`ghStderr` is the trimmed stderr).
- The wrapper's `logger` is injectable via constructor DI (`logger?: { warn(obj, msg): void }`); default is a `console.warn` shim.
- The throw path preserves the exact error message format: `` `gh pr checks failed (exit ${exitCode}): ${trimmedStderr}` ``.
- No exceptions leak from `stderr.trim()` — string operations only, no I/O in the error path.

## Removed semantics

- **None**. The wrapper's failure surface is strict superset of post-#855: same log lines, same throw path, plus one new short-circuit branch.

## Regression tests (in `packages/cockpit/src/__tests__/gh-wrapper.test.ts`)

1. **Existing positive test** — non-empty check-run list parses correctly. Unchanged.
2. **Existing negative test** — real failure (`stderr === 'Unknown JSON field: "foo"'`, exit 1) throws + logs warn once. Unchanged from post-#855.
3. **NEW positive test**: stderr `no checks reported on the '002-phase-1-foundation-part' branch`, exit 1 → resolves `[]`, `logger.warn` NOT called.
4. **NEW positive test**: same stderr with case variation (`No Checks Reported`) → still resolves `[]` (case-insensitive detection).
5. **NEW negative test**: stderr `Some other error mentioning checks` → still throws + logs warn (substring `no checks reported` is fixed literal, not any-mention-of-checks).

## Not in scope

- Changes to `parseCheckRuns` (unchanged from #855).
- Changes to `normalizeCheckState` (unchanged from #855).
- Changes to the wrapper's raw-JSON schemas (unchanged).
- Changes to the wrapper's constructor DI (unchanged).
