# Contract: `json-field-drift.test.ts` (post-#855)

**Module**: `packages/cockpit/src/gh/__tests__/json-field-drift.test.ts`
**Kind**: vitest suite (colocated with `wrapper.ts` per Q3→A)
**Purpose**: Ensure no `gh` `--json` field list in `packages/cockpit/src/gh/wrapper.ts` requests a name the pinned `gh` binary rejects. Fail the CI run when drift is introduced (FR-006, FR-007, FR-008; SC-004, SC-005).

## Test file location

```
packages/cockpit/src/gh/__tests__/json-field-drift.test.ts
```

Vitest's default glob (`**/*.test.ts`) picks it up. Colocated with `wrapper.ts` (its parent dir) so the guard travels with the code. No `vitest.config.ts` change needed.

## Suite gate

```ts
const hasGhBinary = (() => {
  try {
    return spawnSync('gh', ['--version'], { encoding: 'utf-8' }).status === 0;
  } catch {
    return false;
  }
})();

describe.runIf(hasGhBinary)('gh --json field drift', () => { … });
```

- `hasGhBinary` is evaluated once at module load (top-level; not inside any hook).
- ENOENT / permission errors from `spawnSync` fall through to `false`. Any thrown error is caught.
- On dev machines without `gh`: the entire suite skips visibly (vitest prints a "skipped" marker with `runIf` context).
- In CI: the workflow provisions `gh`, `hasGhBinary === true`, the suite runs.

Fallback for vitest <1.6: `describe.skipIf(!hasGhBinary)` — semantically identical.

## Extraction contract (FR-007, SC-005)

Extractor is a pure function operating on the UTF-8 source of `wrapper.ts`:

```ts
function extractJsonFieldLists(source: string): {
  matches: JsonFieldListSite[];
  nonLiteralOffenders: { line: number; snippet: string }[];
} { … }
```

### Positive-match regex

```regex
/'--json',\s*\n\s*'([^']+)'/g
```

For every match, the extractor records `{ fieldList: capture[1], line: <1-indexed line of the field list literal>, ghSubcommand: <best-effort inference from the preceding lines> }`.

`ghSubcommand` inference is a scan backward from the `'--json',` match for the first quoted literal string that isn't a `--flag` value. Used only for test-case naming and error messages; a wrong inference doesn't fail the test.

### Non-literal-follow-up detector

Every occurrence of `'--json',` in the source must have a matching `positive-match` capture. Extractor also runs:

```regex
/'--json',(.*?)$/gm
```

per line, and for each hit checks whether the corresponding positive-match regex captured on the same range. If not (e.g., the follow-up is a template literal, a variable, or a `.join(',')` expression), the extractor emits a `nonLiteralOffender` entry with the offending line number and a 60-char snippet.

## Test cases

```ts
describe.runIf(hasGhBinary)('gh --json field drift', () => {
  const { matches, nonLiteralOffenders } = extractJsonFieldLists(readWrapperSource());

  it.each(nonLiteralOffenders)(
    'wrapper.ts:$line has a non-literal --json follow-up: $snippet',
    () => {
      throw new Error(
        'json-field-drift: every --json follow-up in wrapper.ts must be a single-quoted string literal. ' +
        'Dynamic field lists cannot be statically validated. See specs/855-.../contracts/json-field-drift-suite.md.',
      );
    },
  );

  it('extracts at least one --json field list', () => {
    expect(matches.length).toBeGreaterThan(0);
  });

  it.each(matches)(
    'gh accepts $ghSubcommand --json "$fieldList" (wrapper.ts:$line)',
    ({ fieldList, ghSubcommand }) => {
      // Choose a subcommand invocation that exercises the field list without needing auth or network.
      const args = buildTestArgs(ghSubcommand, fieldList);
      const result = spawnSync('gh', args, { encoding: 'utf-8', timeout: 5000 });
      if (/unknown json field/i.test(result.stderr)) {
        throw new Error(
          `gh rejected --json field list at wrapper.ts:${line}: "${fieldList}"\n` +
          `stderr: ${result.stderr.trim()}`,
        );
      }
    },
  );
});
```

### `buildTestArgs`

Constructs a gh invocation that reaches the client-side `--json` validator without requiring auth or network. Rules by inferred subcommand:

