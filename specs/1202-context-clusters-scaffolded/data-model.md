# Data Model: Optional llm-gateway (Bifrost) scaffolding

## Modified interfaces (`cli/commands/cluster/scaffolder.ts`)

```ts
export interface ScaffoldClusterYamlInput {
  channel?: 'stable' | 'preview';
  workers?: number;
  variant: 'cluster-base' | 'cluster-microservices';
  llmGateway?: boolean;          // NEW — written as `llmGateway: true` only when true
}

export interface ScaffoldComposeInput {
  // …existing fields unchanged…
  llmGateway?: boolean;          // NEW — gates the llm-gateway service, volume, and env wiring
}

export interface ScaffoldEnvInput {
  // …existing fields unchanged…
  llmGateway?: boolean;          // NEW — gates token generation (preserve-existing always applies)
}
```

## Modified schema (`cli/commands/cluster/context.ts`)

```ts
export const ClusterYamlSchema = z.object({
  channel: z.enum(['stable', 'preview']).default('stable'),
  workers: z.number().int().positive().default(1),
  variant: z.enum(['cluster-base', 'cluster-microservices']).default('cluster-base'),
  appConfig: AppConfigSchema.optional(),
  llmGateway: z.boolean().default(false),   // NEW
});
```

## New module (`cli/commands/cluster/llm-gateway.ts`)

```ts
/** Precedence: explicit flag > GENERACY_LLM_GATEWAY_ENABLED=true > persisted cluster.yaml > false */
export function resolveLlmGatewayToggle(input: {
  flag?: boolean;                 // Commander --llm-gateway / --no-llm-gateway (undefined = absent)
  env?: string;                   // process.env.GENERACY_LLM_GATEWAY_ENABLED
  persisted?: boolean;            // existing cluster.yaml llmGateway, when readable
}): boolean;

/** 'sk-bf-' + 48 lowercase hex chars (randomBytes(24)) */
export function generateGatewayToken(): string;

/** Extracts an existing GENERACY_LLM_GATEWAY_TOKEN value from .env content, or undefined */
export function readExistingGatewayToken(envContent: string): string | undefined;

/**
 * Emits llm-gateway/config.example.json (always overwritten),
 * llm-gateway/config.json (create-if-absent from example),
 * llm-gateway/.gitignore, and .env.local (create-if-absent).
 */
export function scaffoldLlmGatewayFiles(dir: string): void;
```

## CLI options

| Command | Option | Type | Notes |
|---|---|---|---|
| `launch` | `--llm-gateway` / `--no-llm-gateway` | boolean pair | undefined when neither given |
| `deploy` | `--llm-gateway` / `--no-llm-gateway` | boolean pair | same resolver |
| both | `GENERACY_LLM_GATEWAY_ENABLED=true` | env | equivalent to `--llm-gateway` |

`LaunchOptions` (launch/types.ts) and the deploy options type gain `llmGateway?: boolean`.

## Token

- Format: `^sk-bf-[0-9a-f]{48}$` (prefix **required** — Bifrost 401s unprefixed Bearer tokens)
- Storage: single line in `.generacy/.env`: `GENERACY_LLM_GATEWAY_TOKEN=sk-bf-…`
- Lifecycle: generated once when enabled and absent; re-emitted verbatim on any re-scaffold that
  finds it (enabled **or** disabled); never regenerated, never deleted by the scaffolder
- Never appears literally in any config file — referenced as `env.GENERACY_LLM_GATEWAY_TOKEN`

## Emitted file inventory (gateway enabled)

| File | Write policy | Contents |
|---|---|---|
| `docker-compose.yml` | overwritten every scaffold | + `llm-gateway` service, `llm-gateway-data` volume, orchestrator/worker gateway env vars (see contracts/llm-gateway-compose.yml) |
| `cluster.yaml` | overwritten every scaffold | + `llmGateway: true` (key omitted when false) |
| `.env` | overwritten every scaffold | + token line (generate-once semantics via preserve-existing read) |
| `.env.local` | create-if-absent | commented `OPENROUTER_API_KEY=`, `FEATHERLESS_API_KEY=`, `OPENAI_API_KEY=` placeholders (see contracts/env-files.md) |
| `llm-gateway/config.example.json` | overwritten every scaffold | contracts/config.example.json |
| `llm-gateway/config.json` | create-if-absent (copy of example) | never overwritten — may be hand-edited |
| `llm-gateway/.gitignore` | create-if-absent | `config.json` |

Gateway disabled, fresh scaffold: none of the above appear; compose and `.env` byte-identical to
current output. Gateway disabled, previously-enabled dir: compose loses stanza + env vars; every
other artifact above is left untouched.

## Service topology (enabled)

```
orchestrator ──┐                        GENERACY_LLM_GATEWAY_URL=http://llm-gateway:8080/anthropic
worker ────────┼── cluster-network ──▶  llm-gateway (Bifrost :8080, no host port)
redis ─────────┘                        └─▶ OpenRouter / featherless / OpenAI (keys from .env.local)
```
