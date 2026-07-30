# Quickstart

Manual verification recipes for the two grammar fixes. Assumes `pnpm install` in the repo root.

## Setup

```bash
cd /workspaces/generacy
pnpm --filter @generacy-ai/cockpit build
pnpm --filter @generacy-ai/cockpit test
```

Also run the writer suite:

```bash
pnpm --filter @generacy-ai/generacy test packages/generacy/src/cli/commands/cockpit/scope
```

## Recipe 1 — H4-authored epic parses cleanly (US1, SC-001)

Body:

```markdown
### Delivery phases

#### P1 — Scaffold
- [ ] owner/repo#2

#### P2 — Foundation
- [ ] owner/repo#3
- [ ] owner/repo#4
```

Node REPL:

```javascript
import { parseEpicBody } from '@generacy-ai/cockpit';

const body = `### Delivery phases

#### P1 — Scaffold
- [ ] owner/repo#2

#### P2 — Foundation
- [ ] owner/repo#3
- [ ] owner/repo#4
`;

const r = parseEpicBody(body);
console.log(JSON.stringify(r, null, 2));
```

Expected:

- `r.phases.length === 3` (Delivery phases + P1 + P2 — flat siblings, per FR-012).
- Warnings include `mixed phase heading levels` (both `###` and `####` phase-shaped).
- P1 phase contains ref `owner/repo#2`. P2 phase contains `#3` and `#4`.
- `adhocRefs.length === 0`.

Pre-PR (today): P1 and P2 sit empty, `adhocRefs` holds all 3 refs, `warnings` includes `phase headers must be '###'`.

## Recipe 2 — Bare `#N` in scope body resolves under `defaultRepo` (US2, SC-002)

Body:

```markdown
### Phase 1
- [ ] #223
- [ ] #224 — a title
- [x] #225

### Phase 2
- [ ] #227
```

Node REPL:

```javascript
import { parseEpicBody } from '@generacy-ai/cockpit';

const body = `### Phase 1
- [ ] #223
- [ ] #224 — a title
- [x] #225

### Phase 2
- [ ] #227
`;

const withDefault = parseEpicBody(body, { defaultRepo: 'my-org/my-repo' });
console.log('with defaultRepo:', withDefault.phases.map(p => p.refs));
console.log('warnings:', withDefault.warnings);

const noDefault = parseEpicBody(body);
console.log('no defaultRepo:', noDefault.phases.map(p => p.refs));
console.log('warnings:', noDefault.warnings);
```

Expected (with `defaultRepo`):
- All 4 refs resolve to `{repo: 'my-org/my-repo', number: N}`.
- `warnings.length === 0`.

Expected (without `defaultRepo` — legacy):
- All 4 refs dropped from `phases[]`.
- `warnings` contains 4 entries, each with marker `bare '#N'`.

## Recipe 3 — `resolveEpic` auto-supplies `defaultRepo` (FR-006)

```javascript
import { resolveEpic } from '@generacy-ai/cockpit';

const gh = {
  getIssue: async (repo, number) => ({
    body: '### Phase 1\n- [ ] #223\n',
  }),
};

const r = await resolveEpic({ epicRef: 'my-org/my-repo#1', gh });
console.log(r.parsed.phases[0].refs);
console.log(r.parsed.warnings);
```

Expected:
- `r.parsed.phases[0].refs === [{ repo: 'my-org/my-repo', number: 223 }]`.
- `r.parsed.warnings === []`.

## Recipe 4 — Non-phase-shaped `####` is transparent (FR-002)

```javascript
const body = `### Phase 1
- [ ] owner/repo#1

#### Notes
- [ ] owner/repo#2

#### Follow-ups
- [x] owner/repo#3
`;

const r = parseEpicBody(body);
// All three refs attributed to Phase 1 (H4 transparent).
console.log(r.phases[0].refs.map(x => x.number)); // [1, 2, 3]
console.log(r.adhocRefs); // []
```

Pre-PR: `phases[0].refs === [{number:1}]`, `adhocRefs === [{number:2},{number:3}]`.

## Recipe 5 — Bare `#N` outside checkbox stays rejected (FR-013)

```javascript
const body = `### Phase 1
- [ ] #10
- #11
1. #12
See #13 for context.
`;

const r = parseEpicBody(body, { defaultRepo: 'o/r' });
console.log(r.phases[0].refs); // [{ repo: 'o/r', number: 10 }] only
console.log(r.warnings); // [] — non-checkbox lines silently skipped
```

The checkbox `#10` resolves. The plain bullet `#11`, ordered item `#12`, and prose `#13` remain outside the parser's ref-scanning surface.

## Recipe 6 — Malformed `defaultRepo` fails safe (FR-003)

```javascript
const r = parseEpicBody('### P\n- [ ] #1\n', { defaultRepo: 'not-owner-repo' });
console.log(r.warnings); // includes 'invalid defaultRepo'
console.log(r.phases[0].refs); // [] — bare '#1' rejected because validation failed
```

## Recipe 7 — `scope add` on H4-authored body (FR-011)

```javascript
import { applyScopeMutation, detectShape } from '../../../generacy/src/cli/commands/cockpit/scope/writer.js';

const body = `Notes.

#### P1 — Scaffold
- [ ] owner/repo#1
`;

console.log(detectShape(body)); // 'phased' — was 'flat' pre-PR
const r = applyScopeMutation(body, { kind: 'add', ref: { repo: 'owner/repo', number: 99 } });
console.log(r.body);
// Should append `## Ad-hoc` at tail with `- [ ] owner/repo#99`
```

## Troubleshooting

- **`resolveEpic` still warns `bare '#N'`**: Confirm `resolve.ts` is passing `{ defaultRepo: epic.repo }` to `parseEpicBody`. Check that the epic body's checkbox lines match `TASK_LIST_RE` exactly — `- [ ] #10` with a single space inside brackets works, `- [] #10` (no space) does not (per today's regex).
- **Snapshot diff on a fixture other than `epic-1006-snappoll.md`**: SC-004 violation. Compare the fixture body against the parser rules — the H4 promotion should only affect phase-shaped headings. If a fixture uses `#### Notes` (not phase-shaped), snapshot MUST stay identical.
- **Type error on `parseEpicBody` callers after upgrade**: The new second parameter is optional. If your caller is doing `parseEpicBody(...args)` with a spread, check that `args[1]` (if present) is `ParseEpicBodyOptions`-compatible.
- **`mixed phase heading levels` warning fires unexpectedly**: The body contains BOTH `### Phase X` AND a phase-shaped `#### Y`. Either normalize to one level (recommended: `###` throughout) or accept the flat-sibling behavior.

## CI gate

- Changeset file present: `.changeset/1014-h4-phase-and-bare-refs.md`.
  ```
  ---
  "@generacy-ai/cockpit": minor
  "@generacy-ai/generacy": patch
  ---

  Resolver: phase-shaped `####` headings open phases; bare `#N` refs in checkboxes resolve to scope repo (#1014).
  ```
- `pnpm --filter @generacy-ai/cockpit test` — all green, including re-pinned `epic-1006-snappoll.md` snapshot.
- `pnpm --filter @generacy-ai/generacy test` — writer suite green, including new `detectShape` cases.
