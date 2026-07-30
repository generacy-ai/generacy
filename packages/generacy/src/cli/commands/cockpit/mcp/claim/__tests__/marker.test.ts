import { describe, expect, it } from 'vitest';
import { formatMarker, parseMarker, MARKER_PREFIX } from '../marker.js';
import type { ClaimPayload } from '../payload.js';

const validPayload: ClaimPayload = {
  version: 1,
  sessionId: '9e5c8a0d755e40b3',
  heldSince: '2026-07-21T14:05:03.100Z',
  heartbeatAt: '2026-07-21T14:05:03.100Z',
  ledger: '.generacy/cockpit/auto-runs/generacy-ai-generacy-1015-20260721-140503.ledger',
  scope: 'generacy-ai/generacy#1015',
};

describe('marker', () => {
  describe('format', () => {
    it('produces a body starting with the fixed prefix', () => {
      const body = formatMarker(validPayload);
      expect(body.startsWith(MARKER_PREFIX)).toBe(true);
    });

    it('wraps payload in a ```json fence with 2-space indent', () => {
      const body = formatMarker(validPayload);
      expect(body).toContain('```json\n');
      expect(body).toContain('  "sessionId":');
      expect(body).toContain('\n```');
    });
  });

  describe('parse', () => {
    it('round-trips format→parse to identity', () => {
      const body = formatMarker(validPayload);
      const parsed = parseMarker(body);
      expect(parsed).toEqual(validPayload);
    });

    it('returns null on missing prefix', () => {
      const body = '```json\n' + JSON.stringify(validPayload) + '\n```';
      expect(parseMarker(body)).toBeNull();
    });

    it('returns null on corrupt JSON inside the fence', () => {
      const body = `${MARKER_PREFIX}\n\`\`\`json\n{ not-valid-json }\n\`\`\``;
      expect(parseMarker(body)).toBeNull();
    });

    it('returns null on missing ```json fence', () => {
      const body = `${MARKER_PREFIX}\n${JSON.stringify(validPayload)}`;
      expect(parseMarker(body)).toBeNull();
    });

    it('returns null on wrong inner version field', () => {
      const bad = { ...validPayload, version: 2 };
      const body = `${MARKER_PREFIX}\n\`\`\`json\n${JSON.stringify(bad, null, 2)}\n\`\`\``;
      expect(parseMarker(body)).toBeNull();
    });

    it('returns null on extra fields (strict mode)', () => {
      const bad = { ...validPayload, extra: 'nope' };
      const body = `${MARKER_PREFIX}\n\`\`\`json\n${JSON.stringify(bad, null, 2)}\n\`\`\``;
      expect(parseMarker(body)).toBeNull();
    });

    it('tolerates trailing whitespace on the body', () => {
      const body = formatMarker(validPayload) + '\n\n   ';
      expect(parseMarker(body)).toEqual(validPayload);
    });

    it('returns null on invalid sessionId shape', () => {
      const bad = { ...validPayload, sessionId: 'NOT-HEX' };
      const body = `${MARKER_PREFIX}\n\`\`\`json\n${JSON.stringify(bad, null, 2)}\n\`\`\``;
      expect(parseMarker(body)).toBeNull();
    });

    it('returns null on invalid scope shape', () => {
      const bad = { ...validPayload, scope: 'not-a-scope' };
      const body = `${MARKER_PREFIX}\n\`\`\`json\n${JSON.stringify(bad, null, 2)}\n\`\`\``;
      expect(parseMarker(body)).toBeNull();
    });
  });
});
