import { describe, expect, it } from 'vitest';
import { FakeGh, makeIssue } from '../../__tests__/helpers/fake-gh.js';
import { cockpitScopeRemove } from '../tools/cockpit_scope_remove.js';

function stubGhWithBody(scopeKey: string, initialBody: string): FakeGh {
  const gh = new FakeGh({});
  let currentBody = initialBody;
  (gh as unknown as Record<string, unknown>).getIssue = async (
    repo: string,
    number: number,
  ) => {
    const key = `${repo}#${number}`;
    if (key === scopeKey) return { ...makeIssue({ number }), body: currentBody };
    return { ...makeIssue({ number }), url: `https://github.com/${repo}/issues/${number}` };
  };
  (gh as unknown as Record<string, unknown>).updateIssueBody = async (
    _repo: string,
    _number: number,
    body: string,
  ) => {
    currentBody = body;
  };
  (gh as unknown as { readBody: () => string }).readBody = () => currentBody;
  return gh;
}

describe('cockpit_scope_remove parity (#935)', () => {
  it('removes a ref line and returns alreadyAbsent:false envelope', async () => {
    const gh = stubGhWithBody('owner/scope#42', '- [ ] owner/target#7\n- [ ] owner/other#1\n');
    const result = await cockpitScopeRemove(
      {
        scope: { owner: 'owner', repo: 'scope', number: 42 },
        issue: { owner: 'owner', repo: 'target', number: 7 },
      },
      { gh },
    );
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.data.alreadyAbsent).toBe(false);
    expect((gh as unknown as { readBody: () => string }).readBody()).not.toContain(
      '- [ ] owner/target#7',
    );
  });

  it('already-absent target returns alreadyAbsent:true noop', async () => {
    const gh = stubGhWithBody('owner/scope#42', '- [ ] owner/other#1\n');
    const result = await cockpitScopeRemove(
      {
        scope: { owner: 'owner', repo: 'scope', number: 42 },
        issue: { owner: 'owner', repo: 'target', number: 7 },
      },
      { gh },
    );
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.data.alreadyAbsent).toBe(true);
    expect(result.data.attempts).toBe(1);
  });
});
