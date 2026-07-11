import { describe, it, expect } from 'vitest';
import type { Issue } from '@generacy-ai/cockpit';
import { FakeGh, makeIssue } from '../../__tests__/helpers/fake-gh.js';
import { runStatus } from '../../status.js';
import { cockpitStatus } from '../tools/cockpit_status.js';

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
});
