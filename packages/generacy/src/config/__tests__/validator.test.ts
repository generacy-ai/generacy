import { describe, it, expect, fail } from 'vitest';
import {
  ConfigValidationError,
  validateNoDuplicateRepos,
  validateSemantics,
} from '../validator.js';
import type { GeneracyConfig } from '../schema.js';

describe('validateNoDuplicateRepos', () => {
  it('should pass with no duplicates (minimal config)', () => {
    const config: GeneracyConfig = {
      schemaVersion: '1',
      project: {
        id: 'proj_abc123',
        name: 'My Project',
      },
      repos: {
        primary: 'github.com/acme/main-api',
        dev: [],
        clone: [],
      },
    };
    expect(() => validateNoDuplicateRepos(config)).not.toThrow();
  });

  it('should pass with no duplicates (full config)', () => {
    const config: GeneracyConfig = {
      schemaVersion: '1',
      project: {
        id: 'proj_abc123',
        name: 'My Project',
      },
      repos: {
        primary: 'github.com/acme/main-api',
        dev: ['github.com/acme/shared-lib', 'github.com/acme/worker-service'],
        clone: ['github.com/acme/design-system', 'github.com/public/api-docs'],
      },
    };
    expect(() => validateNoDuplicateRepos(config)).not.toThrow();
  });

  it('should fail when primary appears in dev list', () => {
    const config: GeneracyConfig = {
      schemaVersion: '1',
      project: {
        id: 'proj_abc123',
        name: 'My Project',
      },
      repos: {
        primary: 'github.com/acme/main-api',
        dev: ['github.com/acme/main-api', 'github.com/acme/shared-lib'],
        clone: [],
      },
    };
    expect(() => validateNoDuplicateRepos(config)).toThrow(ConfigValidationError);
    expect(() => validateNoDuplicateRepos(config)).toThrow(
      'Duplicate repositories found: github.com/acme/main-api'
    );
  });

  it('should fail when primary appears in clone list', () => {
    const config: GeneracyConfig = {
      schemaVersion: '1',
      project: {
        id: 'proj_abc123',
        name: 'My Project',
      },
      repos: {
        primary: 'github.com/acme/main-api',
        dev: [],
        clone: ['github.com/acme/main-api'],
      },
    };
    expect(() => validateNoDuplicateRepos(config)).toThrow(ConfigValidationError);
    expect(() => validateNoDuplicateRepos(config)).toThrow(
      'Duplicate repositories found: github.com/acme/main-api'
    );
  });

  it('should fail when dev repo appears in clone list', () => {
    const config: GeneracyConfig = {
      schemaVersion: '1',
      project: {
        id: 'proj_abc123',
        name: 'My Project',
      },
      repos: {
        primary: 'github.com/acme/main-api',
        dev: ['github.com/acme/shared-lib'],
        clone: ['github.com/acme/shared-lib'],
      },
    };
    expect(() => validateNoDuplicateRepos(config)).toThrow(ConfigValidationError);
    expect(() => validateNoDuplicateRepos(config)).toThrow(
      'Duplicate repositories found: github.com/acme/shared-lib'
    );
  });

  it('should fail when same repo appears twice in dev list', () => {
    const config: GeneracyConfig = {
      schemaVersion: '1',
      project: {
        id: 'proj_abc123',
        name: 'My Project',
      },
      repos: {
        primary: 'github.com/acme/main-api',
        dev: ['github.com/acme/shared-lib', 'github.com/acme/shared-lib'],
        clone: [],
      },
    };
    expect(() => validateNoDuplicateRepos(config)).toThrow(ConfigValidationError);
    expect(() => validateNoDuplicateRepos(config)).toThrow(
      'Duplicate repositories found: github.com/acme/shared-lib'
    );
  });

  it('should fail when same repo appears twice in clone list', () => {
    const config: GeneracyConfig = {
      schemaVersion: '1',
      project: {
        id: 'proj_abc123',
        name: 'My Project',
      },
      repos: {
        primary: 'github.com/acme/main-api',
        dev: [],
        clone: ['github.com/acme/design-system', 'github.com/acme/design-system'],
      },
    };
    expect(() => validateNoDuplicateRepos(config)).toThrow(ConfigValidationError);
    expect(() => validateNoDuplicateRepos(config)).toThrow(
      'Duplicate repositories found: github.com/acme/design-system'
    );
  });

  it('should report multiple duplicates', () => {
    const config: GeneracyConfig = {
      schemaVersion: '1',
      project: {
        id: 'proj_abc123',
        name: 'My Project',
      },
      repos: {
        primary: 'github.com/acme/main-api',
        dev: ['github.com/acme/main-api', 'github.com/acme/shared-lib'],
        clone: ['github.com/acme/shared-lib'],
      },
    };
    expect(() => validateNoDuplicateRepos(config)).toThrow(ConfigValidationError);
    expect(() => validateNoDuplicateRepos(config)).toThrow('Duplicate repositories found:');
  });

  it('should fail when same repo appears in all three lists', () => {
    const config: GeneracyConfig = {
      schemaVersion: '1',
      project: {
        id: 'proj_abc123',
        name: 'My Project',
      },
      repos: {
        primary: 'github.com/acme/main-api',
        dev: ['github.com/acme/main-api', 'github.com/acme/shared-lib'],
        clone: ['github.com/acme/main-api', 'github.com/acme/docs'],
      },
    };
    expect(() => validateNoDuplicateRepos(config)).toThrow(ConfigValidationError);
    expect(() => validateNoDuplicateRepos(config)).toThrow(
      'Duplicate repositories found: github.com/acme/main-api'
    );
  });

  it('should pass when same owner has different repos', () => {
    const config: GeneracyConfig = {
      schemaVersion: '1',
      project: {
        id: 'proj_abc123',
        name: 'My Project',
      },
      repos: {
        primary: 'github.com/acme/main-api',
        dev: ['github.com/acme/shared-lib', 'github.com/acme/worker-service'],
        clone: ['github.com/acme/design-system', 'github.com/acme/api-docs'],
      },
    };
    expect(() => validateNoDuplicateRepos(config)).not.toThrow();
  });

  it('should include conflicting URLs in error message', () => {
    const config: GeneracyConfig = {
      schemaVersion: '1',
      project: {
        id: 'proj_abc123',
        name: 'My Project',
      },
      repos: {
        primary: 'github.com/acme/main-api',
        dev: ['github.com/acme/shared-lib'],
        clone: ['github.com/acme/shared-lib'],
      },
    };

    try {
      validateNoDuplicateRepos(config);
      fail('Expected ConfigValidationError to be thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      if (error instanceof ConfigValidationError) {
        expect(error.message).toContain('github.com/acme/shared-lib');
        expect(error.conflictingRepos).toEqual(['github.com/acme/shared-lib']);
        expect(error.locations).toContain('dev');
        expect(error.locations).toContain('clone');
      }
    }
  });

  it('should handle undefined dev and clone lists', () => {
    const config: GeneracyConfig = {
      schemaVersion: '1',
      project: {
        id: 'proj_abc123',
        name: 'My Project',
      },
      repos: {
        primary: 'github.com/acme/main-api',
      },
    };
    expect(() => validateNoDuplicateRepos(config)).not.toThrow();
  });
});

describe('validateSemantics', () => {
  it('should pass all semantic validations for valid config', () => {
    const config: GeneracyConfig = {
      schemaVersion: '1',
      project: {
        id: 'proj_abc123',
        name: 'My Project',
      },
      repos: {
        primary: 'github.com/acme/main-api',
        dev: ['github.com/acme/shared-lib'],
        clone: ['github.com/acme/design-system'],
      },
    };
    expect(() => validateSemantics(config)).not.toThrow();
  });

  it('should fail semantic validation for duplicate repos', () => {
    const config: GeneracyConfig = {
      schemaVersion: '1',
      project: {
        id: 'proj_abc123',
        name: 'My Project',
      },
      repos: {
        primary: 'github.com/acme/main-api',
        dev: ['github.com/acme/main-api'],
        clone: [],
      },
    };
    expect(() => validateSemantics(config)).toThrow(ConfigValidationError);
  });
});
