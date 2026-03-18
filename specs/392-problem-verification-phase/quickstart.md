# Quickstart: Discovery-Based Workflow Verification

## What Changed

The verification phase in both speckit workflows now uses `build.validate` instead of hardcoded `pnpm run test` / `pnpm run lint` commands.

## Files Modified

- `.generacy/speckit-feature.yaml` — Phase 7 (verification)
- `.generacy/speckit-bugfix.yaml` — Phase 6 (verification)

## Prerequisites

- `build.validate` tool must be available (generacy-ai/agency#323)

## Verification

After implementation, verify the changes:

```bash
# Confirm no hardcoded pnpm references in verification phases
grep -A 20 'name: verification' .generacy/speckit-feature.yaml | grep pnpm
# Should return nothing

grep -A 20 'name: verification' .generacy/speckit-bugfix.yaml | grep pnpm
# Should return nothing

# Confirm build.validate is used
grep 'build.validate' .generacy/speckit-feature.yaml .generacy/speckit-bugfix.yaml
# Should show one match per file
```

## Troubleshooting

| Issue | Cause | Fix |
|-------|-------|-----|
| `build.validate` not found | agency#323 not deployed | Wait for agency#323 to land |
| Verification phase exits with error | `build.validate` found validation failures | Check individual script output in the tool's report |
| Scripts not discovered | Scripts not in `package.json` | Add scripts to `package.json` `scripts` field |
