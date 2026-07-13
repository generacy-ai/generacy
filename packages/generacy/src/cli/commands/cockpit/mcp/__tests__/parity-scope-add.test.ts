import { describe, expect, it } from 'vitest';
import { FakeGh, makeIssue } from '../../__tests__/helpers/fake-gh.js';
import { cockpitScopeAdd } from '../tools/cockpit_scope_add.js';

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

describe('cockpit_scope_add parity (#935)', () => {
  it('appends a ref to a scope issue body and returns shape/attempts/alreadyPresent envelope', async () => {
    const gh = stubGhWithBody('owner/scope#42', '### Phase 1\n- [ ] owner/repo#1\n');
    const result = await cockpitScopeAdd(
      {
        scope: { owner: 'owner', repo: 'scope', number: 42 },
        issue: { owner: 'owner', repo: 'target', number: 7 },
      },
      { gh },
    );
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.data.scope).toEqual({ owner: 'owner', repo: 'scope', number: 42 });
    expect(result.data.ref).toEqual({ owner: 'owner', repo: 'target', number: 7 });
    expect(result.data.shape).toBe('phased');
    expect(result.data.alreadyPresent).toBe(false);
    expect(result.data.attempts).toBeGreaterThanOrEqual(1);
    expect((gh as unknown as { readBody: () => string }).readBody()).toContain(
      '- [ ] owner/target#7',
    );
  });

  it('repeat call after successful add returns alreadyPresent:true', async () => {
    const gh = stubGhWithBody('owner/scope#42', '- [ ] owner/target#7\n');
    const result = await cockpitScopeAdd(
      {
        scope: { owner: 'owner', repo: 'scope', number: 42 },
        issue: { owner: 'owner', repo: 'target', number: 7 },
      },
      { gh },
    );
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.data.alreadyPresent).toBe(true);
    expect(result.data.attempts).toBe(1);
  });

  it('invalid input → class: invalid-args', async () => {
    const gh = new FakeGh({});
    const result = await cockpitScopeAdd(
      { scope: 'not-a-ref-form' } as never,
      { gh },
    );
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('invalid-args');
  });
});
