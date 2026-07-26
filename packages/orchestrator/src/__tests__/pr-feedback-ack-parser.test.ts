import { describe, it, expect } from 'vitest';
import {
  parseAcknowledgedFindings,
  BODY_FINDINGS_UNADDRESSED_MARKER,
} from '../worker/pr-feedback-ack-parser.js';

function markerBody(entries: Array<{ reviewer: string; reviewId: number; findingIndex: number; files?: string[] }>): string {
  const rows = entries
    .map(e => {
      const filesSuffix = e.files ? ` (files: ${e.files.map(f => '`' + f + '`').join(', ')})` : '';
      return `- \`${e.reviewer}\` review #${e.reviewId} finding ${e.findingIndex}${filesSuffix}`;
    })
    .join('\n');
  return `${BODY_FINDINGS_UNADDRESSED_MARKER}

⚠️ **Body findings not yet addressed by the fixer**

Some prose.

### Unaddressed findings

${rows}

_This is an automated notice from the PR-feedback body-consumption path (#1047)._`;
}

describe('parseAcknowledgedFindings', () => {
  it('(a) empty input → empty set', () => {
    expect(parseAcknowledgedFindings([])).toEqual(new Set());
  });

  it('(b) no matching marker → empty set (fail-open)', () => {
    const result = parseAcknowledgedFindings([
      'random top-level PR comment with no marker',
      '<!-- generacy-cockpit:something-else --> other marker',
    ]);
    expect(result).toEqual(new Set());
  });

  it('(c) single marker comment with N enumeration rows → N keys', () => {
    const body = markerBody([
      { reviewer: 'cockpit-bot', reviewId: 123, findingIndex: 1, files: ['foo.md'] },
      { reviewer: 'cockpit-bot', reviewId: 123, findingIndex: 2, files: ['bar.md', 'baz.md'] },
    ]);
    const result = parseAcknowledgedFindings([body]);
    expect(result).toEqual(new Set(['cockpit-bot:123:1', 'cockpit-bot:123:2']));
  });

  it('(d) multiple marker comments → newest (last by array order) wins', () => {
    const older = markerBody([
      { reviewer: 'cockpit-bot', reviewId: 100, findingIndex: 1 },
    ]);
    const newer = markerBody([
      { reviewer: 'cockpit-bot', reviewId: 200, findingIndex: 5 },
      { reviewer: 'human', reviewId: 201, findingIndex: 3 },
    ]);
    const result = parseAcknowledgedFindings(['unrelated', older, 'other', newer]);
    // Only the newest marker comment is parsed; older entries do not carry.
    expect(result).toEqual(new Set(['cockpit-bot:200:5', 'human:201:3']));
    expect(result.has('cockpit-bot:100:1')).toBe(false);
  });

  it('(e) round-trip parse of the exact marker shape from the contract', () => {
    // Verbatim from contracts/body-findings-unaddressed-marker.md § Example.
    const body = `${BODY_FINDINGS_UNADDRESSED_MARKER}

⚠️ **Body findings not yet addressed by the fixer**
...
### Unaddressed findings

- \`cockpit-bot\` review #123 finding 1 (files: \`foo.md\`)
- \`cockpit-bot\` review #123 finding 2 (files: \`bar.md\`, \`baz.md\`)

_This is an automated notice..._`;
    const result = parseAcknowledgedFindings([body]);
    expect(result).toEqual(new Set(['cockpit-bot:123:1', 'cockpit-bot:123:2']));
  });

  it('(f) key format `${reviewer}:${reviewId}:${index}` matches gate expectation', () => {
    const body = markerBody([
      { reviewer: 'user-with-dashes', reviewId: 999999, findingIndex: 42 },
    ]);
    const result = parseAcknowledgedFindings([body]);
    expect(result.has('user-with-dashes:999999:42')).toBe(true);
  });

  it('malformed row is skipped, remaining rows parsed', () => {
    const body = `${BODY_FINDINGS_UNADDRESSED_MARKER}

### Unaddressed findings

- garbage line
- \`good\` review #7 finding 1
- another bad line
- \`good\` review #7 finding 2`;
    const result = parseAcknowledgedFindings([body]);
    expect(result).toEqual(new Set(['good:7:1', 'good:7:2']));
  });
});
