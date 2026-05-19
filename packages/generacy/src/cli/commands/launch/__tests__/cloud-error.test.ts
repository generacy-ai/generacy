import { describe, it, expect } from 'vitest';
import { CloudError, redactClaimUrl, sanitizeBody } from '../cloud-error.js';

describe('CloudError', () => {
  it('sets all fields from constructor options', () => {
    const err = new CloudError({
      statusCode: 404,
      url: 'https://api.generacy.ai/clusters',
      message: 'Not found',
      detail: 'Cluster does not exist',
      retryAfter: '30',
      problemType: 'https://generacy.ai/problems/not-found',
    });

    expect(err.message).toBe('Not found');
    expect(err.statusCode).toBe(404);
    expect(err.url).toBe('https://api.generacy.ai/clusters');
    expect(err.detail).toBe('Cluster does not exist');
    expect(err.retryAfter).toBe('30');
    expect(err.problemType).toBe('https://generacy.ai/problems/not-found');
  });

  it('has name set to CloudError', () => {
    const err = new CloudError({
      statusCode: 500,
      url: 'https://example.com',
      message: 'Internal error',
    });

    expect(err.name).toBe('CloudError');
  });

  it('is an instance of Error', () => {
    const err = new CloudError({
      statusCode: 502,
      url: 'https://example.com',
      message: 'Bad gateway',
    });

    expect(err).toBeInstanceOf(Error);
  });

  it('leaves optional fields undefined when not provided', () => {
    const err = new CloudError({
      statusCode: 400,
      url: 'https://example.com/api',
      message: 'Bad request',
    });

    expect(err.detail).toBeUndefined();
    expect(err.retryAfter).toBeUndefined();
    expect(err.problemType).toBeUndefined();
  });
});

describe('redactClaimUrl', () => {
  it('redacts a claim query parameter', () => {
    expect(redactClaimUrl('https://api.generacy.ai/launch?claim=abc123')).toBe(
      'https://api.generacy.ai/launch?claim=<redacted>',
    );
  });

  it('returns the URL unchanged when there is no claim param', () => {
    const url = 'https://api.generacy.ai/launch?foo=bar&baz=1';
    expect(redactClaimUrl(url)).toBe(url);
  });

  it('redacts claim while preserving other params', () => {
    expect(
      redactClaimUrl('https://api.generacy.ai/launch?foo=1&claim=abc&bar=2'),
    ).toBe('https://api.generacy.ai/launch?foo=1&claim=<redacted>&bar=2');
  });

  it('redacts claim with encoded values', () => {
    expect(
      redactClaimUrl('https://api.generacy.ai/launch?claim=a%2Fb'),
    ).toBe('https://api.generacy.ai/launch?claim=<redacted>');
  });

  it('redacts claim at start of query string with trailing params', () => {
    expect(
      redactClaimUrl('https://api.generacy.ai/launch?claim=x&other=y'),
    ).toBe('https://api.generacy.ai/launch?claim=<redacted>&other=y');
  });
});

describe('sanitizeBody', () => {
  it('truncates strings longer than 120 characters and appends ellipsis', () => {
    const long = 'a'.repeat(150);
    const result = sanitizeBody(long);
    expect(result).toBe('a'.repeat(120) + '...');
  });

  it('does not truncate a string of exactly 120 characters', () => {
    const exact = 'b'.repeat(120);
    expect(sanitizeBody(exact)).toBe(exact);
  });

  it('strips non-printable characters', () => {
    expect(sanitizeBody('hello\x00world\x1f!\x7f')).toBe('helloworld!');
  });

  it('collapses multiple spaces into a single space', () => {
    expect(sanitizeBody('hello   world   foo   bar')).toBe('hello world foo bar');
  });

  it('strips tabs and newlines as non-printable characters', () => {
    expect(sanitizeBody('hello\tworld\nfoo')).toBe('helloworldfoo');
  });

  it('returns "(empty body)" for an empty string', () => {
    expect(sanitizeBody('')).toBe('(empty body)');
  });

  it('returns "(empty body)" for a string of only non-printable characters', () => {
    expect(sanitizeBody('\x00\x01\x1f\x7f')).toBe('(empty body)');
  });

  it('respects a custom maxLen parameter', () => {
    const input = 'abcdefghij'; // 10 chars
    expect(sanitizeBody(input, 5)).toBe('abcde...');
  });

  it('trims leading and trailing whitespace', () => {
    expect(sanitizeBody('  hello world  ')).toBe('hello world');
  });
});
