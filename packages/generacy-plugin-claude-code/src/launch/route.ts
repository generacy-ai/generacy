import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Which config/auth route a launch takes.
 *
 * - `subscription`: the CLI's default config dir; Anthropic-native models the
 *   CLI validates against `api.anthropic.com`.
 * - `gateway`: a second config dir whose `settings.json` points the CLI at the
 *   Generacy LLM gateway (`ANTHROPIC_BASE_URL`), letting any provider/model
 *   string through.
 */
export type Route = 'subscription' | 'gateway';

/**
 * Default location of the gateway config dir. The gateway `settings.json` is
 * provisioned out-of-band; this feature only checks for its presence.
 */
export const DEFAULT_GATEWAY_CONFIG_DIR = '/home/node/.claude-gateway';

/**
 * Resolve the launch route purely from the model name.
 *
 * A provider-qualified model (containing `/`, e.g. `openai/gpt-5.5`) routes to
 * the gateway; a bare Anthropic id/alias (`opus`, `claude-sonnet-4-5[1m]`) —
 * and an absent model — routes to the subscription config dir.
 *
 * Pure: no I/O, no env reads, no cache. Consumers needing route comparison
 * (e.g. #1199 session invalidation) MUST call this directly — `LaunchSpec.route`
 * is `undefined` on subscription launches and unsuitable for comparison.
 */
export function resolveRoute(model?: string): Route {
  return model !== undefined && model.includes('/') ? 'gateway' : 'subscription';
}

/**
 * Resolve the gateway config dir.
 *
 * Precedence (nullish only — an explicit empty string wins over the env var):
 * explicit option > `GENERACY_CLAUDE_GATEWAY_CONFIG_DIR` > default.
 * Called once per plugin construction, not per launch.
 */
export function resolveGatewayConfigDir(explicit?: string): string {
  return explicit ?? process.env.GENERACY_CLAUDE_GATEWAY_CONFIG_DIR ?? DEFAULT_GATEWAY_CONFIG_DIR;
}

/**
 * Raised when a gateway-routed model is launched but the gateway config dir has
 * no `settings.json` — the CLI would silently fall back to the subscription
 * config and fail to reach the gateway.
 */
export class GatewayRouteUnavailableError extends Error {
  readonly name = 'GatewayRouteUnavailableError';
  readonly model: string;
  readonly gatewayConfigDir: string;

  constructor(model: string, gatewayConfigDir: string) {
    super(
      `Model "${model}" requires the gateway route, but ${join(gatewayConfigDir, 'settings.json')} was not found. ` +
        `Provision the gateway config dir (see GENERACY_LLM_GATEWAY_URL) or use an Anthropic model.`,
    );
    this.model = model;
    this.gatewayConfigDir = gatewayConfigDir;
  }
}

/**
 * Process-lifetime, positive-only cache of gateway config dirs already
 * confirmed to hold a `settings.json`. Keyed by dir path. A missing dir is
 * NEVER cached, so provisioning takes effect on the next launch without an
 * invalidation step.
 */
const provisionedDirs = new Set<string>();

/**
 * Assert the gateway config dir is provisioned, throwing otherwise.
 *
 * - dir in the positive cache → return without touching the filesystem
 * - `<dir>/settings.json` exists → cache the dir + return
 * - `<dir>/settings.json` absent → throw `GatewayRouteUnavailableError`
 */
export function assertGatewayProvisioned(model: string, gatewayConfigDir: string): void {
  if (provisionedDirs.has(gatewayConfigDir)) return;
  if (existsSync(join(gatewayConfigDir, 'settings.json'))) {
    provisionedDirs.add(gatewayConfigDir);
    return;
  }
  throw new GatewayRouteUnavailableError(model, gatewayConfigDir);
}

/**
 * Test-only: clear the positive provision cache. Not part of the public API.
 */
export function _resetGatewayProvisionCacheForTests(): void {
  provisionedDirs.clear();
}
