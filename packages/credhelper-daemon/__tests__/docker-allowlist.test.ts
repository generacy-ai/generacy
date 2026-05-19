import { DockerAllowlistMatcher } from '../src/docker-allowlist.js';

describe('DockerAllowlistMatcher', () => {
  describe('default deny', () => {
    it('rejects everything with an empty allowlist', () => {
      const matcher = new DockerAllowlistMatcher([]);
      const result = matcher.match('GET', '/containers/json');

      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.reason).toContain('No allowlist rule matched');
      }
    });
  });

  describe('exact method+path match', () => {
    const matcher = new DockerAllowlistMatcher([
      { method: 'GET', path: '/containers/json' },
    ]);

    it('matches when method and path are identical', () => {
      const result = matcher.match('GET', '/containers/json');

      expect(result.allowed).toBe(true);
      if (result.allowed) {
        expect(result.rule).toEqual({ method: 'GET', path: '/containers/json' });
      }
    });

    it('rejects when method differs', () => {
      const result = matcher.match('POST', '/containers/json');

      expect(result.allowed).toBe(false);
    });
  });

  describe('{id} path patterns', () => {
    const matcher = new DockerAllowlistMatcher([
      { method: 'POST', path: '/containers/{id}/start' },
    ]);

    it('matches a path with a concrete container id', () => {
      const result = matcher.match('POST', '/containers/abc123/start');

      expect(result.allowed).toBe(true);
      if (result.allowed) {
        expect(result.containerId).toBe('abc123');
      }
    });

    it('extracts containerId from the match result', () => {
      const result = matcher.match('POST', '/containers/my-container_01/start');

      expect(result.allowed).toBe(true);
      if (result.allowed) {
        expect(result.containerId).toBe('my-container_01');
      }
    });

    it('does not match a different action on the same container', () => {
      const result = matcher.match('POST', '/containers/abc123/stop');

      expect(result.allowed).toBe(false);
    });

    it('does not match when there is no id segment', () => {
      const result = matcher.match('POST', '/containers//start');

      expect(result.allowed).toBe(false);
    });
  });

  describe('version prefix stripping', () => {
    it('does NOT match versioned paths (matcher expects pre-normalized paths)', () => {
      const matcher = new DockerAllowlistMatcher([
        { method: 'GET', path: '/containers/json' },
      ]);

      const result = matcher.match('GET', '/v1.41/containers/json');

      expect(result.allowed).toBe(false);
    });
  });

  describe('rules without name field', () => {
    const matcher = new DockerAllowlistMatcher([
      { method: 'POST', path: '/containers/{id}/start' },
    ]);

    it('allows via matchWithName regardless of container name', () => {
      const result = matcher.matchWithName('POST', '/containers/abc/start', 'any-name');

      expect(result.allowed).toBe(true);
    });

    it('allows via matchWithName even when containerName is null', () => {
      const result = matcher.matchWithName('POST', '/containers/abc/start', null);

      expect(result.allowed).toBe(true);
    });

    it('preserves containerId in matchWithName result', () => {
      const result = matcher.matchWithName('POST', '/containers/abc/start', 'any-name');

      expect(result.allowed).toBe(true);
      if (result.allowed) {
        expect(result.containerId).toBe('abc');
      }
    });
  });

  describe('glob matching (name field)', () => {
    const matcher = new DockerAllowlistMatcher([
      { method: 'POST', path: '/containers/{id}/start', name: 'firebase-*' },
    ]);

    it('match() returns needsNameCheck: true when rule has a name glob', () => {
      const result = matcher.match('POST', '/containers/abc/start');

      expect(result.allowed).toBe(true);
      if (result.allowed) {
        expect(result).toHaveProperty('needsNameCheck', true);
      }
    });

    it('matchWithName allows when container name matches the glob', () => {
      const result = matcher.matchWithName('POST', '/containers/abc/start', 'firebase-emulator');

      expect(result.allowed).toBe(true);
      if (result.allowed) {
        expect(result.rule).toEqual({
          method: 'POST',
          path: '/containers/{id}/start',
          name: 'firebase-*',
        });
      }
    });

    it('matchWithName denies when container name does not match the glob', () => {
      const result = matcher.matchWithName('POST', '/containers/abc/start', 'redis');

      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.reason).toContain('redis');
        expect(result.reason).toContain('firebase-*');
      }
    });
  });

  describe('name resolution failure (fail closed)', () => {
    it('denies when containerName is null and rule requires name check', () => {
      const matcher = new DockerAllowlistMatcher([
        { method: 'POST', path: '/containers/{id}/start', name: 'firebase-*' },
      ]);

      const result = matcher.matchWithName('POST', '/containers/abc/start', null);

      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.reason).toContain('container name could not be resolved');
      }
    });
  });

  describe('multiple matching rules', () => {
    it('first matching rule wins (rule with name glob first)', () => {
      const matcher = new DockerAllowlistMatcher([
        { method: 'POST', path: '/containers/{id}/start', name: 'firebase-*' },
        { method: 'POST', path: '/containers/{id}/start' },
      ]);

      // match() hits the first rule (which has name glob) and returns needsNameCheck
      const result = matcher.match('POST', '/containers/abc/start');

      expect(result.allowed).toBe(true);
      if (result.allowed) {
        expect(result.needsNameCheck).toBe(true);
        expect(result.rule.name).toBe('firebase-*');
      }
    });

    it('first matching rule wins — name-restricted rule blocks non-matching names even when a later rule would allow', () => {
      const matcher = new DockerAllowlistMatcher([
        { method: 'POST', path: '/containers/{id}/start', name: 'firebase-*' },
        { method: 'POST', path: '/containers/{id}/start' },
      ]);

      // matchWithName uses the first matching rule which requires firebase-* name
      const result = matcher.matchWithName('POST', '/containers/abc/start', 'redis');

      expect(result.allowed).toBe(false);
    });

    it('order matters — unrestricted rule first allows everything', () => {
      const matcher = new DockerAllowlistMatcher([
        { method: 'POST', path: '/containers/{id}/start' },
        { method: 'POST', path: '/containers/{id}/start', name: 'firebase-*' },
      ]);

      // First rule has no name constraint, so it matches regardless of name
      const result = matcher.matchWithName('POST', '/containers/abc/start', 'redis');

      expect(result.allowed).toBe(true);
    });
  });

  describe('case-insensitive method matching', () => {
    it('matches when rule uses lowercase method and request uses uppercase', () => {
      const matcher = new DockerAllowlistMatcher([
        { method: 'get', path: '/containers/json' },
      ]);

      const result = matcher.match('GET', '/containers/json');

      expect(result.allowed).toBe(true);
    });

    it('matches when rule uses uppercase method and request uses lowercase', () => {
      const matcher = new DockerAllowlistMatcher([
        { method: 'GET', path: '/containers/json' },
      ]);

      const result = matcher.match('get', '/containers/json');

      expect(result.allowed).toBe(true);
    });

    it('matches when both use mixed case', () => {
      const matcher = new DockerAllowlistMatcher([
        { method: 'Get', path: '/containers/json' },
      ]);

      const result = matcher.match('gEt', '/containers/json');

      expect(result.allowed).toBe(true);
    });
  });
});
