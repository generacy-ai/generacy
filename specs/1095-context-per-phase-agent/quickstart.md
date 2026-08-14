# Quickstart: per-phase `effort` configuration

This walks through the smallest possible end-to-end use of the new `effort` field.

## Prerequisites

- `.generacy/config.yaml` with a `project` and `repos.primary`.
- A running Generacy cluster (see `pnpm dev` in the repo root or `generacy up` in a project dir).
- Claude Code CLI ≥ v2.1.150 (the `--effort` flag was verified against v2.1.150 during planning; older versions may not support it — see Troubleshooting).

## Add the `agents` block with `effort`

Edit `.generacy/config.yaml` in your project:

```yaml
project:
  id: proj_myproject123
  name: My Project

repos:
  primary: github.com/myorg/myrepo

orchestrator:
  agents:
    # Repo-wide default. Applies to any workflow/phase not overridden below.
    default:
      provider: claude-code
      model: sonnet-4-6

    workflows:
      speckit-feature:
        # Applies to every phase of this workflow unless overridden below.
        default:
          model: sonnet-4-6
          effort: medium

        phases:
          # High effort for planning; xhigh for implementation.
          plan:
            model: fable
            effort: xhigh

          implement:
            model: opus-4-7
            effort: high
```

## Validate the config

```bash
generacy validate
```

Expected output (v2.1.150 CLI, mechanism present):

```
✓ Configuration is valid

Config file: .generacy/config.yaml

Project:
  ID: proj_myproject123
  Name: My Project

Repositories:
  Primary: github.com/myorg/myrepo

Orchestrator:
  ...
```

## What resolves at spawn time

For the `speckit-feature` workflow:

| Phase | Provider | Model | Effort |
|-------|----------|-------|--------|
| specify | claude-code (from default) | sonnet-4-6 (from workflow default) | medium (from workflow default) |
| clarify | claude-code | sonnet-4-6 | medium |
| **plan** | claude-code | **fable** (phase override) | **xhigh** (phase override) |
| tasks | claude-code | sonnet-4-6 | medium |
| **implement** | claude-code | **opus-4-7** (phase override) | **high** (phase override) |

The two fixer paths (`validate-fix`, `merge-conflict`) bind to the `implement` phase entry — they inherit `opus-4-7 / high`. The `pr-feedback` path already did this in prior releases; now all three fixers behave the same way.

## Verifying spawn-time argv

At runtime, spawned CLI processes carry `--model` and `--effort` on the argv:

```
claude -p --output-format stream-json --dangerously-skip-permissions --verbose \
  --model opus-4-7 --effort high \
  '/speckit:implement https://github.com/myorg/myrepo/issues/123'
```

Grep the orchestrator logs for `Spawning Claude CLI` to see the resolved `{ provider, model, effort }` per spawn.

## Backward compat

- **No `agents` block**: pre-existing behavior. All spawn paths use the CLI's ambient default model + no effort flag. Byte-identical to prior releases.
- **`agents` set, `effort` unset**: `--model` is threaded per prior release behavior; `--effort` is omitted. Byte-identical to the pre-`effort` state.
- **`agents` set with `effort`, but CLI has no `--effort` flag**: `generacy validate` emits a warning; orchestrator logs a warning per spawn; `--effort` is dropped from argv. See Troubleshooting.

## Troubleshooting

### `Schema validation failed: ... effort: Invalid enum value`

`effort` must be one of `low, medium, high, xhigh, max` — case-sensitive. `HIGH` and `super` are rejected.

### `Unrecognized key(s) in object`

Applies to typos inside the `agents` block (`.strict()` mode). Common ones:
- `defualt:` → `default:`
- `efort:` → `effort:`
- `modle:` → `model:`
- `implment:` → `implement:`

Typos **outside** the `agents` block are still silently stripped (by design — Q4 zero-blast-radius decision).

### `generacy validate` warning: `orchestrator.agents...effort — set to 'high' but provider 'claude-code' has no CLI mechanism for effort in this release`

Your installed Claude CLI is older than the version this plugin release expects. Either:
- Upgrade the CLI to a version that supports `--effort`, or
- Remove the `effort` field from your config (schema will still accept it, but the warning will stop firing).

The orchestrator will also log a matching `agent.effort.dropped` warning on every spawn. This is deliberate — the CLI version can change independently of when validate last ran.

### `SC-004` byte-identical baseline verification

If you want to prove that removing the `agents` block from your config restores the pre-change spawn argv exactly, run:

```bash
# Baseline capture (before this PR merges)
git checkout develop
pnpm --filter @generacy-ai/generacy-plugin-claude-code test -- --run

# Compare to the new SC-004 snapshot
git checkout 1095-context-per-phase-agent
pnpm --filter @generacy-ai/generacy-plugin-claude-code test -- --run
```

Snapshot diffs against the pre-change baseline must be zero for the four intent kinds when `model` and `effort` are unset.

## References

- Spec: `specs/1095-context-per-phase-agent/spec.md`
- Data model: `specs/1095-context-per-phase-agent/data-model.md`
- Plan: `specs/1095-context-per-phase-agent/plan.md`
- Research: `specs/1095-context-per-phase-agent/research.md`
- Claude CLI reference (installed version): `claude --help | grep effort`
