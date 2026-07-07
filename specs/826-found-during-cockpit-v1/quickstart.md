# Quickstart: Cockpit epic-body parser accepts titled task-list refs

**Feature**: `826-found-during-cockpit-v1` | **Date**: 2026-07-07

Reproduce the bug, validate the fix, and confirm regression coverage. All commands run from the `generacy` repo root unless noted.

## Reproduce the bug (pre-fix, on `develop`)

```bash
git checkout develop
pnpm install
pnpm --filter @generacy-ai/cockpit build

# Feed a house-style epic body into parseEpicBody and observe the rejection.
cat > /tmp/826-repro.mjs <<'EOF'
import { parseEpicBody } from '@generacy-ai/cockpit';
const body = [
  '### S2 — scaffolding',
  '- [ ] christrudelpw/sniplink#2 — Scaffold Next.js + Tailwind app',
  '- [ ] christrudelpw/sniplink#3 — Configure ESLint + Prettier',
  '',
].join('\n');
const result = parseEpicBody(body);
console.log(JSON.stringify(result, null, 2));
EOF
node --experimental-vm-modules /tmp/826-repro.mjs
```

Expected pre-fix output:
```json
{
  "phases": [
    { "heading": "S2 — scaffolding", "token": "s2", "refs": [] }
  ],
  "allRefs": [],
  "warnings": [
    "cockpit: ignored ref-shaped task-list line 2: 'christrudelpw/sniplink#2 — Scaffold Next.js + Tailwind app' (unrecognised shape — bare '#N' shorthand is not accepted)",
    "cockpit: ignored ref-shaped task-list line 3: 'christrudelpw/sniplink#3 — Configure ESLint + Prettier' (unrecognised shape — bare '#N' shorthand is not accepted)"
  ]
}
```

Note the misleading warning text — the line is *not* bare-`#N` shorthand.

## Validate the fix

Switch to this feature branch:

```bash
git checkout 826-found-during-cockpit-v1
pnpm install
pnpm --filter @generacy-ai/cockpit build
node --experimental-vm-modules /tmp/826-repro.mjs
```

Expected post-fix output:
```json
{
  "phases": [
    {
      "heading": "S2 — scaffolding",
      "token": "s2",
      "refs": [
        { "repo": "christrudelpw/sniplink", "number": 2 },
        { "repo": "christrudelpw/sniplink", "number": 3 }
      ]
    }
  ],
  "allRefs": [
    { "repo": "christrudelpw/sniplink", "number": 2 },
    { "repo": "christrudelpw/sniplink", "number": 3 }
  ],
  "warnings": []
}
```

### Case 1 — em-dash delimiter (house style, primary case)

```bash
cat > /tmp/826-case1.mjs <<'EOF'
import { parseEpicBody } from '@generacy-ai/cockpit';
const r = parseEpicBody('### S1\n- [ ] owner/repo#1 — the title\n');
console.log(r.phases[0].refs);   // [ { repo: 'owner/repo', number: 1 } ]
console.log(r.warnings);          // []
EOF
node --experimental-vm-modules /tmp/826-case1.mjs
```

### Case 2 — ASCII-hyphen delimiter

```bash
cat > /tmp/826-case2.mjs <<'EOF'
import { parseEpicBody } from '@generacy-ai/cockpit';
const r = parseEpicBody('### S1\n- [ ] owner/repo#1 - the title\n');
console.log(r.phases[0].refs);   // [ { repo: 'owner/repo', number: 1 } ]
EOF
node --experimental-vm-modules /tmp/826-case2.mjs
```

### Case 3 — title-less (backwards compat)

```bash
cat > /tmp/826-case3.mjs <<'EOF'
import { parseEpicBody } from '@generacy-ai/cockpit';
const r = parseEpicBody('### S1\n- [ ] owner/repo#1\n');
console.log(r.phases[0].refs);   // [ { repo: 'owner/repo', number: 1 } ]
EOF
node --experimental-vm-modules /tmp/826-case3.mjs
```

### Case 4 — all four ref shapes with titles

```bash
cat > /tmp/826-case4.mjs <<'EOF'
import { parseEpicBody } from '@generacy-ai/cockpit';
const body = [
  '### S1',
  '- [ ] owner/repo#1 — bare shape',
  '- [ ] [owner/repo#2](https://x.test) — md-link-bare-label',
  '- [ ] [#3](https://github.com/owner/repo/issues/3) — md-link-hash-label',
  '- [ ] https://github.com/owner/repo/pull/4 — plain URL',
].join('\n');
const r = parseEpicBody(body);
console.log(r.phases[0].refs);
// [ { owner/repo, 1 }, { owner/repo, 2 }, { owner/repo, 3 }, { owner/repo, 4 } ]
console.log(r.warnings);   // []
EOF
node --experimental-vm-modules /tmp/826-case4.mjs
```

### Case 5 — bare-`#N` still warns, marker substring `bare '#N'`

```bash
cat > /tmp/826-case5.mjs <<'EOF'
import { parseEpicBody } from '@generacy-ai/cockpit';
const r = parseEpicBody('### S1\n- [ ] #8\n');
console.log(r.warnings);
// [ "cockpit: ignored ref-shaped task-list line 2: '#8' (bare '#N' shorthand …)" ]
console.log(r.warnings[0].includes("bare '#N'"));   // true
EOF
node --experimental-vm-modules /tmp/826-case5.mjs
```

