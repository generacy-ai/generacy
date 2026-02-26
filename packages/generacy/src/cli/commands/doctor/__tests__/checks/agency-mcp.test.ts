import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CheckContext } from '../../types.js';

// ---------------------------------------------------------------------------
// Mock: global fetch
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();

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
  ok?: boolean;
  body?: string;
}): Response {
  const {
    status = 200,
    ok = status >= 200 && status < 300,
    body = '',
  } = options;
  return {
    status,
    ok,
    headers: new Headers(),
    text: async () => body,
  } as unknown as Response;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('agencyMcpCheck', () => {
  let agencyMcpCheck: (typeof import('../../checks/agency-mcp.js'))['agencyMcpCheck'];

  const originalEnv = { ...process.env };

  beforeEach(async () => {
    vi.resetAllMocks();
    vi.stubGlobal('fetch', mockFetch);

    // Clean AGENCY_URL from env
    delete process.env['AGENCY_URL'];

    const mod = await import('../../checks/agency-mcp.js');
    agencyMcpCheck = mod.agencyMcpCheck;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    // Restore original env
    process.env = { ...originalEnv };
  });

  // -------------------------------------------------------------------------
  // Metadata
  // -------------------------------------------------------------------------

  it('has correct metadata', () => {
    expect(agencyMcpCheck.id).toBe('agency-mcp');
    expect(agencyMcpCheck.category).toBe('services');
    expect(agencyMcpCheck.dependencies).toEqual([]);
    expect(agencyMcpCheck.priority).toBe('P2');
  });

  // -------------------------------------------------------------------------
  // Skip: AGENCY_URL not set
  // -------------------------------------------------------------------------

  it('skips when AGENCY_URL is not set', async () => {
    delete process.env['AGENCY_URL'];

    const result = await agencyMcpCheck.run(makeContext());

    expect(result.status).toBe('skip');
    expect(result.message).toContain('AGENCY_URL not set');
    expect(result.message).toContain('network mode');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('skips when AGENCY_URL is empty string', async () => {
    process.env['AGENCY_URL'] = '';

    const result = await agencyMcpCheck.run(makeContext());

    expect(result.status).toBe('skip');
    expect(result.message).toContain('AGENCY_URL not set');
  });

  it('skips when AGENCY_URL is whitespace only', async () => {
    process.env['AGENCY_URL'] = '   ';

    const result = await agencyMcpCheck.run(makeContext());

    expect(result.status).toBe('skip');
    expect(result.message).toContain('AGENCY_URL not set');
  });

  // -------------------------------------------------------------------------
  // Failure: health endpoint returns error
  // -------------------------------------------------------------------------

  it('fails when health endpoint returns non-OK status', async () => {
    process.env['AGENCY_URL'] = 'http://localhost:3001';
    mockFetch.mockResolvedValue(
      makeResponse({ status: 503, body: 'Service Unavailable' }),
    );

    const result = await agencyMcpCheck.run(makeContext());

    expect(result.status).toBe('fail');
    expect(result.message).toContain('HTTP 503');
    expect(result.suggestion).toContain('localhost:3001');
  });

  // -------------------------------------------------------------------------
  // Failure: timeout
  // -------------------------------------------------------------------------

  it('fails on timeout', async () => {
    process.env['AGENCY_URL'] = 'http://localhost:3001';
    const timeoutError = new DOMException('The operation was aborted.', 'TimeoutError');
    mockFetch.mockRejectedValue(timeoutError);

    const result = await agencyMcpCheck.run(makeContext());

    expect(result.status).toBe('fail');
    expect(result.message).toContain('timed out');
    expect(result.suggestion).toContain('localhost:3001');
  });

  // -------------------------------------------------------------------------
  // Failure: network/connection error
  // -------------------------------------------------------------------------

  it('fails on network error', async () => {
    process.env['AGENCY_URL'] = 'http://localhost:3001';
    mockFetch.mockRejectedValue(
      new Error('connect ECONNREFUSED 127.0.0.1:3001'),
    );

    const result = await agencyMcpCheck.run(makeContext());

    expect(result.status).toBe('fail');
    expect(result.message).toContain('Failed to connect');
    expect(result.suggestion).toContain('localhost:3001');
    expect(result.detail).toContain('ECONNREFUSED');
  });

  // -------------------------------------------------------------------------
  // Success: health endpoint returns OK
  // -------------------------------------------------------------------------

  it('passes when health endpoint returns OK', async () => {
    process.env['AGENCY_URL'] = 'http://localhost:3001';
    mockFetch.mockResolvedValue(makeResponse({ status: 200 }));

    const result = await agencyMcpCheck.run(makeContext());

    expect(result.status).toBe('pass');
    expect(result.message).toContain('reachable');
    expect(result.message).toContain('localhost:3001');
  });

  // -------------------------------------------------------------------------
  // URL handling: trailing slash normalization
  // -------------------------------------------------------------------------

  it('strips trailing slashes from AGENCY_URL before appending /health', async () => {
    process.env['AGENCY_URL'] = 'http://localhost:3001///';
    mockFetch.mockResolvedValue(makeResponse({ status: 200 }));

    await agencyMcpCheck.run(makeContext());

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe('http://localhost:3001/health');
  });

  // -------------------------------------------------------------------------
  // Fetch call details
  // -------------------------------------------------------------------------

  it('calls fetch with correct health URL', async () => {
    process.env['AGENCY_URL'] = 'http://agency.internal:8080';
    mockFetch.mockResolvedValue(makeResponse({ status: 200 }));

    await agencyMcpCheck.run(makeContext());

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe('http://agency.internal:8080/health');
  });
});
