# Quickstart: Config Migration from autodev.json

## What Changed

All speckit configuration previously in `.claude/autodev.json` now lives under the `speckit` section of `.generacy/config.yaml`. The `autodev` branding is removed from webhook triggers and CLI detection.

## Migration Steps

### For projects using default config (no customization)

No action needed. The `speckit` section is fully optional with defaults matching previous behavior.

### For projects with custom autodev.json

If your `.claude/autodev.json` had custom values, add a `speckit` section to `.generacy/config.yaml`:

**Before** (`.claude/autodev.json`):
```json
{
  "paths": { "specs": "my-specs" },
  "files": { "spec": "specification.md" },
  "branches": { "numberPadding": 4 }
}
```

**After** (`.generacy/config.yaml`):
```yaml
# existing config...
speckit:
  paths:
    specs: "my-specs"
  files:
    spec: "specification.md"
  branches:
    numberPadding: 4
```

Then delete `.claude/autodev.json`.

## Trigger Changes

| Old Pattern | New Pattern | Action |
|-------------|-------------|--------|
| `@autodev continue` | Removed | Use `@agent continue` or `/continue` |
| `autodev:ready` label | Removed | Use `ready` label |
| `autodev:*` CLI phase | Removed | Use `speckit:*` phases |

## Verification

After migration, verify no autodev references remain:

```bash
# Should return no results in functional code
grep -r "autodev" --include="*.ts" --include="*.json" packages/
```

## Troubleshooting

**Q: Speckit commands fail after migration**
A: Ensure `.generacy/config.yaml` is valid YAML and the `speckit` section (if present) matches the expected schema. All fields are optional — remove the section entirely to use defaults.

**Q: Branch naming changed unexpectedly**
A: Verify the `speckit.branches` section uses identical values to your old `autodev.json`. All defaults are preserved from the original implementation.