### Case 6 — prose line mentioning a ref does not warn (SC-004)

```bash
cat > /tmp/826-case6.mjs <<'EOF'
import { parseEpicBody } from '@generacy-ai/cockpit';
const r = parseEpicBody('### S1\n- [ ] Do X, see owner/repo#5\n');
console.log(r.phases[0].refs);   // []
console.log(r.warnings);          // []  ← FR-007
EOF
node --experimental-vm-modules /tmp/826-case6.mjs
```

### Case 7 — additional refs in title are silently ignored (FR-008)

```bash
cat > /tmp/826-case7.mjs <<'EOF'
import { parseEpicBody } from '@generacy-ai/cockpit';
const r = parseEpicBody('### S1\n- [ ] owner/repo#1 — depends on owner/repo#2\n');
console.log(r.phases[0].refs);   // [ { owner/repo, 1 } ]
console.log(r.warnings);          // []
EOF
node --experimental-vm-modules /tmp/826-case7.mjs
```

### Case 8 — real-world snapshot (christrudelpw/sniplink#1)

The verbatim snapshot at `packages/cockpit/src/resolver/__tests__/fixtures/epic-826-sniplink.md` is loaded by the test suite:

```bash
pnpm --filter @generacy-ai/cockpit test src/resolver/__tests__/parse-epic-body.test.ts
```

Assertions:
- Every phase in the snapshot has its expected ref list.
- `warnings` is `[]`.

## Test suite

```bash
pnpm --filter @generacy-ai/cockpit test packages/cockpit/src/resolver
```

Watch specifically:
- `__tests__/parse-epic-body.test.ts` — first-token extraction, all four shapes × both delimiter styles, three warning-family marker substrings, prose-mentions-ref silence, additional-refs-in-title silence, both snapshot fixtures.
- `__tests__/ref-shapes.test.ts` — untouched, must still pass.
- `__tests__/heading-match.test.ts` — untouched.
- `__tests__/resolve.test.ts` — untouched.

## Success criteria checks

**SC-001 — real-world epic bodies resolve without warnings**:

```bash
pnpm --filter @generacy-ai/cockpit test -- -t 'sniplink|tetrad-88'
# → all snapshot assertions pass; refs match ground-truth per phase; warnings === []
```

**SC-002 — cockpit v1 smoke test no longer emits warnings against titled house-style lines**:

Post-merge, restore titled house-style lines on `tetrad-development#88` via manual `gh issue edit` (see PR description). Re-run the smoke test. Expect zero `cockpit: ignored ref-shaped task-list line …` warnings.

**SC-003 — warning marker substrings**:

```bash
pnpm --filter @generacy-ai/cockpit test -- -t 'warning'
# → three assertions using toContain() pass:
#     "bare '#N'"
#     'titled but not ref-shaped'
#     'URL path not /(issues|pull)/N'
```

**SC-004 — prose checkbox lines that mention a ref outside the first-token position do not warn**:

```bash
pnpm --filter @generacy-ai/cockpit test -- -t 'prose'
# → assertion: parseEpicBody('### S1\n- [ ] Do X, see owner/repo#5').warnings === []
```

## Post-merge manual step (Q4→C)

Restore titled house-style lines on the test epic:

```bash
# Assuming gh CLI is authenticated and points at a token with tetrad-development access:
gh issue view generacy-ai/tetrad-development#88 --json body -q .body > /tmp/tetrad-88.md
# Edit /tmp/tetrad-88.md: revert the title-stripped workaround, restoring the original `- [ ] owner/repo#N — title` lines.
gh issue edit 88 --repo generacy-ai/tetrad-development --body-file /tmp/tetrad-88.md
```

Then re-run the cockpit v1 smoke test. Zero warnings against the restored house-style lines is the fix's live post-merge verification.

## Troubleshooting

**Warning says `titled but not ref-shaped` on a line you expect to work** — check the first whitespace-delimited token. If it's got a trailing `:` (colon without preceding space, e.g. `owner/repo#5:`), the token binds the colon and fails `parseRef`. Add a space before the colon (`owner/repo#5 : description`) or use em-dash / ASCII hyphen / whitespace-only.

**Warning says `URL path not /(issues|pull)/N`** — the URL points at `/commit/`, `/projects/`, `/discussions/`, `/pulls`, etc. The parser accepts only issue and pull-request URLs. Use the issue or PR URL.

**Warning says `bare '#N'`** — the first token is `#N` without an owner/repo prefix. Add the `owner/repo` prefix (`- [ ] owner/repo#N — title`).

**Snapshot fixture drift** — the two `.md` files under `__tests__/fixtures/` are **frozen at PR time** intentionally. They document the exact real-world bodies that triggered #826. Do not re-sync them from the live issues after merge — the live epics move on, but the regression evidence stays.

**Line resolves to only one ref when I expected two** — that's FR-008. Additional ref-shaped tokens in the title portion are silently ignored. If you meant two refs, write two checkbox lines.
