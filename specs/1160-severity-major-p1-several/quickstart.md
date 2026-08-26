# Quickstart: Per-workflow/agent config keys

After this feature, four previously-ignored keys take effect (or reject loudly).
Examples below are the minimal YAML for each, under `.generacy/config.yaml`.

## 1. Per-workflow `validateCommand`

```yaml
orchestrator:
  workflows:
    speckit-feature:
      validateCommand: "pnpm test:ci"
```

The `speckit-feature` validate phase now runs `pnpm test:ci`. Precedence:
`workflows.<name>` → repo-level `validateCommand` → cluster default. For
`speckit-bugfix`, the targeted-validate narrowing still composes on top.

## 2. Per-workflow `preValidateCommand`

```yaml
orchestrator:
  workflows:
    speckit-feature:
      preValidateCommand: "pnpm install --frozen-lockfile"
```

Skip the install step entirely with an empty string:

```yaml
orchestrator:
  workflows:
    speckit-bugfix:
      preValidateCommand: ""   # skips install for bugfix jobs
```

Empty string = skip; unset = fall back to repo/cluster default.

## 3. Per-phase `review` / `remediate` agent selection

```yaml
orchestrator:
  agents:
    workflows:
      speckit-bugfix:
        phases:
          review:
            model: "claude-haiku-4-5-20251001"   # cheaper model for review
```

The review phase uses the cheaper model while inheriting the implement agent's
provider and effort (field-by-field fallback). `phases.remediate` is resolved
independently; when unset it falls back directly to the implement agent (never
to `phases.review`), so the code-writing remediate phase is never downgraded by
a cheaper review model.

## 4. Per-workflow `ciWaitTimeoutMs`

```yaml
orchestrator:
  workflows:
    speckit-feature:
      ciWaitTimeoutMs: 1800000   # 30 min; must be an integer >= 30000
```

Previously this key failed to parse (schema was `.strict()` without it). Now it
parses and controls the CI-wait budget for that workflow. Precedence: workflow →
cluster `WORKER_CI_WAIT_TIMEOUT_MS`. A value below 30000 or a non-integer is
rejected at parse time.

## Verifying

- `pnpm --filter @generacy-ai/config test` — schema round-trip
  (`ciWaitTimeoutMs` accepted, unknown key still rejected).
- `pnpm --filter @generacy-ai/orchestrator test` — resolver + call-site
  round-trip tests for all four keys.

## Troubleshooting

- **`ciWaitTimeoutMs` rejected**: value must be an integer ≥ 30000 (ms).
- **Unknown key error under `workflows.<name>`**: `.strict()` rejects any key
  not in `WorkflowOverrideSchema` — check spelling against the four supported
  keys (`validateCommand`, `preValidateCommand`, `maxRemediations`,
  `ciWaitTimeoutMs`) plus `review`.
- **Review still using the implement model**: `phases.review` lives under
  `orchestrator.agents.workflows.<name>.phases`, not under
  `orchestrator.workflows.<name>`.
