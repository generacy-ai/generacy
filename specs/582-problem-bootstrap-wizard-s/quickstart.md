# Quickstart: Verify Role Removal (#582)

## Prerequisites

- Node >=20
- pnpm installed

## Verification Steps

### 1. Build check

```bash
cd packages/control-plane
pnpm tsc --noEmit
```

Expected: clean exit, no errors.

### 2. Run tests

```bash
cd packages/control-plane
pnpm test
```

Expected: all tests pass. Previously role-related tests are gone.

### 3. Grep verification (SC-001)

```bash
grep -r 'set-default-role\|SetDefaultRole\|handleGetRole\|handlePutRole\|default-role-writer' packages/control-plane/src/
```

Expected: zero matches.

### 4. Integration verification

```bash
# Start the development stack
/workspaces/tetrad-development/scripts/stack start
source /workspaces/tetrad-development/scripts/stack-env.sh

# Start the dev server
pnpm dev
```

Then verify:
- Bootstrap wizard shows 4 steps (not 5)
- Step 3 is "Peer Repos" (was "Role Selection")
- `POST /lifecycle/set-default-role` returns 400 (invalid action), not 200

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `tsc` errors about missing exports | Incomplete removal from `index.ts` | Check all re-exports are removed |
| Test imports fail | Deleted file still imported in test | Check lifecycle.test.ts mock |
| Grep finds hits | Missed a reference | Follow the deletion map in research.md |

## What NOT to verify

- Org-level role management — unaffected, separate feature
- credhelper-daemon role loading — workspace-level, not cluster-level
- Cloud wizard changes — separate repo, separate PR
