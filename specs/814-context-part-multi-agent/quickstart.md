# Quickstart: Per-Phase Model Selection (Issue #814)

This change adds an optional `orchestrator.agents` block to `.generacy/config.yaml` and threads its `{ provider, model }` values through worker config, resolver, spawn options, intent, and launch request into `ClaudeCodeLaunchPlugin`'s `--model` argv. When unconfigured, no argv changes — every no-config snapshot stays byte-identical.

## Basic usage — global model default

Put this in the target repo's `.generacy/config.yaml`:

```yaml
orchestrator:
  agents:
    default:
      model: claude-opus-4-7
```

Now every workflow phase spawns with `claude --model claude-opus-4-7 …`. Provider stays at the built-in `claude-code`.

## Per-phase model selection (the US1 use case)

```yaml
orchestrator:
  agents:
    workflows:
      speckit-feature:
        phases:
          specify: { model: claude-opus-4-7 }         # heavier model for spec drafting
          implement: { model: claude-sonnet-4-6 }     # faster/cheaper for code writing
```

The `specify`, `plan` phases (unset) fall through to the built-in default. `implement` uses `claude-sonnet-4-6`. Session ID persists across the model transition — you'll see one log line:

```
{ "provider": "claude-code", "prevModel": "claude-opus-4-7", "nextModel": "claude-sonnet-4-6" }
"agent.model.transition"
```

## Cluster-admin defaults via env

```bash
export WORKER_AGENT_MODEL=claude-sonnet-4-6
# Optional — provider defaults to 'claude-code' anyway
export WORKER_AGENT_PROVIDER=claude-code
```

Env vars set the cluster default — target repos can still override via YAML (the merge overlays repo config on top of the env-derived default).

## Precedence (highest → lowest)

1. `agents.workflows.<workflowName>.phases.<phase>`
2. `agents.workflows.<workflowName>.default`
3. `agents.default`
4. Repo `defaults.agent` (provider only)
5. `WORKER_AGENT_PROVIDER` / `WORKER_AGENT_MODEL` (folded into tier 3 at load)
6. Built-in `claude-code` (provider only — no built-in model)

Provider and model resolve **independently** at every tier — setting only `model` at a tier does not block a lower tier from setting `provider` (and vice versa).

## PR-feedback binding

PR-feedback invocations (triggered by review comments on an open PR) resolve `{ provider, model }` by binding to the `implement` phase's slot. There's no separate `agents.prFeedback` key. Rationale: pr-feedback revises code that `implement` produced.

## Provider switch — session drop

If a phase resolves to a **different provider** than the previous phase, the phase loop drops the stored Claude CLI session ID and the next spawn starts fresh (no `--resume`). Cross-phase context lives in the spec artifacts (`spec.md`, `plan.md`, `tasks.md`) — the loop reads those, not the Claude session transcript, for cross-phase coherence.

Model-only changes within the same provider **preserve** the session.

## Unknown provider

An unknown provider (nothing registered under that name) fails at spawn time via the phase-loop's `spawn-error` catch — the stage-comment is updated with the `UnknownProviderError` message, and the workflow errors out cleanly. There is no silent fallback to Claude.

Example failure comment:

> `Unknown provider "codex" for intent kind "phase". Available providers: claude-code`

## Troubleshooting

**Argv snapshot diff on an unconfigured repo**: Somewhere `resolveAgentForPhase` is returning a defined `model` for a repo that doesn't set one. Check that `applyRepoAgentOverrides` isn't leaking cluster-env values into repo-scope tests without an env-clean setup.

**`--model` not appearing in argv**: The resolver's model walk returned `undefined`. Check tier precedence — an empty `agents.default: {}` still means "no model set". You need `agents.default: { model: <id> }`.

**Model transition log line missing**: Both the previous and next model must be defined AND different, AND the provider must be unchanged. First-phase spawns never emit it (no previous model).

**Config load fails with `implment` at the phase key**: You typoed a phase name. The `phases` schema is a closed set over `WorkflowPhase = specify | clarify | plan | tasks | implement | validate`.

**Custom workflow phases**: Not supported yet — the `phases` enum is closed. Add your workflow name under `agents.workflows.<name>.default` for a whole-workflow override in the meantime. Widening the phase enum is non-breaking; narrowing isn't.

## What did NOT change

- No new deps.
- Existing argv snapshots pass byte-identical when `agents` is absent everywhere.
- Existing sessions preserve across same-provider model changes (Q2→C).
- `defaults.role`, `defaults.baseBranch`, and every other `defaults.*` field — untouched.
- The `PrFeedbackIntent` / `PhaseIntent` shape — `model?` was already added in #813.

## Related issues

- **#813** — Phase 1 issue 1: launcher registry widening (prerequisite, complete).
- **#815** (or next-in-series) — Phase 3: first concrete second provider (Codex or OpenCode).
- Multi-agent provider plan (Codex + OpenCode): Phase 1 issue 2 of 3.
