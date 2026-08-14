# Contract: Claude Code launch-plugin argv shape

**Location**: `packages/generacy-plugin-claude-code/src/launch/claude-code-launch-plugin.ts`.

## Common argv prefix (all four affected intent kinds)

```
claude -p --output-format stream-json --dangerously-skip-permissions --verbose
```

## Per-intent argv slots

Both `--model` and `--effort` are conditional. Insertion order is fixed for stable snapshot testing.

### buildPhaseLaunch (PhaseIntent)

```
claude -p --output-format stream-json --dangerously-skip-permissions --verbose \
  [--model ${intent.model}] \
  [--effort ${intent.effort}] \
  [--resume ${intent.sessionId}] \
  '${PHASE_TO_COMMAND[intent.phase]} ${intent.prompt}'
```

### buildPrFeedbackLaunch (PrFeedbackIntent)

```
claude -p --output-format stream-json --dangerously-skip-permissions --verbose \
  [--model ${intent.model}] \
  [--effort ${intent.effort}] \
  '${intent.prompt}'
```

### buildValidateFixLaunch (ValidateFixIntent) — NEW model + effort support

```
claude -p --output-format stream-json --dangerously-skip-permissions --verbose \
  [--model ${intent.model}] \
  [--effort ${intent.effort}] \
  '${intent.prompt}'
```

### buildMergeConflictLaunch (MergeConflictIntent) — NEW model + effort support

```
claude -p --output-format stream-json --dangerously-skip-permissions --verbose \
  [--model ${intent.model}] \
  [--effort ${intent.effort}] \
  '${intent.prompt}'
```

## Baseline (SC-004) — model and effort both unset

With no `agents` block configured (or with `agents` set but leaving `model`/`effort` unset at every tier), the intent carries neither field. The plugin then emits argv byte-identical to today:

**Baseline argv per intent kind**:
- `phase`: `['-p', '--output-format', 'stream-json', '--dangerously-skip-permissions', '--verbose', '${command} ${prompt}']`
- `pr-feedback`: `['-p', '--output-format', 'stream-json', '--dangerously-skip-permissions', '--verbose', '${prompt}']`
- `validate-fix`: `['-p', '--output-format', 'stream-json', '--dangerously-skip-permissions', '--verbose', '${prompt}']`
- `merge-conflict`: `['-p', '--output-format', 'stream-json', '--dangerously-skip-permissions', '--verbose', '${prompt}']`

**Test enforcement**: inline snapshot per intent kind in `packages/generacy-plugin-claude-code/src/launch/__tests__/claude-code-launch-plugin.test.ts`. Any diff fails the build.

## Capability probe

```ts
export class ClaudeCodeLaunchPlugin {
  static hasEffortMechanism(): boolean {
    return true;  // CLI v2.1.150 supports --effort
  }
}
```

Consulted by:
- `packages/generacy/src/config/loader.ts` — validate-time warning collection (FR-010a-a).
- `packages/orchestrator/src/worker/` — spawn-time warning log (FR-010a-b).

Under `false`, both consumers skip appending `--effort` and emit their respective warnings when the intent carries a set `effort`.
