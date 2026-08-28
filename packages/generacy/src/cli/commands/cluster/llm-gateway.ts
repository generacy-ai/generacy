/**
 * Optional llm-gateway (Bifrost) scaffolding helpers.
 *
 * Toggle resolution, the cluster-local auth token, and the gateway config /
 * secrets files. All emission is gated by the `llmGateway` boolean upstream;
 * these helpers are only invoked on the enabled path (except the token
 * preserve-existing rule, which also fires on a disabled re-scaffold).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

/**
 * Resolve the gateway toggle. Precedence:
 * explicit CLI flag > GENERACY_LLM_GATEWAY_ENABLED === 'true' > persisted
 * cluster.yaml value > false.
 */
export function resolveLlmGatewayToggle(input: {
  flag?: boolean;
  env?: string;
  persisted?: boolean;
}): boolean {
  if (input.flag !== undefined) return input.flag;
  if (input.env === 'true') return true;
  if (input.persisted !== undefined) return input.persisted;
  return false;
}

/**
 * Generate a cluster-local gateway token: `sk-bf-` + 48 lowercase hex chars.
 *
 * The `sk-bf-` prefix is mandatory — Bifrost only accepts a virtual key on the
 * Authorization: Bearer header when it starts with `sk-bf-`.
 */
export function generateGatewayToken(): string {
  return 'sk-bf-' + randomBytes(24).toString('hex');
}

/**
 * Extract an existing GENERACY_LLM_GATEWAY_TOKEN value from `.env` content.
 * Returns undefined when the line is absent or the value is empty.
 */
export function readExistingGatewayToken(envContent: string): string | undefined {
  const match = envContent.match(/^GENERACY_LLM_GATEWAY_TOKEN=(.*)$/m);
  if (!match) return undefined;
  const value = (match[1] ?? '').trim();
  return value.length > 0 ? value : undefined;
}

const CONFIG_EXAMPLE_JSON = `{
  "$schema": "https://www.getbifrost.ai/schema",
  "client": {
    "drop_excess_requests": false,
    "enforce_auth_on_inference": true,
    "enable_logging": true,
    "log_retention_days": 7
  },
  "providers": {
    "openrouter": {
      "keys": [
        {
          "name": "openrouter",
          "value": "env.OPENROUTER_API_KEY",
          "models": ["*"],
          "weight": 1.0
        }
      ]
    },
    "openai": {
      "keys": [
        {
          "name": "openai",
          "value": "env.OPENAI_API_KEY",
          "models": ["*"],
          "weight": 1.0
        }
      ]
    },
    "featherless": {
      "keys": [
        {
          "name": "featherless",
          "value": "env.FEATHERLESS_API_KEY",
          "models": ["*"],
          "weight": 1.0
        }
      ],
      "network_config": {
        "base_url": "https://api.featherless.ai"
      },
      "custom_provider_config": {
        "base_provider_type": "openai",
        "allowed_requests": {
          "list_models": false,
          "chat_completion": true,
          "chat_completion_stream": true
        }
      }
    }
  },
  "governance": {
    "virtual_keys": [
      {
        "id": "generacy-cluster",
        "name": "generacy-cluster",
        "description": "Cluster-local inbound key. Claude Code presents it as ANTHROPIC_AUTH_TOKEN (Authorization: Bearer). The value comes from GENERACY_LLM_GATEWAY_TOKEN in the cluster .env and MUST start with sk-bf- — Bifrost only recognises non-prefixed virtual keys on the x-bf-vk header, which Claude Code never sends. Note: count_tokens is not supported by non-Anthropic upstreams — Claude Code falls back to client-side counting; custom providers scope acceptance via custom_provider_config.allowed_requests.",
        "value": "env.GENERACY_LLM_GATEWAY_TOKEN",
        "is_active": true,
        "provider_configs": [
          { "provider": "openrouter", "allowed_models": ["*"], "key_ids": ["*"] },
          { "provider": "openai", "allowed_models": ["*"], "key_ids": ["*"] },
          { "provider": "featherless", "allowed_models": ["*"], "key_ids": ["*"] }
        ]
      }
    ]
  }
}
`;

const ENV_LOCAL_CONTENTS = `# LLM gateway provider keys (secrets — do not commit; this file is gitignored)
# Each key is optional: a provider whose key is absent is skipped at boot, and
# calls to it return HTTP 400 "no valid keys found for provider: <name>". The
# gateway still starts and stays healthy (fails closed).
#
# Note: /v1/messages/count_tokens is not supported by non-Anthropic upstreams —
# Claude Code falls back to client-side context counting. Custom providers scope
# accepted request types via custom_provider_config.allowed_requests in
# llm-gateway/config.json.

# https://openrouter.ai/settings/keys — models addressed as openrouter/<vendor>/<model>
OPENROUTER_API_KEY=

# https://featherless.ai/account/api-keys — models addressed as featherless/<HF repo>
FEATHERLESS_API_KEY=

# https://platform.openai.com/api-keys — models addressed as openai/<model>
# API-key billing only; ChatGPT/Codex subscriptions are not supported behind a
# shared gateway.
OPENAI_API_KEY=
`;

/**
 * Emit the gateway config + secrets files under `dir` (the `.generacy/`
 * scaffold target). Only called on the gateway-enabled path.
 *
 * - `llm-gateway/config.example.json` — generated artifact, overwritten every scaffold.
 * - `llm-gateway/config.json` — copied from the example only if absent; never overwritten.
 * - `llm-gateway/.gitignore` — ignores config.json.
 * - `.env.local` — operator-owned provider keys; create-if-absent, never overwritten.
 */
export function scaffoldLlmGatewayFiles(dir: string): void {
  const gatewayDir = join(dir, 'llm-gateway');
  mkdirSync(gatewayDir, { recursive: true });

  const examplePath = join(gatewayDir, 'config.example.json');
  writeFileSync(examplePath, CONFIG_EXAMPLE_JSON, 'utf-8');

  const configPath = join(gatewayDir, 'config.json');
  if (!existsSync(configPath)) {
    writeFileSync(configPath, CONFIG_EXAMPLE_JSON, 'utf-8');
  }

  const gitignorePath = join(gatewayDir, '.gitignore');
  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, 'config.json\n', 'utf-8');
  }

  const envLocalPath = join(dir, '.env.local');
  if (!existsSync(envLocalPath)) {
    writeFileSync(envLocalPath, ENV_LOCAL_CONTENTS, 'utf-8');
  }
}
