import { CredentialStore } from '../src/credential-store.js';
import type { CredentialCacheEntry } from '../src/types.js';

function makeEntry(overrides?: Partial<CredentialCacheEntry>): CredentialCacheEntry {
  return {
    value: { value: 'secret-val' },
    expiresAt: new Date(Date.now() + 3600000),
    available: true,
    credentialType: 'mock',
    ...overrides,
  };
}

describe('CredentialStore', () => {
  let store: CredentialStore;

  beforeEach(() => {
    store = new CredentialStore();
  });

  it('set and get — stores and retrieves a credential entry correctly', () => {
    const entry = makeEntry();
    store.set('sess-1', 'cred-a', entry);
    const result = store.get('sess-1', 'cred-a');
    expect(result).toBe(entry);
  });

  it('get returns undefined for nonexistent session', () => {
    expect(store.get('no-such-session', 'cred-a')).toBeUndefined();
  });

  it('get returns undefined for nonexistent credential in existing session', () => {
    store.set('sess-1', 'cred-a', makeEntry());
    expect(store.get('sess-1', 'cred-b')).toBeUndefined();
  });

  it('getAllForSession — returns all credentials for a session', () => {
    const entry1 = makeEntry({ credentialType: 'type-1' });
    const entry2 = makeEntry({ credentialType: 'type-2' });
    store.set('sess-1', 'cred-a', entry1);
    store.set('sess-1', 'cred-b', entry2);

    const all = store.getAllForSession('sess-1');
    expect(all.size).toBe(2);
    expect(all.get('cred-a')).toBe(entry1);
    expect(all.get('cred-b')).toBe(entry2);
  });

  it('getAllForSession — returns empty map for nonexistent session', () => {
    const all = store.getAllForSession('no-such-session');
    expect(all).toBeInstanceOf(Map);
    expect(all.size).toBe(0);
  });

  it('isExpired — returns false for non-expired credential (expiresAt in future)', () => {
    store.set('sess-1', 'cred-a', makeEntry({ expiresAt: new Date(Date.now() + 3600000) }));
    expect(store.isExpired('sess-1', 'cred-a')).toBe(false);
  });

  it('isExpired — returns true for expired credential (expiresAt in past)', () => {
    store.set('sess-1', 'cred-a', makeEntry({ expiresAt: new Date(Date.now() - 1000) }));
    expect(store.isExpired('sess-1', 'cred-a')).toBe(true);
  });

  it('isExpired — returns true for nonexistent credential', () => {
    expect(store.isExpired('no-session', 'no-cred')).toBe(true);
  });

  it('clearSession — removes all credentials for a session', () => {
    store.set('sess-1', 'cred-a', makeEntry());
    store.set('sess-1', 'cred-b', makeEntry());
    store.set('sess-2', 'cred-c', makeEntry());

    store.clearSession('sess-1');

    expect(store.get('sess-1', 'cred-a')).toBeUndefined();
    expect(store.get('sess-1', 'cred-b')).toBeUndefined();
    expect(store.get('sess-2', 'cred-c')).toBeDefined();
  });

  it('clearSession — does not throw for nonexistent session', () => {
    expect(() => store.clearSession('no-such-session')).not.toThrow();
  });

  it('multi-session isolation — credentials in one session do not affect another', () => {
    const entry1 = makeEntry({ credentialType: 'type-1' });
    const entry2 = makeEntry({ credentialType: 'type-2' });

    store.set('sess-1', 'cred-a', entry1);
    store.set('sess-2', 'cred-a', entry2);

    expect(store.get('sess-1', 'cred-a')).toBe(entry1);
    expect(store.get('sess-2', 'cred-a')).toBe(entry2);
  });

  it('clear — removes everything', () => {
    store.set('sess-1', 'cred-a', makeEntry());
    store.set('sess-2', 'cred-b', makeEntry());

    store.clear();

    expect(store.get('sess-1', 'cred-a')).toBeUndefined();
    expect(store.get('sess-2', 'cred-b')).toBeUndefined();
    expect(store.getAllForSession('sess-1').size).toBe(0);
    expect(store.getAllForSession('sess-2').size).toBe(0);
  });
});
