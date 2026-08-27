/**
 * SC-002: `llmGatewayCheck` skips when the gateway URL is unset, fails fast on a
 * missing token *without* fetching, and probes `/v1/models` (falling back to a
 * `/v1/messages` POST on 404/405) when both env vars are present.
 *
 * `fetch` is stubbed via `vi.stubGlobal`; env is controlled with `vi.stubEnv`
 * (for the `process.env` fallback) and `context.envVars` (for precedence — Q2=C).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { llmGatewayCheck } from '../../checks/llm-gateway.js';
import type { CheckContext } from '../../types.js';
import type { GeneracyConfig } from '../../../../../config/index.js';

const mockFetch = vi.fn();

const GATEWAY_MODEL = 'my-org/gpt-4o';

function makeContext(overrides: Partial<CheckContext> = {}): CheckContext {
  return {
    configPath: null,
    config: null,
    envVars: null,
    inDevContainer: false,
    verbose: false,
    projectRoot: null,
    ...overrides,
  };
}

function makeResponse(options: {
  status?: number;
  body?: object | string;
}): Response {
  const { status = 200, body = {} } = options;
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(),
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response;
}

function configWithGatewayModel(): GeneracyConfig {
  return {
    schemaVersion: '1',
    project: { id: 'proj_gw', name: 'GW' },
    repos: { primary: 'github.com/test/repo', dev: [], clone: [] },
    orchestrator: { agents: { default: { model: GATEWAY_MODEL } } },
  } as unknown as GeneracyConfig;
}

describe('llmGatewayCheck — SC-002 (issue #1200)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal('fetch', mockFetch);
    // Ensure a clean process.env baseline for every case.
    vi.stubEnv('GENERACY_LLM_GATEWAY_URL', '');
    vi.stubEnv('GENERACY_LLM_GATEWAY_TOKEN', '');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('has correct metadata', () => {
    expect(llmGatewayCheck.id).toBe('llm-gateway');
    expect(llmGatewayCheck.label).toBe('LLM Gateway');
    expect(llmGatewayCheck.category).toBe('services');
    expect(llmGatewayCheck.dependencies).toEqual(['config']);
    expect(llmGatewayCheck.priority).toBe('P1');
  });

  it('skips when the gateway URL is unset', async () => {
    const result = await llmGatewayCheck.run(makeContext());

    expect(result.status).toBe('skip');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('fails without fetching when the URL is set but the token is missing', async () => {
    const result = await llmGatewayCheck.run(
      makeContext({ envVars: { GENERACY_LLM_GATEWAY_URL: 'https://gw.example' } }),
    );

    expect(result.status).toBe('fail');
    expect(result.message).toContain('GENERACY_LLM_GATEWAY_TOKEN');
    expect(result.suggestion).toContain('GENERACY_LLM_GATEWAY_TOKEN');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('passes on a 200 from /v1/models and lists the models in detail', async () => {
    mockFetch.mockResolvedValue(
      makeResponse({
        status: 200,
        body: { data: [{ id: 'my-org/gpt-4o' }, { id: 'my-org/claude' }] },
      }),
    );

    const result = await llmGatewayCheck.run(
      makeContext({
        envVars: {
          GENERACY_LLM_GATEWAY_URL: 'https://gw.example',
          GENERACY_LLM_GATEWAY_TOKEN: 'tok',
        },
      }),
    );

    expect(result.status).toBe('pass');
    expect(result.detail).toContain('my-org/gpt-4o');
    expect(result.detail).toContain('my-org/claude');

    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('https://gw.example/v1/models');
    expect(options.headers.Authorization).toBe('Bearer tok');
  });

  it('fails with a token suggestion on 401 from /v1/models', async () => {
    mockFetch.mockResolvedValue(makeResponse({ status: 401 }));

    const result = await llmGatewayCheck.run(
      makeContext({
        envVars: {
          GENERACY_LLM_GATEWAY_URL: 'https://gw.example',
          GENERACY_LLM_GATEWAY_TOKEN: 'bad',
        },
      }),
    );

    expect(result.status).toBe('fail');
    expect(result.message).toContain('401');
    expect(result.suggestion).toContain('GENERACY_LLM_GATEWAY_TOKEN');
  });

  it('fails with the HTTP status on a non-200/404/405 from /v1/models', async () => {
    mockFetch.mockResolvedValue(makeResponse({ status: 500 }));

    const result = await llmGatewayCheck.run(
      makeContext({
        envVars: {
          GENERACY_LLM_GATEWAY_URL: 'https://gw.example',
          GENERACY_LLM_GATEWAY_TOKEN: 'tok',
        },
      }),
    );

    expect(result.status).toBe('fail');
    expect(result.message).toContain('500');
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('falls back to POST /v1/messages on a 404 from /v1/models (FR-010)', async () => {
    mockFetch
      .mockResolvedValueOnce(makeResponse({ status: 404 }))
      .mockResolvedValueOnce(makeResponse({ status: 200 }));

    const result = await llmGatewayCheck.run(
      makeContext({
        config: configWithGatewayModel(),
        envVars: {
          GENERACY_LLM_GATEWAY_URL: 'https://gw.example',
          GENERACY_LLM_GATEWAY_TOKEN: 'tok',
        },
      }),
    );

    expect(mockFetch).toHaveBeenCalledTimes(2);
    const [fallbackUrl, fallbackOptions] = mockFetch.mock.calls[1];
    expect(fallbackUrl).toBe('https://gw.example/v1/messages');
    expect(fallbackOptions.method).toBe('POST');
    const parsedBody = JSON.parse(fallbackOptions.body as string);
    expect(parsedBody.model).toBe(GATEWAY_MODEL);
    expect(result.status).toBe('pass');
  });

  it('maps a 401 fallback response to a token failure (FR-010)', async () => {
    mockFetch
      .mockResolvedValueOnce(makeResponse({ status: 405 }))
      .mockResolvedValueOnce(makeResponse({ status: 401 }));

    const result = await llmGatewayCheck.run(
      makeContext({
        config: configWithGatewayModel(),
        envVars: {
          GENERACY_LLM_GATEWAY_URL: 'https://gw.example',
          GENERACY_LLM_GATEWAY_TOKEN: 'tok',
        },
      }),
    );

    expect(result.status).toBe('fail');
    expect(result.suggestion).toContain('GENERACY_LLM_GATEWAY_TOKEN');
  });

  it('warns when the fallback is reached but no gateway-routed model is in config', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse({ status: 404 }));

    const result = await llmGatewayCheck.run(
      makeContext({
        config: null,
        envVars: {
          GENERACY_LLM_GATEWAY_URL: 'https://gw.example',
          GENERACY_LLM_GATEWAY_TOKEN: 'tok',
        },
      }),
    );

    expect(result.status).toBe('warn');
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('fails with a reachability suggestion on a network error (ECONNREFUSED)', async () => {
    mockFetch.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:443'));

    const result = await llmGatewayCheck.run(
      makeContext({
        envVars: {
          GENERACY_LLM_GATEWAY_URL: 'https://gw.example',
          GENERACY_LLM_GATEWAY_TOKEN: 'tok',
        },
      }),
    );

    expect(result.status).toBe('fail');
    expect(result.suggestion).toContain('reachable');
    expect(result.detail).toContain('ECONNREFUSED');
  });

  it('prefers context.envVars over process.env (Q2=C)', async () => {
    // process.env says the gateway is unset; envVars supplies it → must NOT skip.
    vi.stubEnv('GENERACY_LLM_GATEWAY_URL', '');
    mockFetch.mockResolvedValue(makeResponse({ status: 200, body: { data: [] } }));

    const result = await llmGatewayCheck.run(
      makeContext({
        envVars: {
          GENERACY_LLM_GATEWAY_URL: 'https://from-envvars.example',
          GENERACY_LLM_GATEWAY_TOKEN: 'tok',
        },
      }),
    );

    expect(result.status).toBe('pass');
    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe('https://from-envvars.example/v1/models');
  });
});
