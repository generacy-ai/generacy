# Data Model: Discovery-Based Workflow Verification

This feature modifies YAML workflow definitions only. There are no new entities, types, or data structures introduced.

## Workflow Step Schema

The only "data model" relevant here is the workflow step definition format:

### Before (verification.check)

```yaml
- name: <step-name>
  uses: verification.check
  with:
    command: <shell-command-string>
  continueOnError: <boolean>
```

### After (build.validate)

```yaml
- name: validate
  uses: build.validate
  continueOnError: <boolean>
```

Key differences:
- `uses` changes from `verification.check` to `build.validate`
- `with.command` is removed entirely (no configuration needed)
- Two steps collapse into one

## External Tool Interface

The `build.validate` tool (from agency#323) is treated as a black box. Its expected behavior:

| Aspect | Expectation |
|--------|-------------|
| Input | None required (auto-detects from project files) |
| Detection | Reads lockfiles/`packageManager` field to identify package manager |
| Discovery | Reads `package.json` `scripts` to find validation commands |
| Execution | Runs all discovered validation scripts |
| Output | Per-script pass/fail results |
| Exit code | Non-zero on any failure (compatible with `continueOnError`) |
| Monorepo | Handles workspace detection internally |
