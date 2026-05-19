# Quickstart: CLI scaffolder REPO_BRANCH fix

**Feature**: #651 | **Date**: 2026-05-19

## What Changed

The CLI scaffolder no longer hardcodes `REPO_BRANCH=main` in generated `.env` files. When no branch is specified (the common case), the `REPO_BRANCH` line is omitted entirely, allowing `git clone` to use the repository's actual default branch.

## Verification

### Run tests

```bash
cd packages/generacy
pnpm test -- --filter scaffolder
```

### Manual check — scaffolded .env without branch

After running `npx generacy launch --claim=<code>`, inspect `.generacy/.env`:

```bash
grep REPO_BRANCH .generacy/.env
# Should return nothing (line omitted)
```

### Manual check — explicit branch (future)

When `repoBranch` is passed to the scaffolder (future cloud UI enhancement):

```bash
grep REPO_BRANCH .generacy/.env
# REPO_BRANCH=develop
```

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Clone fails with "Remote branch 'main' not found" | Old `.env` with hardcoded `REPO_BRANCH=main` | Delete `.generacy/.env` and re-run `generacy launch` |
| `REPO_BRANCH=main` still appears after update | Stale `.env` from previous scaffold | Same as above — `.env` is only written on initial scaffold |
| Clone uses wrong branch | `REPO_BRANCH` explicitly set in `.env.local` override | Check `.generacy/.env.local` for manual overrides |
