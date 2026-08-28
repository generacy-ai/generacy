# Clarifications

## Batch 1 — 2026-08-28

### Q1: Gateway toggle persistence across re-scaffolds
**Context**: `scaffoldDockerCompose` (`packages/generacy/src/cli/commands/cluster/scaffolder.ts:125`) rewrites `docker-compose.yml` unconditionally on every `launch`/`deploy` run, and `.generacy/cluster.yaml` (`ScaffoldClusterYamlInput`: channel/workers/variant) is the durable per-project config. If `--llm-gateway` is a per-invocation flag only, re-running `launch` on an existing gateway-enabled cluster without the flag silently drops the `llm-gateway` stanza. (`generacy update` does not re-scaffold compose — it only reconciles `WORKER_COUNT` into `.env` — so this bites launch/deploy re-runs specifically.)

**Question**: Should the gateway toggle be persisted in `.generacy/cluster.yaml` so subsequent scaffolds preserve it without repeating the flag?
**Options**:
- A: Persist `llmGateway: true` in `cluster.yaml` when the flag/env is passed; later scaffolds default from it. Disabling requires an explicit `--no-llm-gateway` (or editing cluster.yaml).
- B: Per-invocation only — re-running launch without the flag regenerates compose without the gateway (gateway files stay orphaned on disk).
- C: Per-invocation, but the scaffolder warns when the existing compose contains `llm-gateway` and the toggle is absent.

**Answer**: *Pending*

### Q2: How the cluster-local token reaches Bifrost's inbound auth
**Context**: FR-004 says the generated `GENERACY_LLM_GATEWAY_TOKEN` "is set as Bifrost's inbound auth key in the scaffolded config", but `llm-gateway/config.json` is create-once/never-overwrite and is a bind-mounted JSON file — compose `${VAR}` interpolation does not apply inside it. Separately, FR-002 gives the gateway service `env_file: .env.local` while FR-004 has `scaffoldEnvFile` generating the token into `.env` — two different files.
**Question**: How should the token be delivered to Bifrost, and does it appear literally in `config.json`?
**Options**:
- A: Literal value substituted into `config.json` when it is first created from the example (example carries a placeholder). Token rotation then requires hand-editing `config.json`.
- B: `config.json` stays token-free — it references the env var via Bifrost's `env.`-prefix syntax, and the compose stanza passes `GENERACY_LLM_GATEWAY_TOKEN=${GENERACY_LLM_GATEWAY_TOKEN}` (interpolated from `.env`) into the gateway container's environment.
- C: Match whatever the tetrad-development#109 stanza + config do, verbatim, even if it differs from A/B.

**Answer**: *Pending*

### Q3: `.env.local.template` does not exist in scaffolder output today
**Context**: FR-007 says `.env.local.template` "gains" three commented provider-key placeholders, but the current scaffolder never emits `.env.local` or any template for it — `.env.local` appears only as an optional `env_file` entry in the compose. (The `init` command emits `.generacy/generacy.env.template`, a different file.)
**Question**: Where should the commented `OPENROUTER_API_KEY` / `FEATHERLESS_API_KEY` / `OPENAI_API_KEY` placeholders live?
**Options**:
- A: The scaffolder starts emitting `.generacy/.env.local.template` — but only when the gateway is enabled, preserving US2's byte-identical disabled path. Never overwrite an existing one.
- B: Append the placeholders to the existing `generacy.env.template` emitted by `init`.
- C: Skip the template — scaffold a commented `.env.local` directly (create-if-absent, never overwrite).

**Answer**: *Pending*

### Q4: Bifrost image tag selection
**Context**: FR-002 requires a pinned explicit tag ("not `latest`") and simultaneously a port of the tetrad-development#109 stanza. If the tetrad compose pins `latest` or a moving tag, the port cannot satisfy both constraints, and the spec does not name a tag.
**Question**: What governs the pinned `maximhq/bifrost:<tag>` value?
**Options**:
- A: Use the exact tag from the tetrad-dev compose at implementation time; if that is `latest`/moving, resolve it to the concrete version it currently points at, pin that, and note it in the PR's stanza diff.
- B: Pin the newest upstream Bifrost release at implementation time, independent of tetrad.
- C: Maintainer names the tag now (answer with the tag).

**Answer**: *Pending*

### Q5: Disabled-path behavior on a previously gateway-enabled cluster
**Context**: US2's byte-identical guarantee is defined for fresh scaffolds. On a cluster previously scaffolded with the gateway, a later disabled-path re-scaffold leaves `llm-gateway/config.json` (gitignored, possibly hand-edited), the generated token line in `.env`, and any template placeholders on disk.
**Question**: What should a disabled-path scaffold do with pre-existing gateway artifacts?
**Options**:
- A: Leave everything untouched — only the compose stanza and service env vars disappear; never delete user files or `.env` values.
- B: Remove the generated token from `.env` but leave the `llm-gateway/` directory.
- C: Full cleanup — remove `llm-gateway/`, the token, and template placeholders.

**Answer**: *Pending*
