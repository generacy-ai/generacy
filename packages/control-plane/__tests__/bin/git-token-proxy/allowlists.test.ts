import { describe, it, expect } from 'vitest';
import { isAllowedRoute, pickAllowedHeaders } from '../../../src/git-token-proxy/index.js';

describe('isAllowedRoute', () => {
  it('allows POST /git-token', () => {
    expect(isAllowedRoute('POST', '/git-token')).toBe(true);
  });

  it('allows POST /git-token with query string', () => {
    expect(isAllowedRoute('POST', '/git-token?x=y')).toBe(true);
  });

  it('rejects GET /git-token', () => {
    expect(isAllowedRoute('GET', '/git-token')).toBe(false);
  });

  it('rejects POST /git-token/ (trailing slash significant)', () => {
    expect(isAllowedRoute('POST', '/git-token/')).toBe(false);
  });

  it('rejects POST /git-tokens', () => {
    expect(isAllowedRoute('POST', '/git-tokens')).toBe(false);
  });

  it('rejects POST //git-token', () => {
    expect(isAllowedRoute('POST', '//git-token')).toBe(false);
  });

  it('rejects POST /credentials/x', () => {
    expect(isAllowedRoute('POST', '/credentials/x')).toBe(false);
  });

  it('rejects POST /lifecycle/bootstrap-complete', () => {
    expect(isAllowedRoute('POST', '/lifecycle/bootstrap-complete')).toBe(false);
  });

  it('rejects OPTIONS /git-token', () => {
    expect(isAllowedRoute('OPTIONS', '/git-token')).toBe(false);
  });

  it('rejects PUT /git-token', () => {
    expect(isAllowedRoute('PUT', '/git-token')).toBe(false);
  });

  it('rejects DELETE /git-token', () => {
    expect(isAllowedRoute('DELETE', '/git-token')).toBe(false);
  });

  it('rejects HEAD /git-token', () => {
    expect(isAllowedRoute('HEAD', '/git-token')).toBe(false);
  });

  it('rejects undefined method', () => {
    expect(isAllowedRoute(undefined, '/git-token')).toBe(false);
  });

  it('rejects undefined url', () => {
    expect(isAllowedRoute('POST', undefined)).toBe(false);
  });
});

describe('pickAllowedHeaders', () => {
  it('drops every disallowed key from a dirty input and keeps content-type / content-length', () => {
    const out = pickAllowedHeaders({
      host: 'github.com',
      authorization: 'Bearer ghp_xxx',
      accept: '*/*',
      cookie: 'session=abc',
      'x-real-ip': '10.0.0.1',
      'x-forwarded-for': '10.0.0.2',
      range: 'bytes=0-99',
      'if-none-match': '"etag"',
      'user-agent': 'curl/8.0',
      'x-anything': 'something',
      'content-type': 'application/json',
      'content-length': '42',
    });
    expect(out).toEqual({
      'content-type': 'application/json',
      'content-length': '42',
    });
  });

  it('lowercases mixed-case input keys', () => {
    const out = pickAllowedHeaders({
      // node lowercases incoming headers, but defend against any caller passing
      // mixed-case via the type signature.
      'Content-Type': 'application/json',
      'CONTENT-LENGTH': '5',
    } as unknown as Record<string, string>);
    expect(out).toEqual({
      'content-type': 'application/json',
      'content-length': '5',
    });
  });

  it('returns an empty object when no allowed headers are present', () => {
    const out = pickAllowedHeaders({
      host: 'github.com',
      authorization: 'Bearer x',
    });
    expect(out).toEqual({});
  });

  it('returns a new object (does not mutate input)', () => {
    const input = { 'content-type': 'application/json', host: 'github.com' };
    const out = pickAllowedHeaders(input);
    expect(out).not.toBe(input);
    expect(input).toEqual({ 'content-type': 'application/json', host: 'github.com' });
  });

  it('takes first value of array-valued headers', () => {
    const out = pickAllowedHeaders({
      'content-type': ['application/json', 'text/plain'],
    });
    expect(out).toEqual({ 'content-type': 'application/json' });
  });
});
