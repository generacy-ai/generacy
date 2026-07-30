import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import type { Issue } from '@generacy-ai/cockpit';
import { FakeGh, makeIssue } from '../../__tests__/helpers/fake-gh.js';
import { runStatus } from '../../status.js';
import { cockpitStatus } from '../tools/cockpit_status.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SNAPPOLL_BODY = readFileSync(
  join(
    HERE,
    '..',
    '..',
    '..',
    '..',
    '..',
    '..',
    '..',
    'cockpit',
    'src',
    'resolver',
    '__tests__',
    'fixtures',
    'epic-1006-snappoll.md',
  ),
  'utf-8',
);

function epicBody(refs: string[]): string {
  return ['### S2 — cohort', ...refs.map((r) => `- [ ] ${r}`)].join('\n');
}

describe('cockpit_status parity', () => {
  it('MCP tool result deep-equals CLI --json envelope', async () => {
    const body = epicBody(['owner/repo#1']);
    const buildGh = (): FakeGh =>
      new FakeGh({
        bodyByIssue: { 'owner/epic#42': body },
        issuesByQuery: (): Issue[] => [
          makeIssue({ number: 1, url: 'https://github.com/owner/repo/issues/1' }),
        ],
      });

    const cliOut: string[] = [];
    const cliCode = await runStatus(
      'owner/epic#42',
      { json: true },
      { gh: buildGh(), stdout: (l) => cliOut.push(l), logger: { warn: () => {} } },
    );
    expect(cliCode).toBe(0);
    const cliParsed = JSON.parse(cliOut[0]!);

    const mcpResult = await cockpitStatus(
      { epic: { owner: 'owner', repo: 'epic', number: 42 } },
      { gh: buildGh() },
    );
    expect(mcpResult.status).toBe('ok');
    if (mcpResult.status !== 'ok') return;
    expect(mcpResult.data).toEqual(cliParsed);
  });

  // #1006 (FR-012) / #1014: parser warnings surface on the MCP tool return
  // verbatim and match the CLI --json envelope's warnings. Under #1014, the
  // snappoll fixture emits the `mixed phase heading levels` warning (both
  // `###` and phase-shaped `####` present) instead of the old H4-phase-header
  // marker. Parity check confirms `cockpit_status.ts` passes `parsedJson`
  // through verbatim — no code change to that handler is required.
  it('surfaces parser warnings on the MCP tool return and matches CLI --json warnings', async () => {
    const buildGh = (): FakeGh =>
      new FakeGh({
        bodyByIssue: { 'christrudelpw/snappoll#1': SNAPPOLL_BODY },
        issuesByQuery: (): Issue[] => [],
      });

    const cliOut: string[] = [];
    const cliCode = await runStatus(
      'christrudelpw/snappoll#1',
      { json: true },
      { gh: buildGh(), stdout: (l) => cliOut.push(l), logger: { warn: () => {} } },
    );
    expect(cliCode).toBe(0);
    const cliParsed = JSON.parse(cliOut[0]!);

    const mcpResult = await cockpitStatus(
      { epic: { owner: 'christrudelpw', repo: 'snappoll', number: 1 } },
      { gh: buildGh() },
    );
    expect(mcpResult.status).toBe('ok');
    if (mcpResult.status !== 'ok') return;
    const mcpData = mcpResult.data as { warnings: string[] };

    expect(Array.isArray(mcpData.warnings)).toBe(true);
    expect(
      mcpData.warnings.some((w: string) => w.includes('mixed phase heading levels')),
    ).toBe(true);
    expect(mcpData.warnings).toEqual(cliParsed.warnings);
  });
});
