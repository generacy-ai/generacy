import { describe, it, expect } from 'vitest';
import {
  ProjectConfigSchema,
  ReposConfigSchema,
  DefaultsConfigSchema,
  OrchestratorSettingsSchema,
  GeneracyConfigSchema,
  validateConfig,
} from '../schema.js';

describe('ProjectConfigSchema', () => {
  it('should validate a valid project config', () => {
    const config = {
      id: 'proj_test123',
      name: 'My Project',
    };
    const result = ProjectConfigSchema.parse(config);
    expect(result).toEqual(config);
  });

  it('should reject project ID without proj_ prefix', () => {
    const config = {
      id: 'abc123',
      name: 'My Project',
    };
    expect(() => ProjectConfigSchema.parse(config)).toThrow(
      'Project ID must match format: proj_{alphanumeric}'
    );
  });

  it('should reject project ID shorter than 12 characters', () => {
    const config = {
      id: 'proj_abc',
      name: 'My Project',
    };
    expect(() => ProjectConfigSchema.parse(config)).toThrow(
      'Project ID must be at least 12 characters'
    );
  });

  it('should reject project ID with uppercase letters', () => {
    const config = {
      id: 'proj_ABC123',
      name: 'My Project',
    };
    expect(() => ProjectConfigSchema.parse(config)).toThrow(
      'Project ID must match format: proj_{alphanumeric}'
    );
  });

  it('should reject project ID with special characters', () => {
    const config = {
      id: 'proj_abc-123',
      name: 'My Project',
    };
    expect(() => ProjectConfigSchema.parse(config)).toThrow(
      'Project ID must match format: proj_{alphanumeric}'
    );
  });

  it('should accept project ID exactly 12 characters (boundary test)', () => {
    const config = {
      id: 'proj_abc1234',
      name: 'My Project',
    };
    const result = ProjectConfigSchema.parse(config);
    expect(result.id).toEqual('proj_abc1234');
  });

  it('should reject empty project name', () => {
    const config = {
      id: 'proj_test123',
      name: '',
    };
    expect(() => ProjectConfigSchema.parse(config)).toThrow(
      'Project name cannot be empty'
    );
  });

  it('should reject project name longer than 255 characters', () => {
    const config = {
      id: 'proj_test123',
      name: 'a'.repeat(256),
    };
    expect(() => ProjectConfigSchema.parse(config)).toThrow(
      'Project name cannot exceed 255 characters'
    );
  });

  it('should accept project name exactly 255 characters (boundary test)', () => {
    const config = {
      id: 'proj_test123',
      name: 'a'.repeat(255),
    };
    const result = ProjectConfigSchema.parse(config);
    expect(result.name).toHaveLength(255);
  });
});

