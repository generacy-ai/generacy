# Contract: `agents` Config Schema

**Owner package**: `@generacy-ai/config` (`packages/config/src/template-schema.ts`) — source of truth for target-repo `.generacy/config.yaml`.

**Mirror package**: `@generacy-ai/generacy` (`packages/generacy/src/config/schema.ts`) — CLI-facing validation, re-exports schema.

## Shape

```yaml
orchestrator:
  agents:
    default:                            # OPTIONAL — global default
      provider: <string>                # OPTIONAL, non-empty
      model: <string>                   # OPTIONAL, non-empty
    workflows:                          # OPTIONAL — per-workflow overrides
      <workflow-name>:                  # e.g. speckit-feature, speckit-bugfix, speckit-epic, or custom
        default:                        # OPTIONAL
          provider: <string>
          model: <string>
        phases:                         # OPTIONAL — closed set (Q5→A)
          specify:  { provider?, model? }
          clarify:  { provider?, model? }
          plan:     { provider?, model? }
          tasks:    { provider?, model? }
          implement:{ provider?, model? }
          validate: { provider?, model? }
```

## Zod definition

Verbatim from `data-model.md` §1. Note: `phases` is enumerated per-field, not `z.record`, so typoed keys reject at parse time.

## Accepted examples

```yaml
# Minimal — set model globally, provider inherits from repo defaults.agent or built-in
orchestrator:
  agents:
    default:
      model: claude-opus-4-7
```

```yaml
# Per-phase model override
orchestrator:
  agents:
    workflows:
      speckit-feature:
        phases:
          specify: { model: claude-opus-4-7 }
          implement: { model: claude-sonnet-4-6 }
```

```yaml
# Full — cluster admin sets provider globally, per-workflow default overrides for review flow
orchestrator:
  agents:
    default:
      provider: claude-code
      model: claude-sonnet-4-6
    workflows:
      speckit-bugfix:
        default: { model: claude-opus-4-7 }   # bugfix uses stronger model everywhere
```

## Rejected examples

```yaml
# Empty provider — rejected by z.string().min(1)
orchestrator:
  agents:
    default: { provider: "" }
```

```yaml
# Typoed phase key — rejected by closed-enum phases object (Q5→A)
orchestrator:
  agents:
    workflows:
      speckit-feature:
        phases:
          implment: { model: claude-opus-4-7 }   # typo — Zod rejects
```

```yaml
# Non-string model — rejected by z.string()
orchestrator:
  agents:
    default: { model: 42 }
```

## Env-var equivalents

| Env var | YAML equivalent | Notes |
|---|---|---|
| `WORKER_AGENT_PROVIDER=<p>` | `agents.default.provider: <p>` | Independent from model (Q3→A). |
| `WORKER_AGENT_MODEL=<m>` | `agents.default.model: <m>` | Independent from provider. |
| `ORCHESTRATOR_WORKER_AGENT_PROVIDER=<p>` | (same as above) | Legacy prefix accepted. |
| `ORCHESTRATOR_WORKER_AGENT_MODEL=<m>` | (same as above) | Legacy prefix accepted. |

Env-var tier merges into `config.worker.agents.default` before the target-repo overlay.

## Precedence

See `data-model.md` §6. Independent walks for `provider` and `model`.

## Non-goals

- Model-ID allowlist / kebab-case check (Q4→A opaque pass-through).
- Custom-workflow phase names (Q5→A closed set — widen the Zod enum later, non-breaking).
- Dedicated `agents.prFeedback` slot (Q1→B binds to `implement`).
