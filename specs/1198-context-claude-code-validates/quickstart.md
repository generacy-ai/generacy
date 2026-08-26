# Quickstart: Gateway model routing (#1198)

## What this does

Launches of Claude Code whose model string contains `/` (gateway-shaped, e.g. `openrouter/qwen/qwen3.5-coder`) get `CLAUDE_CONFIG_DIR=/home/node/.claude-gateway` injected into the spawned CLI's environment, pointing it at the gateway base URL instead of `api.anthropic.com`. Anthropic models and `undefined` are byte-identical to before — no flag needed.

## Using a gateway model

In `.generacy/config.yaml` (schema unchanged — `model` is free-form):

```yaml
agents:
  workflows:
    speckit-feature:
      phases:
        implement:
          model: openrouter/qwen/qwen3.5-coder
```

Prerequisite: the gateway config dir must be provisioned (out-of-band in MVP):

```bash
mkdir -p /home/node/.claude-gateway
cat > /home/node/.claude-gateway/settings.json <<'EOF'
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://gateway:4000",
    "ANTHROPIC_AUTH_TOKEN": "sk-..."
  }
}
EOF
```

## Overriding the gateway config dir

Precedence: explicit constructor option > env var > default.

```bash
# operator override (cluster-wide)
export GENERACY_CLAUDE_GATEWAY_CONFIG_DIR=/custom/gateway-config
```

```ts
// programmatic (tests, embedders)
new ClaudeCodeLaunchPlugin({ gatewayConfigDir: '/tmp/test-gateway' });
```

## Programmatic API

```ts
import {
  resolveRoute,
  GatewayRouteUnavailableError,
  DEFAULT_GATEWAY_CONFIG_DIR,
} from '@generacy-ai/generacy-plugin-claude-code';

resolveRoute('openai/gpt-5.5');       // 'gateway'
resolveRoute('claude-opus-4-7');      // 'subscription'
resolveRoute(undefined);              // 'subscription'
```

Note: check routes via `resolveRoute(model)`, not `LaunchSpec.route` — the field is absent (not `'subscription'`) on subscription launches.

## Troubleshooting

### `GatewayRouteUnavailableError`

```
Model "openrouter/x/y" requires the gateway route, but
/home/node/.claude-gateway/settings.json was not found. ...GENERACY_LLM_GATEWAY_URL...
```

Cause: a gateway-shaped model was configured but the gateway config dir has no `settings.json`.

Fix: provision `settings.json` (above). No restart needed — the missing-file result is never cached, so the very next launch picks it up.

### Gateway launch still hits `api.anthropic.com`

- Confirm the spawned process env: the launch must carry `CLAUDE_CONFIG_DIR` (check worker logs / `LaunchSpec.env`).
- Confirm `settings.json` actually sets `ANTHROPIC_BASE_URL` — this feature only checks the file *exists*, not its contents.

### Subscription launches behaving differently

They can't, by construction — subscription specs are returned unmodified (no `env`, no `route`). If you observe a diff, that's a bug against FR-004; the per-builder byte-identity tests pin it.

## Test seams

```ts
import { _resetGatewayProvisionCacheForTests } from '@generacy-ai/generacy-plugin-claude-code';

beforeEach(() => _resetGatewayProvisionCacheForTests());
```

The positive provision cache is process-lifetime; reset it between tests that create/delete temp gateway dirs.

## Out of scope (later epic phases)

- Gateway sidecar (Bifrost/LiteLLM) compose service + provisioning — P2/P3.
- Route-aware session invalidation — #1199.
- `generacy validate` / `generacy doctor` gateway checks — #1200.
