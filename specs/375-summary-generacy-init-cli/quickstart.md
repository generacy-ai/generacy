# Quickstart: Refactor generacy init to use cluster-base repos

## Prerequisites

- Node.js 20+
- pnpm installed (`npm install -g pnpm`)
- Repository cloned and on the `375-summary-generacy-init-cli` branch

## Setup

```bash
cd /workspaces/generacy
pnpm install
```

## Key Files

| File | Purpose |
|------|---------|
| `packages/generacy/src/cli/commands/init/template-fetcher.ts` | Core logic: repo selection, tarball fetch, path mapping, caching |
| `packages/generacy/src/cli/commands/init/types.ts` | Type definitions for init options |
| `packages/generacy/src/cli/commands/init/index.ts` | CLI command orchestration |
| `packages/generacy/src/cli/commands/init/__tests__/template-fetcher.test.ts` | Template fetcher tests |
| `packages/generacy/src/cli/commands/init/__tests__/tar-utils.test.ts` | Tar extraction tests |
| `packages/config/src/__tests__/repos.test.ts` | Config repo tests |

## Running Tests

```bash
# Run all tests in the generacy package
cd packages/generacy && pnpm test

# Run only template-fetcher tests
pnpm vitest run src/cli/commands/init/__tests__/template-fetcher.test.ts

# Run only tar-utils tests
pnpm vitest run src/cli/commands/init/__tests__/tar-utils.test.ts

# Run config package tests
cd packages/config && pnpm test
```

## Manual Testing

```bash
# Build the CLI
cd packages/generacy && pnpm build

# Test standard variant (should fetch from cluster-base)
generacy init --variant standard --dry-run

# Test microservices variant (should fetch from cluster-microservices)
generacy init --variant microservices --dry-run

# Test with explicit ref
generacy init --variant standard --template-ref main --dry-run

# Test cache refresh
generacy init --variant standard --refresh-templates --dry-run

# Verify no cluster-templates references remain
grep -r "cluster-templates" packages/generacy/src/
# Should return no matches
```

## Verification Checklist

- [ ] `generacy init --variant standard` fetches from `generacy-ai/cluster-base`
- [ ] `generacy init --variant microservices` fetches from `generacy-ai/cluster-microservices`
- [ ] Default ref is `main` (not `develop`)
- [ ] Cache stored at `~/.generacy/template-cache/{repo-name}/{ref}/`
- [ ] `--template-ref` flag still works
- [ ] `--refresh-templates` flag still works
- [ ] All tests pass
- [ ] `grep -r "cluster-templates" packages/generacy/src/` returns zero matches

## Troubleshooting

### Tests fail with "mock tarball structure" errors
The test mocks need to match the new flat repo structure. Ensure mock tarballs use `generacy-ai-cluster-base-{sha}/` prefix without a variant subdirectory.

### 404 when fetching tarball
The default ref changed from `develop` to `main`. If testing against real repos, ensure `main` branch exists on `cluster-base` / `cluster-microservices`.

### Old cache served
Cache paths changed from `{ref}/{variant}/` to `{repo-name}/{ref}/`. Old cache entries at the old path are naturally ignored. Delete `~/.generacy/template-cache/` to force a clean slate if needed.
