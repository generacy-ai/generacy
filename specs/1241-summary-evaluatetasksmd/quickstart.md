# Quickstart: Numeric spec-dir resolver

## Setup

```bash
pnpm install
# Build the shared package first — dependents resolve its built dist/
pnpm --filter @generacy-ai/workflow-engine build
```

## Usage

```ts
import { matchSpecDir, findSpecDirName } from '@generacy-ai/workflow-engine';
import { readdirSync } from 'node:fs';

const entries = readdirSync('specs'); // ['006-foo', '60-bar', 'contracts']

// Full result (safety net uses this to report ambiguity)
matchSpecDir(entries, 6);   // { kind: 'match', dir: '006-foo' }
matchSpecDir(entries, 60);  // { kind: 'match', dir: '60-bar' }
matchSpecDir(entries, 7);   // { kind: 'none' }

// Exact-match precedence (Q2=B)
matchSpecDir(['6-foo', '006-bar'], 6);   // { kind: 'match', dir: '6-foo' }
matchSpecDir(['006-a', '0006-b'], 6);    // { kind: 'ambiguous', dirs: ['006-a', '0006-b'] }

// Convenience form (undefined on none/ambiguous)
findSpecDirName(entries, 6); // '006-foo'
```

## Verify

```bash
# Unit tests for the resolver
pnpm --filter @generacy-ai/workflow-engine test -- spec-dir-resolver

# Safety-net suite (must pass unchanged + new zero-padded cases)
pnpm --filter @generacy-ai/orchestrator test -- tasks-md-fallback

# Full typecheck/test after rebuilding workflow-engine
pnpm --filter @generacy-ai/workflow-engine build && pnpm -r typecheck

# SC-005: no spec-dir prefix matches remain (branch-name checks are the only hits)
rg 'startsWith\(`\$\{issueNumber\}-`\)|startsWith\(`\$\{item\.issueNumber\}-`\)' packages/*/src
```

## Troubleshooting

- **"no exported member 'matchSpecDir'" in orchestrator/generacy** — stale
  `workflow-engine/dist`; rebuild it (see Setup).
- **Changeset gate fails** — the PR must *add* a new `.changeset/*.md` listing
  `workflow-engine` (minor), `orchestrator` (patch), `generacy` (patch).
- **Issue resolves a legacy padded dir** (e.g. issue 6 → `specs/006-job-scheduler-…`
  with no `6-…` dir present) — accepted residual risk per clarification Q2; bounded by
  the phase loop's no-progress guard.