describe('ReposConfigSchema', () => {
  it('should validate a valid repos config with only primary', () => {
    const config = {
      primary: 'github.com/acme/main-api',
    };
    const result = ReposConfigSchema.parse(config);
    expect(result).toEqual({
      primary: 'github.com/acme/main-api',
      dev: [],
      clone: [],
    });
  });

  it('should validate a valid repos config with all fields', () => {
    const config = {
      primary: 'github.com/acme/main-api',
      dev: ['github.com/acme/shared-lib', 'github.com/acme/worker-service'],
      clone: ['github.com/acme/design-system'],
    };
    const result = ReposConfigSchema.parse(config);
    expect(result).toEqual(config);
  });

  it('should default dev and clone to empty arrays when omitted', () => {
    const config = {
      primary: 'github.com/acme/main-api',
    };
    const result = ReposConfigSchema.parse(config);
    expect(result.dev).toEqual([]);
    expect(result.clone).toEqual([]);
  });

  it('should reject invalid repository URL format (missing github.com)', () => {
    const config = {
      primary: 'acme/main-api',
    };
    expect(() => ReposConfigSchema.parse(config)).toThrow(
      'Repository URL must match format: github.com/{owner}/{repo}'
    );
  });

  it('should reject invalid repository URL format (with protocol)', () => {
    const config = {
      primary: 'https://github.com/acme/main-api',
    };
    expect(() => ReposConfigSchema.parse(config)).toThrow(
      'Repository URL must match format: github.com/{owner}/{repo}'
    );
  });

  it('should reject invalid repository URL format (with .git suffix)', () => {
    const config = {
      primary: 'github.com/acme/main-api.git',
    };
    expect(() => ReposConfigSchema.parse(config)).toThrow(
      'Repository URL must not end with .git suffix'
    );
  });

  it('should accept repository names with dots and underscores', () => {
    const config = {
      primary: 'github.com/acme-org/main.api_v2',
    };
    const result = ReposConfigSchema.parse(config);
    expect(result.primary).toEqual('github.com/acme-org/main.api_v2');
  });

  it('should reject repository URL with ssh protocol', () => {
    const config = {
      primary: 'git@github.com:acme/main-api',
    };
    expect(() => ReposConfigSchema.parse(config)).toThrow(
      'Repository URL must match format: github.com/{owner}/{repo}'
    );
  });

  it('should reject repository URL missing owner/repo parts', () => {
    const config = {
      primary: 'github.com/acme',
    };
    expect(() => ReposConfigSchema.parse(config)).toThrow(
      'Repository URL must match format: github.com/{owner}/{repo}'
    );
  });

  it('should reject repository URL with trailing slash', () => {
    const config = {
      primary: 'github.com/acme/main-api/',
    };
    expect(() => ReposConfigSchema.parse(config)).toThrow(
      'Repository URL must match format: github.com/{owner}/{repo}'
    );
  });

  it('should validate dev array with multiple repositories', () => {
    const config = {
      primary: 'github.com/acme/main-api',
      dev: ['github.com/acme/lib1', 'github.com/acme/lib2', 'github.com/acme/lib3'],
    };
    const result = ReposConfigSchema.parse(config);
    expect(result.dev).toHaveLength(3);
  });

  it('should validate clone array with multiple repositories', () => {
    const config = {
      primary: 'github.com/acme/main-api',
      clone: ['github.com/other/lib1', 'github.com/other/lib2'],
    };
    const result = ReposConfigSchema.parse(config);
    expect(result.clone).toHaveLength(2);
  });
});

describe('DefaultsConfigSchema', () => {
  it('should validate a valid defaults config', () => {
    const config = {
      agent: 'claude-code',
      baseBranch: 'main',
    };
    const result = DefaultsConfigSchema.parse(config);
    expect(result).toEqual(config);
  });

  it('should allow empty defaults config', () => {
    const config = {};
    const result = DefaultsConfigSchema.parse(config);
    expect(result).toEqual({});
  });

  it('should reject agent name with uppercase letters', () => {
    const config = {
      agent: 'Claude-Code',
    };
    expect(() => DefaultsConfigSchema.parse(config)).toThrow(
      'Agent name must be kebab-case format'
    );
  });

  it('should reject agent name with underscores', () => {
    const config = {
      agent: 'claude_code',
    };
    expect(() => DefaultsConfigSchema.parse(config)).toThrow(
      'Agent name must be kebab-case format'
    );
  });

  it('should accept multi-word kebab-case agent names', () => {
    const config = {
      agent: 'claude-code-v2',
    };
    const result = DefaultsConfigSchema.parse(config);
    expect(result.agent).toEqual('claude-code-v2');
  });

  it('should reject empty base branch', () => {
    const config = {
      baseBranch: '',
    };
    expect(() => DefaultsConfigSchema.parse(config)).toThrow(
      'Base branch cannot be empty'
    );
  });

  it('should accept agent name with numbers', () => {
    const config = {
      agent: 'claude-code-v2',
    };
    const result = DefaultsConfigSchema.parse(config);
    expect(result.agent).toEqual('claude-code-v2');
  });

  it('should accept single-word agent name', () => {
    const config = {
      agent: 'cursor',
    };
    const result = DefaultsConfigSchema.parse(config);
    expect(result.agent).toEqual('cursor');
  });

  it('should reject agent name starting with hyphen', () => {
    const config = {
      agent: '-claude-code',
    };
    expect(() => DefaultsConfigSchema.parse(config)).toThrow(
      'Agent name must be kebab-case format'
    );
  });

  it('should reject agent name ending with hyphen', () => {
    const config = {
      agent: 'claude-code-',
    };
    expect(() => DefaultsConfigSchema.parse(config)).toThrow(
      'Agent name must be kebab-case format'
    );
  });

  it('should accept branch name with slashes (feature branches)', () => {
    const config = {
      baseBranch: 'feature/new-feature',
    };
    const result = DefaultsConfigSchema.parse(config);
    expect(result.baseBranch).toEqual('feature/new-feature');
  });
});

