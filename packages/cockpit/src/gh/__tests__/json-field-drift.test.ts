import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

interface JsonFieldListSite {
  fieldList: string;
  line: number;
  ghSubcommand: string;
}

interface NonLiteralOffender {
  line: number;
  snippet: string;
}

const hasGhBinary = ((): boolean => {
  try {
    return spawnSync('gh', ['--version'], { encoding: 'utf-8' }).status === 0;
  } catch {
    return false;
  }
})();

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WRAPPER_PATH = path.resolve(HERE, '..', 'wrapper.ts');

function readWrapperSource(): string {
  return readFileSync(WRAPPER_PATH, 'utf-8');
}

const POSITIVE_MATCH_RE = /'--json',\s*\n\s*'([^']+)'/g;
const JSON_LINE_RE = /'--json',(.*)$/gm;

const GH_SUBCOMMAND_KEYWORDS: Array<[RegExp, string]> = [
  [/'pr'\s*,\s*'checks'/, 'pr checks'],
  [/'pr'\s*,\s*'view'/, 'pr view'],
  [/'pr'\s*,\s*'list'/, 'pr list'],
  [/'issue'\s*,\s*'view'/, 'issue view'],
  [/'search'\s*,\s*'issues'/, 'search issues'],
];

function inferSubcommand(source: string, upToIndex: number): string {
  const preceding = source.slice(0, upToIndex);
  const window = preceding.slice(Math.max(0, preceding.length - 400));
  for (const [re, name] of GH_SUBCOMMAND_KEYWORDS) {
    if (re.test(window)) return name;
  }
  return 'pr checks';
}

function lineNumberAt(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (source.charCodeAt(i) === 10) line++;
  }
  return line;
}

function extractJsonFieldLists(source: string): {
  matches: JsonFieldListSite[];
  nonLiteralOffenders: NonLiteralOffender[];
} {
  const matches: JsonFieldListSite[] = [];
  const positive: Array<{ start: number; line: number }> = [];

  POSITIVE_MATCH_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = POSITIVE_MATCH_RE.exec(source)) != null) {
    const captured = m[1];
    if (captured == null) continue;
    const line = lineNumberAt(source, m.index) + 1;
    const literalIndex = source.indexOf(`'${captured}'`, m.index);
    const literalLine =
      literalIndex >= 0 ? lineNumberAt(source, literalIndex) : line;
    matches.push({
      fieldList: captured,
      line: literalLine,
      ghSubcommand: inferSubcommand(source, m.index),
    });
    positive.push({ start: m.index, line: lineNumberAt(source, m.index) });
  }

  const nonLiteralOffenders: NonLiteralOffender[] = [];
  JSON_LINE_RE.lastIndex = 0;
  let jm: RegExpExecArray | null;
  while ((jm = JSON_LINE_RE.exec(source)) != null) {
    const jsonIndex = jm.index;
    const matched = positive.some(
      (p) => p.start === jsonIndex,
    );
    if (matched) continue;
    const line = lineNumberAt(source, jsonIndex);
    const remainder = (jm[1] ?? '').trim();
    const nextLineIdx = source.indexOf('\n', jsonIndex + 8) + 1;
    const nextLineEnd = source.indexOf('\n', nextLineIdx);
    const nextLine =
      nextLineIdx > 0 && nextLineEnd > 0
        ? source.slice(nextLineIdx, nextLineEnd).trim()
        : '';
    const snippet = (remainder.length > 0 ? remainder : nextLine).slice(0, 60);
    nonLiteralOffenders.push({ line, snippet });
  }

  return { matches, nonLiteralOffenders };
}

function buildTestArgs(ghSubcommand: string, fieldList: string): string[] {
  switch (ghSubcommand) {
    case 'pr view':
      return [
        'pr',
        'view',
        '999999999',
        '--repo',
        'octocat/hello-world',
        '--json',
        fieldList,
      ];
    case 'pr list':
      return [
        'pr',
        'list',
        '--repo',
        'octocat/hello-world',
        '--json',
        fieldList,
        '--limit',
        '1',
      ];
    case 'issue view':
      return [
        'issue',
        'view',
        '999999999',
        '--repo',
        'octocat/hello-world',
        '--json',
        fieldList,
      ];
    case 'search issues':
      return [
        'search',
        'issues',
        'is:open',
        'repo:octocat/hello-world',
        '--json',
        fieldList,
        '--limit',
        '1',
      ];
    case 'pr checks':
    default:
      return [
        'pr',
        'checks',
        '999999999',
        '--repo',
        'octocat/hello-world',
        '--json',
        fieldList,
      ];
  }
}

const source = readWrapperSource();
const { matches, nonLiteralOffenders } = extractJsonFieldLists(source);

describe('json-field-drift extractor', () => {
  it('every --json occurrence in wrapper.ts is a single-quoted string literal', () => {
    expect(
      nonLiteralOffenders,
      `non-literal --json follow-up(s): ${nonLiteralOffenders
        .map((o) => `wrapper.ts:${o.line} — ${o.snippet}`)
        .join('; ')}`,
    ).toEqual([]);
  });

  it('extracts at least one --json field list', () => {
    expect(matches.length).toBeGreaterThan(0);
  });
});

describe.runIf(hasGhBinary)('gh --json field drift', () => {
  it.each(matches)(
    `'--json' at wrapper.ts:$line — "$fieldList"`,
    ({ fieldList, line, ghSubcommand }) => {
      const args = buildTestArgs(ghSubcommand, fieldList);
      const result = spawnSync('gh', args, {
        encoding: 'utf-8',
        timeout: 5000,
      });
      if (/unknown json field/i.test(result.stderr)) {
        throw new Error(
          `gh rejected --json field list at wrapper.ts:${line}: "${fieldList}"\nstderr: ${result.stderr.trim()}`,
        );
      }
    },
  );
});