| Subcommand           | args                                                                                                    |
|----------------------|---------------------------------------------------------------------------------------------------------|
| `pr checks`          | `['pr', 'checks', '999999999', '--repo', 'octocat/hello-world', '--json', fieldList]`                   |
| `pr view`            | `['pr', 'view', '999999999', '--repo', 'octocat/hello-world', '--json', fieldList]`                     |
| `pr list`            | `['pr', 'list', '--repo', 'octocat/hello-world', '--json', fieldList, '--limit', '1']`                  |
| `issue view`         | `['issue', 'view', '999999999', '--repo', 'octocat/hello-world', '--json', fieldList]`                  |
| `search issues`      | `['search', 'issues', 'is:open', 'repo:octocat/hello-world', '--json', fieldList, '--limit', '1']`      |
| (unknown/fallback)   | `['pr', 'checks', '999999999', '--repo', 'octocat/hello-world', '--json', fieldList]`                    |

Rationale: gh's client-side `--json` validator dispatches per-subcommand (different subcommands accept different field vocabularies). Using the correct subcommand ensures each test case validates against the RIGHT vocabulary. The fallback (`pr checks`) is a safe default for unrecognized subcommands — gh's `--json` field vocabularies are heavily overlapping in practice, and the assertion (`no "Unknown JSON field"`) is robust to a subcommand mismatch as long as at least some field names are shared.

Notes:
- `octocat/hello-world` is a public repo that reliably exists. Any dummy owner/repo works — the point is that gh's `--json` validation fires before the network hop.
- `999999999` is an invalid issue/PR number. gh will exit non-zero for "not found", but `Unknown JSON field` fires client-side before that check.
- 5s timeout is defensive; real invocations return in <500 ms.

## Assertion (SC-004)

The suite fails iff:

- Any current `--json` field list in `wrapper.ts` produces `Unknown JSON field` in gh's stderr.
- Any `'--json',` occurrence in `wrapper.ts` has a non-literal follow-up.

The suite does NOT fail on:

- Non-zero exit codes for reasons other than `Unknown JSON field` (e.g., 404, auth failure). These are expected with dummy refs.
- Empty stdout, extra stderr lines about network/auth.
- Missing gh binary (suite skips gracefully via `runIf`).

## Failure output examples

### Drift detected (FR-008 counterexample)

```
FAIL packages/cockpit/src/gh/__tests__/json-field-drift.test.ts
  gh --json field drift
    ✕ gh accepts pr checks --json "name,state,conclusion,detailsUrl" (wrapper.ts:605)

  Error: gh rejected --json field list at wrapper.ts:605: "name,state,conclusion,detailsUrl"
  stderr: Unknown JSON field: "conclusion"
  Choose from: bucket, completedAt, description, event, link, name, startedAt, state, workflow
```

The error message names the exact wrapper line and the exact field name gh rejected. The author can grep-jump to the site.

### Non-literal follow-up (SC-005 counterexample)

```
FAIL packages/cockpit/src/gh/__tests__/json-field-drift.test.ts
  gh --json field drift
    ✕ wrapper.ts:612 has a non-literal --json follow-up: fieldList.join(','),

  Error: json-field-drift: every --json follow-up in wrapper.ts must be a single-quoted string literal.
  Dynamic field lists cannot be statically validated.
```

## Performance envelope

- 13 current field lists in `wrapper.ts` × ~500 ms per `spawnSync` = ~6.5 s worst case per CI run.
- Under `pnpm test`, the suite runs alongside all other `packages/cockpit` unit tests. Additional runtime is dominated by gh process startup, not the network (client-side validation, no network hop).
- Skipped locally when `gh` is absent: 0 ms.

## Non-changes

- **Not an integration test.** No auth, no network, no mocking-of-mocks. It tests contract compatibility with the pinned gh binary — that's exactly the thing every unit test in the wrapper package has been unable to catch.
- **Not an AST scan.** Grep + literal enforcement is the design (Q4→A). Dynamic field lists are forbidden by construction.
- **Not per-consumer.** The suite guards `wrapper.ts` at the boundary; downstream consumer tests (`merge.test.ts`, `context.*.test.ts`, etc.) continue to use `fakeGh` fixtures for shape assertions.

## Related contracts

- `check-run-summary.md` — the outward interface that `getPullRequestCheckRuns` returns.
- `get-pull-request-check-runs.md` — the wrapper method whose `--json` field list this suite guards (primary target).
