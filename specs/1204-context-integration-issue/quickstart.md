# Quickstart: P3 Integration Validation

How to use the artifacts on this branch once the implement phase has produced them.

## Who runs what

- **Worker/implement phase**: authors `runbook.md`, the `results.md` template, the
  criteria contract, and the optional stanza-diff helper. No cluster runs.
- **Operator**: executes `runbook.md` end-to-end and fills in `results.md`.

## Prerequisites (runbook step 0 — hard gate)

All must be merged **and published** before any run step:

| Contract | Where to verify |
|----------|-----------------|
| generacy#1202 (`--llm-gateway` scaffolder flag) | published `@generacy-ai/generacy` npm version |
| cluster-base#90 (`setup-claude-gateway-config.sh`) | cluster-base image tag (`:preview`/`:stable`) |
| generacy-cloud#919 (`llmGatewayEnabled` template) | generacy-cloud deploy ref |

Also required: a staging cloud environment, a provider API key (gateway model with
**≥128k context** — 32k models pass smoke tests then fail on real files), and a
disposable target repo for the dogfood issues.

## Running the validation

```bash
# 1. Local leg
generacy launch --llm-gateway   # published package, not tetrad dev
# put provider key + GENERACY_LLM_GATEWAY_TOKEN (sk-bf-…) in .env.local
# create disposable speckit-bugfix issue per the #1203 template;
# commit mixed-route orchestrator.agents on the target repo's working branch

# 2. Evidence
# capture worker logs + Bifrost access log promptly (7-day retention);
# evaluate contracts/route-discrimination-criteria.md (C1–C3)

# 3. Cloud leg — deploy staging with llmGatewayEnabled=true, repeat with a
#    second disposable issue

# 4. Four-way stanza diff
specs/1204-context-integration-issue/scripts/diff-gateway-stanza.sh
# canon: tetrad-development/.devcontainer/generacy/docker-compose.yml:180-218
# classify every hunk: intentional | fixed-here | filed

# 5. cockpit auto observation — mixed cockpit.auto.agents block; append
#    observed behavior to agency#510

# 6. Closeout — flip tetrad-development/docs/llm-gateway-model-routing-plan.md
#    to "P3 complete"; commit the filled results.md
```

## Troubleshooting

| Symptom | Likely cause |
|---------|--------------|
| Bifrost crash-loop: "failed to prune governance config … FOREIGN KEY constraint failed" | `source_of_truth: config.json` set with an unresolved token env ref — remove it (canon has none) |
| Gateway starts but model can't read large files | 32k-context model selected — re-check `context_length` ≥128k |
| Removed provider still active after config edit | Bifrost "split" reconciliation — `docker compose rm -sfv llm-gateway` to reset |
| Mixed-route overrides ignored on the dogfood run | `orchestrator.agents` block not committed/pushed on the *target repo's* working branch |
| Gateway service missing from scaffolded cluster | Prerequisite gate failed — #1202 not in the published package version |

## Next step

Generate the task list: `/speckit:tasks`
