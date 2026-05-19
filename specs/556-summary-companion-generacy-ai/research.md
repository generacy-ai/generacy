# Research: Launch scaffolder writes `GENERACY_BOOTSTRAP_MODE=wizard`

## Technology Decisions

### Decision: Unconditional emit (no new interface field)

**Rationale**: The spec explicitly states "no conditional logic — always emit for all callers of `scaffoldEnvFile`". Adding a field to `ScaffoldEnvInput` would create unnecessary complexity for a value that never varies.

**Alternative rejected**: Adding `bootstrapMode?: 'wizard' | 'devcontainer'` to `ScaffoldEnvInput`. Rejected because:
- Both launch and deploy always use wizard mode
- The devcontainer flow doesn't use `scaffoldEnvFile` at all (it uses `.env.template` in cluster-base)
- Extra interface surface with zero callers passing anything other than `wizard`

### Decision: Append after "Cluster runtime" section

**Rationale**: Placing the new env var at the end of the file (before the trailing newline) follows the existing sectioned structure. A new "Bootstrap mode" section with comment headers matches the cluster-base convention documented in the spec.

**Alternative rejected**: Inserting into the "Identity" section. Rejected because bootstrap mode is a runtime behavior flag, not a cloud-issued identity value.

### Decision: Comment format matches cluster-base convention

**Rationale**: Two comment lines before the var, explaining what the value means and when it applies. This matches the format requested in the spec's "Scope" section.

## Implementation Patterns

- **String concatenation**: The `.env` writer uses a simple `lines.join('\n')` pattern. Add new lines to the array.
- **Test assertion**: Existing tests use `expect(content).toContain('VAR=value')` pattern.

## Key References

- cluster-base#20: Defines the env var name and consumer behavior
- generacy-cloud#528: Companion change for cloud-deploy path (out of scope here)
- `packages/generacy/src/cli/commands/cluster/scaffolder.ts:257-294`: Current `scaffoldEnvFile` implementation
