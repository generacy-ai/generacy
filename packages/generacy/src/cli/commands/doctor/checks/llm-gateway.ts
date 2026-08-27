import { resolveRoute } from '@generacy-ai/generacy-plugin-claude-code';
import type { GeneracyConfig } from '../../../../config/index.js';
import type { AgentEntry, AgentsConfig } from '../../../../config/schema.js';
import type { CheckDefinition, CheckContext, CheckResult } from '../types.js';

const REQUEST_TIMEOUT_MS = 2_000;
const TOKEN_SUGGESTION =
  'Set GENERACY_LLM_GATEWAY_TOKEN to a valid gateway auth token in this environment.';
const REACHABILITY_SUGGESTION =
  'Verify GENERACY_LLM_GATEWAY_URL points at a reachable gateway. Check your network connection or proxy settings.';

const COCKPIT_AGENT_ROLES = [
  'clarifier',
  'reviewer',
  'validator',
  'fixer',
  'diagnoser',
] as const;

const isObject = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null;

/**
 * Find the first config-declared model that resolves to the gateway route,
 * walking the same tiers (and order) as `collectGatewayWarnings`:
 * orchestrator agents → workflow defaults → phases → cockpit block.
 */
function findFirstGatewayRoutedModel(config: GeneracyConfig | null): string | undefined {
  if (!config) return undefined;

  const check = (entry: AgentEntry | undefined): string | undefined => {
    const model = entry?.model;
    if (typeof model === 'string' && resolveRoute(model) === 'gateway') return model;
    return undefined;
  };

  const agents = config.orchestrator?.agents as AgentsConfig | undefined;
  if (agents) {
    const fromDefault = check(agents.default);
    if (fromDefault) return fromDefault;

    const workflows = agents.workflows ?? {};
    for (const wfEntry of Object.values(workflows)) {
      if (!wfEntry) continue;
      const fromWfDefault = check(wfEntry.default);
      if (fromWfDefault) return fromWfDefault;

      const phases = wfEntry.phases ?? {};
      for (const phaseEntry of Object.values(phases)) {
        const fromPhase = check(phaseEntry);
        if (fromPhase) return fromPhase;
      }
    }
  }

  const cockpit = (config as { cockpit?: unknown }).cockpit;
  if (isObject(cockpit) && isObject(cockpit.auto) && isObject(cockpit.auto.agents)) {
    const cockpitAgents = cockpit.auto.agents;
    const readModel = (value: unknown): string | undefined => {
      if (!isObject(value)) return undefined;
      return typeof value.model === 'string' ? value.model : undefined;
    };
    const defaultModel = readModel(cockpitAgents.default);
    if (defaultModel && resolveRoute(defaultModel) === 'gateway') return defaultModel;
    for (const role of COCKPIT_AGENT_ROLES) {
      const roleModel = readModel(cockpitAgents[role]);
      if (roleModel && resolveRoute(roleModel) === 'gateway') return roleModel;
    }
  }

  return undefined;
}

function networkFailure(error: unknown): CheckResult {
  const detail = error instanceof Error ? error.message : String(error);
  return {
    status: 'fail',
    message: 'Failed to reach the LLM gateway',
    suggestion: REACHABILITY_SUGGESTION,
    detail,
  };
}

export const llmGatewayCheck: CheckDefinition = {
  id: 'llm-gateway',
  label: 'LLM Gateway',
  category: 'services',
  dependencies: ['config'],
  priority: 'P1',

  async run(context: CheckContext): Promise<CheckResult> {
    const url = context.envVars?.GENERACY_LLM_GATEWAY_URL ?? process.env.GENERACY_LLM_GATEWAY_URL;
    const token =
      context.envVars?.GENERACY_LLM_GATEWAY_TOKEN ?? process.env.GENERACY_LLM_GATEWAY_TOKEN;

    if (!url || url.trim() === '') {
      return {
        status: 'skip',
        message: 'Skipped — GENERACY_LLM_GATEWAY_URL is not set (gateway not configured)',
      };
    }

    if (!token || token.trim() === '') {
      return {
        status: 'fail',
        message: 'GENERACY_LLM_GATEWAY_URL is set but GENERACY_LLM_GATEWAY_TOKEN is missing',
        suggestion: TOKEN_SUGGESTION,
      };
    }

    const base = url.replace(/\/+$/, '');
    const authHeaders = { Authorization: `Bearer ${token}` };

    // Primary probe: GET /v1/models
    let modelsResponse: Response;
    try {
      modelsResponse = await fetch(`${base}/v1/models`, {
        headers: authHeaders,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error: unknown) {
      return networkFailure(error);
    }

    if (modelsResponse.status === 200) {
      let detail: string | undefined;
      try {
        const body = (await modelsResponse.json()) as { data?: Array<{ id?: unknown }> };
        const ids = Array.isArray(body?.data)
          ? body.data
              .map((m) => m?.id)
              .filter((id): id is string => typeof id === 'string')
          : [];
        if (ids.length > 0) detail = `Models: ${ids.join(', ')}`;
      } catch {
        // Best-effort — a 200 without a parseable model list is still a pass.
      }
      return {
        status: 'pass',
        message: 'LLM gateway is reachable and authenticated',
        detail,
      };
    }

    if (modelsResponse.status === 401) {
      return {
        status: 'fail',
        message: 'LLM gateway rejected the token (HTTP 401)',
        suggestion: TOKEN_SUGGESTION,
      };
    }

    if (modelsResponse.status !== 404 && modelsResponse.status !== 405) {
      return {
        status: 'fail',
        message: `LLM gateway returned HTTP ${modelsResponse.status}`,
        suggestion: REACHABILITY_SUGGESTION,
        detail: `HTTP ${modelsResponse.status}`,
      };
    }

    // Fallback probe (on 404/405): POST /v1/messages with a config-declared model.
    const model = findFirstGatewayRoutedModel(context.config);
    if (!model) {
      return {
        status: 'warn',
        message:
          'LLM gateway is reachable but could not be verified — no gateway-routed model found in config to probe /v1/messages',
        suggestion:
          'Set a gateway-routed model (one containing "/") in .generacy/config.yaml to enable full verification.',
      };
    }

    let messagesResponse: Response;
    try {
      messagesResponse = await fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: {
          ...authHeaders,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }],
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error: unknown) {
      return networkFailure(error);
    }

    if (messagesResponse.status === 200) {
      return {
        status: 'pass',
        message: 'LLM gateway is reachable and authenticated (verified via /v1/messages)',
        detail: `Probed model: ${model}`,
      };
    }

    if (messagesResponse.status === 401) {
      return {
        status: 'fail',
        message: 'LLM gateway rejected the token (HTTP 401)',
        suggestion: TOKEN_SUGGESTION,
      };
    }

    return {
      status: 'fail',
      message: `LLM gateway returned HTTP ${messagesResponse.status}`,
      suggestion: REACHABILITY_SUGGESTION,
      detail: `HTTP ${messagesResponse.status}`,
    };
  },
};
