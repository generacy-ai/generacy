import { describe, expect, it } from 'vitest';
import { buildInboxUrl } from '../inbox-url.js';

describe('buildInboxUrl (#1235)', () => {
  const GATE_ID = 'a'.repeat(24);

  it('builds the canonical /dashboard/inbox?gate=<id> template', () => {
    expect(buildInboxUrl('https://app.generacy.ai', GATE_ID)).toBe(
      `https://app.generacy.ai/dashboard/inbox?gate=${GATE_ID}`,
    );
  });

  it('normalises a trailing-slash appUrl (no //dashboard)', () => {
    expect(buildInboxUrl('https://app.generacy.ai/', GATE_ID)).toBe(
      `https://app.generacy.ai/dashboard/inbox?gate=${GATE_ID}`,
    );
  });

  it('encodeURIComponent is applied to the gate id (pinned even though hex is a no-op)', () => {
    // A hex gateId is unchanged, but assert the param is a faithful round-trip
    // and a value needing encoding is encoded.
    const url = new URL(buildInboxUrl('https://app.generacy.ai', 'a b/c'));
    expect(url.searchParams.get('gate')).toBe('a b/c');
    expect(url.search).toContain('gate=a+b%2Fc');
  });

  it('preserves a non-default origin (staging override)', () => {
    expect(buildInboxUrl('https://staging.generacy.ai', GATE_ID)).toBe(
      `https://staging.generacy.ai/dashboard/inbox?gate=${GATE_ID}`,
    );
  });
});