describe('OrchestratorSettingsSchema', () => {
  it('should validate valid orchestrator settings', () => {
    const config = {
      pollIntervalMs: 5000,
      workerCount: 3,
    };
    const result = OrchestratorSettingsSchema.parse(config);
    expect(result).toEqual(config);
  });

  it('should allow empty orchestrator settings', () => {
    const config = {};
    const result = OrchestratorSettingsSchema.parse(config);
    expect(result).toEqual({});
  });

  it('should reject pollIntervalMs less than 5000', () => {
    const config = {
      pollIntervalMs: 1000,
    };
    expect(() => OrchestratorSettingsSchema.parse(config)).toThrow(
      'Poll interval must be at least 5000ms'
    );
  });

  it('should reject non-integer pollIntervalMs', () => {
    const config = {
      pollIntervalMs: 5000.5,
    };
    expect(() => OrchestratorSettingsSchema.parse(config)).toThrow(
      'Poll interval must be an integer'
    );
  });

  it('should reject workerCount less than 1', () => {
    const config = {
      workerCount: 0,
    };
    expect(() => OrchestratorSettingsSchema.parse(config)).toThrow(
      'Worker count must be at least 1'
    );
  });

  it('should reject workerCount greater than 20', () => {
    const config = {
      workerCount: 21,
    };
    expect(() => OrchestratorSettingsSchema.parse(config)).toThrow(
      'Worker count cannot exceed 20'
    );
  });

  it('should reject non-integer workerCount', () => {
    const config = {
      workerCount: 3.5,
    };
    expect(() => OrchestratorSettingsSchema.parse(config)).toThrow(
      'Worker count must be an integer'
    );
  });

  it('should accept pollIntervalMs exactly at minimum (boundary test)', () => {
    const config = {
      pollIntervalMs: 5000,
    };
    const result = OrchestratorSettingsSchema.parse(config);
    expect(result.pollIntervalMs).toEqual(5000);
  });

  it('should accept workerCount of 1 (boundary test)', () => {
    const config = {
      workerCount: 1,
    };
    const result = OrchestratorSettingsSchema.parse(config);
    expect(result.workerCount).toEqual(1);
  });

  it('should accept workerCount of 20 (boundary test)', () => {
    const config = {
      workerCount: 20,
    };
    const result = OrchestratorSettingsSchema.parse(config);
    expect(result.workerCount).toEqual(20);
  });

  it('should accept large pollIntervalMs values', () => {
    const config = {
      pollIntervalMs: 60000, // 1 minute
    };
    const result = OrchestratorSettingsSchema.parse(config);
    expect(result.pollIntervalMs).toEqual(60000);
  });

  it('should reject negative workerCount', () => {
    const config = {
      workerCount: -1,
    };
    expect(() => OrchestratorSettingsSchema.parse(config)).toThrow(
      'Worker count must be at least 1'
    );
  });

  it('should reject negative pollIntervalMs', () => {
    const config = {
      pollIntervalMs: -5000,
    };
    expect(() => OrchestratorSettingsSchema.parse(config)).toThrow(
      'Poll interval must be at least 5000ms'
    );
  });
});

