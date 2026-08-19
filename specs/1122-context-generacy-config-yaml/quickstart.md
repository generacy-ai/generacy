# Quickstart: Per-workflow orchestrator overrides

## What this adds

A `workflows` map under the `orchestrator` block of a target repo's
`.generacy/config.yaml`, letting `validateCommand`, `preValidateCommand`,
`maxRemediations`, and a `review` block vary **per workflow** (e.g. `speckit-feature` vs
`speckit-bugfix`). This feature ships the **config surface + resolver only**; the
review/remediate phases that consume `maxRemediations`/`review` land later (epic #1120).

## Configure a repo

Edit `.generacy/config.yaml` in the target repo:

```yaml
orchestrator:
  validateCommand: "pnpm build"          # repo-wide default (tier 2)
  workflows:
    speckit-feature:
      validateCommand: "pnpm test && pnpm build"
      maxRemediations: 3
      review:
        blockingSeverity: major          # inherits profile=standard, failThenPass=false
    speckit-bugfix:
      preValidateCommand: ""             # skip install for bugfix jobs
      maxRemediations: 2
      review:
        profile: verification
```

- Omit the whole `workflows` block → behavior is byte-identical to before (non-breaking).
- Any unknown key, a negative `maxRemediations`, or an out-of-enum `review.profile` fails
  the config parse loudly at load time.

## Precedence (what wins)

| Field | Precedence |
|-------|-----------|
| `validateCommand`, `preValidateCommand` | `workflows.<name>` → `orchestrator.<field>` → cluster default |
| `maxRemediations` | `workflows.<name>` → built-in (`speckit-bugfix`=2, else=3) |
| `review.*` | `workflows.<name>.review.<sub>` → built-in (`standard` / `critical` / `false`) |

Each field resolves independently — set only `review.blockingSeverity` and the other
`review` sub-fields still fall back to the built-in default.

## Using the resolver (from a future phase)

```ts
import { resolveWorkflowOverrides } from './config.js';

const resolved = resolveWorkflowOverrides(config, orchSettings, 'speckit-bugfix');
// resolved.validateCommand / preValidateCommand / maxRemediations / review
```

Mirrors the existing `resolveAgentForPhase(config, workflowName, phase)` call sites
(`phase-loop.ts:528`, `pr-feedback-handler.ts:861`).

## Run the tests

```bash
pnpm --filter @generacy-ai/config test         # schema parse/validation
pnpm --filter @generacy-ai/orchestrator test   # resolver precedence (SC-001..SC-005)
```

## Troubleshooting

- **"Unrecognized key(s) in object"** at load — a typo in a `workflows.<name>` field; the
  value schema is `.strict()`. Check against the four allowed keys: `validateCommand`,
  `preValidateCommand`, `maxRemediations`, `review`.
- **`maxRemediations` seems ignored** — no phase consumes it yet; this feature only exposes
  and resolves it. Consumption arrives with epic #1120.
- **Empty `preValidateCommand` runs install anyway** — confirm it is set to `""` at the
  right tier; an *absent* key falls through to the lower tier's value.
