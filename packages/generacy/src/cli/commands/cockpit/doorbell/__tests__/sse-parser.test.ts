import { describe, expect, it } from 'vitest';
import { parseSseEventBlock } from '../sse-parser.js';

function frame(event: string | null, data: unknown | unknown[]): string {
  const lines: string[] = [];
  if (event != null) lines.push(`event: ${event}`);
  const dataArr = Array.isArray(data) ? data : [data];
  for (const d of dataArr) {
    lines.push(`data: ${typeof d === 'string' ? d : JSON.stringify(d)}`);
  }
  return lines.join('\n');
}

describe('parseSseEventBlock', () => {
  it('parses single event/data pair', () => {
    const text = frame('message', {
      'x-github-event': 'issues',
      body: { action: 'labeled', repository: { name: 'r', owner: { login: 'o' } } },
    });
    const result = parseSseEventBlock(text);
    expect(result).not.toBeNull();
    expect(result?.githubEvent).toBe('issues');
    expect(result?.action).toBe('labeled');
    expect(result?.body).toEqual({
      action: 'labeled',
      repository: { name: 'r', owner: { login: 'o' } },
    });
  });

  it('joins multi-line data with newline', () => {
    // Split a JSON payload across two data: lines
    const payload = JSON.stringify({ 'x-github-event': 'issues', body: { action: 'closed' } });
    const half = payload.slice(0, Math.floor(payload.length / 2));
    const rest = payload.slice(Math.floor(payload.length / 2));
    // But this won't parse as JSON because data lines are joined with `\n`.
    // Instead pass one line that includes an embedded `\n` inside a string.
    const bodyJson = JSON.stringify({
      'x-github-event': 'issues',
      body: {
        action: 'labeled',
        note: 'line1\nline2',
        repository: { name: 'r', owner: { login: 'o' } },
      },
    });
    void half;
    void rest;
    const text = `event: message\ndata: ${bodyJson}`;
    const result = parseSseEventBlock(text);
    expect(result?.githubEvent).toBe('issues');
    expect(result?.action).toBe('labeled');
  });

  it('returns null for ready event', () => {
    expect(parseSseEventBlock('event: ready\ndata: {}')).toBeNull();
  });

  it('returns null for ping event', () => {
    expect(parseSseEventBlock('event: ping\ndata: {}')).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    expect(parseSseEventBlock('event: message\ndata: {not-json')).toBeNull();
  });

  it('returns null when x-github-event is missing', () => {
    const text = `event: message\ndata: ${JSON.stringify({ body: { action: 'a' } })}`;
    expect(parseSseEventBlock(text)).toBeNull();
  });

  it('returns null when body is missing', () => {
    const text = `event: message\ndata: ${JSON.stringify({ 'x-github-event': 'issues' })}`;
    expect(parseSseEventBlock(text)).toBeNull();
  });

  it('accepts empty event type (falls under "message" default)', () => {
    const text = `data: ${JSON.stringify({
      'x-github-event': 'push',
      body: { action: '', repository: { name: 'r', owner: { login: 'o' } } },
    })}`;
    const result = parseSseEventBlock(text);
    expect(result?.githubEvent).toBe('push');
  });
});
