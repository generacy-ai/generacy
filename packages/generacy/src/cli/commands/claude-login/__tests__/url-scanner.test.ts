import { describe, it, expect } from 'vitest';
import { UrlScanner } from '../url-scanner.js';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

function collectOutput(scanner: UrlScanner): { chunks: Buffer[] } {
  const result = { chunks: [] as Buffer[] };
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      result.chunks.push(chunk);
      callback();
    },
  });
  scanner.pipe(sink);
  return result;
}

describe('UrlScanner', () => {
  it('detects a URL in a single chunk', async () => {
    const scanner = new UrlScanner();
    const output = collectOutput(scanner);

    scanner.write(Buffer.from('Visit https://auth.example.com/login to authenticate\n'));
    scanner.end();

    await new Promise((r) => scanner.on('end', r));

    expect(scanner.detectedUrl).toBe('https://auth.example.com/login');
    expect(Buffer.concat(output.chunks).toString()).toContain('https://auth.example.com/login');
  });

  it('resolves urlDetected promise on first URL', async () => {
    const scanner = new UrlScanner();
    collectOutput(scanner);

    scanner.write(Buffer.from('Go to http://example.com/path?q=1\n'));
    scanner.end();

    const url = await scanner.urlDetected;
    expect(url).toBe('http://example.com/path?q=1');
  });

  it('returns first URL when multiple are present', async () => {
    const scanner = new UrlScanner();
    collectOutput(scanner);

    scanner.write(Buffer.from('First: https://first.com\n'));
    scanner.write(Buffer.from('Second: https://second.com\n'));
    scanner.end();

    await new Promise((r) => scanner.on('end', r));

    expect(scanner.detectedUrl).toBe('https://first.com');
  });

  it('returns null when no URLs found', async () => {
    const scanner = new UrlScanner();
    collectOutput(scanner);

    scanner.write(Buffer.from('No URLs here\n'));
    scanner.write(Buffer.from('Still nothing\n'));
    scanner.end();

    await new Promise((r) => scanner.on('end', r));

    expect(scanner.detectedUrl).toBeNull();
  });

  it('passes all data through unchanged', async () => {
    const scanner = new UrlScanner();
    const output = collectOutput(scanner);

    const input = 'Line 1\nLine 2 https://x.com\nLine 3\n';
    scanner.write(Buffer.from(input));
    scanner.end();

    await new Promise((r) => scanner.on('end', r));

    expect(Buffer.concat(output.chunks).toString()).toBe(input);
  });

  it('detects URL when full URL arrives in a later chunk', async () => {
    const scanner = new UrlScanner();
    collectOutput(scanner);

    scanner.write(Buffer.from('Waiting...\n'));
    scanner.write(Buffer.from('Open https://example.com/path to continue\n'));
    scanner.end();

    await new Promise((r) => scanner.on('end', r));

    expect(scanner.detectedUrl).toBe('https://example.com/path');
  });
});