describe('GeneracyConfigSchema', () => {
  it('should validate a minimal valid config', () => {
    const config = {
      project: {
        id: 'proj_test123',
        name: 'My Project',
      },
      repos: {
        primary: 'github.com/acme/main-api',
      },
    };
    const result = GeneracyConfigSchema.parse(config);
    expect(result.schemaVersion).toEqual('1');
    expect(result.project).toEqual(config.project);
    expect(result.repos.primary).toEqual(config.repos.primary);
    expect(result.repos.dev).toEqual([]);
    expect(result.repos.clone).toEqual([]);
  });

  it('should validate a full config with all fields', () => {
    const config = {
      schemaVersion: '1',
      project: {
        id: 'proj_test123xyz',
        name: 'My Full Project',
      },
      repos: {
        primary: 'github.com/acme/main-api',
        dev: ['github.com/acme/shared-lib', 'github.com/acme/worker-service'],
        clone: ['github.com/acme/design-system'],
      },
      defaults: {
        agent: 'claude-code',
        baseBranch: 'main',
      },
      orchestrator: {
        pollIntervalMs: 5000,
        workerCount: 3,
      },
    };
    const result = GeneracyConfigSchema.parse(config);
    expect(result).toEqual(config);
  });

  it('should default schemaVersion to "1" when omitted', () => {
    const config = {
      project: {
        id: 'proj_test123',
        name: 'My Project',
      },
      repos: {
        primary: 'github.com/acme/main-api',
      },
    };
    const result = GeneracyConfigSchema.parse(config);
    expect(result.schemaVersion).toEqual('1');
  });

  it('should reject config missing project', () => {
    const config = {
      repos: {
        primary: 'github.com/acme/main-api',
      },
    };
    expect(() => GeneracyConfigSchema.parse(config)).toThrow();
  });

  it('should reject config missing repos', () => {
    const config = {
      project: {
        id: 'proj_test123',
        name: 'My Project',
      },
    };
    expect(() => GeneracyConfigSchema.parse(config)).toThrow();
  });

  it('should validate config with only defaults (no orchestrator)', () => {
    const config = {
      project: {
        id: 'proj_test123',
        name: 'My Project',
      },
      repos: {
        primary: 'github.com/acme/main-api',
      },
      defaults: {
        agent: 'claude-code',
        baseBranch: 'main',
      },
    };
    const result = GeneracyConfigSchema.parse(config);
    expect(result.defaults).toBeDefined();
    expect(result.orchestrator).toBeUndefined();
  });

  it('should validate config with only orchestrator (no defaults)', () => {
    const config = {
      project: {
        id: 'proj_test123',
        name: 'My Project',
      },
      repos: {
        primary: 'github.com/acme/main-api',
      },
      orchestrator: {
        pollIntervalMs: 5000,
        workerCount: 3,
      },
    };
    const result = GeneracyConfigSchema.parse(config);
    expect(result.orchestrator).toBeDefined();
    expect(result.defaults).toBeUndefined();
  });

  it('should accept custom schemaVersion string', () => {
    const config = {
      schemaVersion: '2',
      project: {
        id: 'proj_test123',
        name: 'My Project',
      },
      repos: {
        primary: 'github.com/acme/main-api',
      },
    };
    const result = GeneracyConfigSchema.parse(config);
    expect(result.schemaVersion).toEqual('2');
  });

  it('should validate complex multi-repo config', () => {
    const config = {
      project: {
        id: 'proj_complex123',
        name: 'Complex Multi-Repo Project',
      },
      repos: {
        primary: 'github.com/acme/main-api',
        dev: [
          'github.com/acme/shared-lib',
          'github.com/acme/worker-service',
          'github.com/acme/admin-ui',
        ],
        clone: [
          'github.com/acme/design-system',
          'github.com/public/api-docs',
        ],
      },
      defaults: {
        agent: 'claude-code',
        baseBranch: 'develop',
      },
      orchestrator: {
        pollIntervalMs: 10000,
        workerCount: 5,
      },
    };
    const result = GeneracyConfigSchema.parse(config);
    expect(result.repos.dev).toHaveLength(3);
    expect(result.repos.clone).toHaveLength(2);
    expect(result.orchestrator?.workerCount).toEqual(5);
  });
});

describe('validateConfig', () => {
  it('should validate a valid config', () => {
    const config = {
      project: {
        id: 'proj_test123',
        name: 'My Project',
      },
      repos: {
        primary: 'github.com/acme/main-api',
      },
    };
    const result = validateConfig(config);
    expect(result.project.id).toEqual('proj_test123');
    expect(result.schemaVersion).toEqual('1');
  });

  it('should throw ZodError for invalid config', () => {
    const config = {
      project: {
        id: 'invalid',
        name: 'My Project',
      },
      repos: {
        primary: 'github.com/acme/main-api',
      },
    };
    expect(() => validateConfig(config)).toThrow();
  });
});
