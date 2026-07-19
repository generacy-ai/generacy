import { describe, expect, it, vi } from 'vitest';
import type { GhWrapper, Issue } from '@generacy-ai/cockpit';
import { resolveWebhookTargets } from '../webhook-target-resolver.js';

function makeIssue(body: string): Issue {
  return {
    number: 1,
    title: 't',
    state: 'OPEN',
    stateReason: null,
    labels: [],
    url: 'https://github.com/x/y/issues/1',
    body,
    createdAt: '',
  };
}

function makeGh(bodies: Record<string, string>): GhWrapper {
  return {
    async getIssue(repo: string, _n: number): Promise<Issue> {
      const body = bodies[repo];
      if (body == null) throw new Error(`no body for ${repo}`);
      return makeIssue(body);
    },
  } as unknown as GhWrapper;
}

describe('resolveWebhookTargets', () => {
  it('T1: single-repo epic → [{ owner, repo }]', async () => {
    const body = '### Phase\n- [ ] acme/coord#7\n';
    const gh = makeGh({ 'acme/coord': body });
    const warn = vi.fn();
    const out = await resolveWebhookTargets({
      epicRef: 'acme/coord#5',
      gh,
      logger: { warn },
    });
    expect(out).toEqual([{ owner: 'acme', repo: 'coord' }]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('T2: multi-repo epic dedup + primary-first', async () => {
    const body = [
      '### Phase',
      '- [ ] acme/coord#1',
      '- [ ] acme/foo#2',
      '- [ ] acme/bar#3',
    ].join('\n');
    const gh = makeGh({ 'acme/coord': body });
    const warn = vi.fn();
    const out = await resolveWebhookTargets({
      epicRef: 'acme/coord#5',
      gh,
      logger: { warn },
    });
    expect(out).toEqual([
      { owner: 'acme', repo: 'coord' },
      { owner: 'acme', repo: 'bar' },
      { owner: 'acme', repo: 'foo' },
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('T3: resolveEpic throws INVALID_EPIC_REF → [] + one warn', async () => {
    const gh = makeGh({});
    const warn = vi.fn();
    const out = await resolveWebhookTargets({
      epicRef: 'not-a-ref',
      gh,
      logger: { warn },
    });
    expect(out).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(
      /cockpit doorbell: webhook-target resolution failed:/,
    );
  });

  it('T4: resolveEpic throws NO_REFS → [] + one warn', async () => {
    // Empty body causes NO_REFS from resolveEpic.
    const gh = makeGh({ 'acme/coord': '' });
    const warn = vi.fn();
    const out = await resolveWebhookTargets({
      epicRef: 'acme/coord#5',
      gh,
      logger: { warn },
    });
    expect(out).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(
      /cockpit doorbell: webhook-target resolution failed:/,
    );
  });
});
