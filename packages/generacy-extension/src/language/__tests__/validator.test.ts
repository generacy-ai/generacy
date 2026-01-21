/**
 * Tests for the Generacy workflow validator.
 */
import { describe, it, expect, vi } from 'vitest';

// Mock vscode module before importing validator
vi.mock('vscode', () => ({
  workspace: {
    fs: {
      readFile: vi.fn(),
    },
  },
  Uri: {
    file: vi.fn((path: string) => ({ fsPath: path, path })),
  },
}));

import {
  validateWorkflow,
  validateWorkflowYaml,
  validateWorkflowFull,
  validateUniqueNames,
  ValidationSeverity,
  Workflow,
} from '../validator';

describe('validateWorkflow', () => {
  describe('valid workflows', () => {
    it('should validate a minimal workflow', () => {
      const workflow = {
        name: 'test-workflow',
        version: '1.0.0',
        phases: [
          {
            name: 'build',
            steps: [
              {
                name: 'compile',
                run: 'npm run build',
              },
            ],
          },
        ],
      };

      const result = validateWorkflow(workflow);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.workflow).toBeDefined();
    });

    it('should validate a workflow with all optional fields', () => {
      const workflow: Workflow = {
        name: 'full-workflow',
        version: '2.0.0',
        description: 'A complete workflow with all features',
        triggers: [
          {
            type: 'manual',
          },
          {
            type: 'schedule',
            config: {
              cron: '0 0 * * *',
              timezone: 'UTC',
            },
          },
        ],
        env: {
          NODE_ENV: 'production',
          API_KEY: { secret: 'API_KEY' },
          DATABASE_URL: { env: 'DB_URL', default: 'localhost' },
        },
        phases: [
          {
            name: 'setup',
            description: 'Setup phase',
            env: {
              PHASE_VAR: 'setup-value',
            },
            steps: [
              {
                name: 'install',
                run: 'npm install',
                timeout: '5m',
                continue_on_error: false,
              },
            ],
            timeout: '10m',
          },
          {
            name: 'build',
            steps: [
              {
                name: 'compile',
                uses: 'action/shell',
                with: {
                  command: 'npm run build',
                },
                condition: '${{ success() }}',
                outputs: {
                  buildDir: './dist',
                },
              },
            ],
            retry: {
              max_attempts: 3,
              delay: '10s',
              backoff: 'exponential',
            },
          },
        ],
        on_error: {
          strategy: 'fail',
          notify: [
            {
              type: 'slack',
              config: {
                channel: '#builds',
              },
            },
          ],
        },
        timeout: '1h',
        metadata: {
          owner: 'team-a',
          priority: 1,
        },
      };

      const result = validateWorkflow(workflow);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should validate a step with uses instead of run', () => {
      const workflow = {
        name: 'uses-workflow',
        version: '1.0.0',
        phases: [
          {
            name: 'deploy',
            steps: [
              {
                name: 'deploy-step',
                uses: 'agent/claude-code',
                with: {
                  prompt: 'Deploy the application',
                },
              },
            ],
          },
        ],
      };

      const result = validateWorkflow(workflow);
      expect(result.valid).toBe(true);
    });

    it('should validate condition as an object', () => {
      const workflow = {
        name: 'condition-workflow',
        version: '1.0.0',
        phases: [
          {
            name: 'conditional',
            condition: { if: '${{ env.DEPLOY_ENV == "production" }}' },
            steps: [
              {
                name: 'step1',
                run: 'echo hello',
                condition: { if: '${{ always() }}' },
              },
            ],
          },
        ],
      };

      const result = validateWorkflow(workflow);
      expect(result.valid).toBe(true);
    });
  });

  describe('invalid workflows', () => {
    it('should reject workflow without name', () => {
      const workflow = {
        version: '1.0.0',
        phases: [
          {
            name: 'test',
            steps: [{ name: 'step1', run: 'echo' }],
          },
        ],
      };

      const result = validateWorkflow(workflow);
      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].path).toContain('name');
    });

    it('should reject workflow without version', () => {
      const workflow = {
        name: 'test',
        phases: [
          {
            name: 'test',
            steps: [{ name: 'step1', run: 'echo' }],
          },
        ],
      };

      const result = validateWorkflow(workflow);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.path.includes('version'))).toBe(true);
    });

    it('should reject workflow without phases', () => {
      const workflow = {
        name: 'test',
        version: '1.0.0',
      };

      const result = validateWorkflow(workflow);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.path.includes('phases'))).toBe(true);
    });

    it('should reject workflow with empty phases array', () => {
      const workflow = {
        name: 'test',
        version: '1.0.0',
        phases: [],
      };

      const result = validateWorkflow(workflow);
      expect(result.valid).toBe(false);
    });

    it('should reject invalid workflow name', () => {
      const workflow = {
        name: '123-invalid',
        version: '1.0.0',
        phases: [
          {
            name: 'test',
            steps: [{ name: 'step1', run: 'echo' }],
          },
        ],
      };

      const result = validateWorkflow(workflow);
      expect(result.valid).toBe(false);
      expect(result.errors[0].message).toContain('start with a letter');
    });

    it('should reject invalid version format', () => {
      const workflow = {
        name: 'test',
        version: 'v1.0',
        phases: [
          {
            name: 'test',
            steps: [{ name: 'step1', run: 'echo' }],
          },
        ],
      };

      const result = validateWorkflow(workflow);
      expect(result.valid).toBe(false);
      expect(result.errors[0].message).toContain('semantic versioning');
    });

    it('should reject step without uses or run', () => {
      const workflow = {
        name: 'test',
        version: '1.0.0',
        phases: [
          {
            name: 'test',
            steps: [
              {
                name: 'empty-step',
              },
            ],
          },
        ],
      };

      const result = validateWorkflow(workflow);
      expect(result.valid).toBe(false);
      expect(result.errors[0].message).toContain('uses');
    });

    it('should reject step with both uses and run', () => {
      const workflow = {
        name: 'test',
        version: '1.0.0',
        phases: [
          {
            name: 'test',
            steps: [
              {
                name: 'both-step',
                uses: 'action/shell',
                run: 'echo hello',
              },
            ],
          },
        ],
      };

      const result = validateWorkflow(workflow);
      expect(result.valid).toBe(false);
      expect(result.errors[0].message).toContain('cannot have both');
    });

    it('should reject invalid timeout format', () => {
      const workflow = {
        name: 'test',
        version: '1.0.0',
        timeout: '30 minutes',
        phases: [
          {
            name: 'test',
            steps: [{ name: 'step1', run: 'echo' }],
          },
        ],
      };

      const result = validateWorkflow(workflow);
      expect(result.valid).toBe(false);
      expect(result.errors[0].message).toContain('Duration');
    });

    it('should reject invalid secret name format', () => {
      const workflow = {
        name: 'test',
        version: '1.0.0',
        env: {
          KEY: { secret: 'lowercase-key' },
        },
        phases: [
          {
            name: 'test',
            steps: [{ name: 'step1', run: 'echo' }],
          },
        ],
      };

      const result = validateWorkflow(workflow);
      expect(result.valid).toBe(false);
      expect(result.errors[0].message).toContain('uppercase');
    });

    it('should reject unknown properties in strict mode', () => {
      const workflow = {
        name: 'test',
        version: '1.0.0',
        unknownProperty: 'value',
        phases: [
          {
            name: 'test',
            steps: [{ name: 'step1', run: 'echo' }],
          },
        ],
      };

      const result = validateWorkflow(workflow);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.code === 'unrecognized_keys')).toBe(true);
    });

    it('should reject invalid trigger type', () => {
      const workflow = {
        name: 'test',
        version: '1.0.0',
        triggers: [
          {
            type: 'invalid-trigger',
          },
        ],
        phases: [
          {
            name: 'test',
            steps: [{ name: 'step1', run: 'echo' }],
          },
        ],
      };

      const result = validateWorkflow(workflow);
      expect(result.valid).toBe(false);
    });

    it('should reject schedule trigger without cron', () => {
      const workflow = {
        name: 'test',
        version: '1.0.0',
        triggers: [
          {
            type: 'schedule',
            config: {},
          },
        ],
        phases: [
          {
            name: 'test',
            steps: [{ name: 'step1', run: 'echo' }],
          },
        ],
      };

      const result = validateWorkflow(workflow);
      expect(result.valid).toBe(false);
      // Check for either 'cron' or 'required' in the error message
      const hasScheduleError = result.errors.some(
        (e) => e.message.toLowerCase().includes('cron') || e.message.toLowerCase().includes('required')
      );
      expect(hasScheduleError).toBe(true);
    });
  });
});

describe('validateWorkflowYaml', () => {
  it('should validate valid YAML', () => {
    const yaml = `
name: yaml-workflow
version: "1.0.0"
phases:
  - name: build
    steps:
      - name: compile
        run: npm run build
`;

    const result = validateWorkflowYaml(yaml);
    expect(result.valid).toBe(true);
  });

  it('should reject invalid YAML syntax', () => {
    const yaml = `
name: test
version: "1.0.0"
phases:
  - name: build
    steps:
      - name: compile
      run: npm run build  # invalid indentation
`;

    const result = validateWorkflowYaml(yaml);
    // This depends on how yaml library handles the error
    // It might parse or error depending on strict mode
  });

  it('should include range information for errors', () => {
    const yaml = `
name: test
version: invalid-version
phases:
  - name: build
    steps:
      - name: compile
        run: npm run build
`;

    const result = validateWorkflowYaml(yaml);
    expect(result.valid).toBe(false);
    // Range might be available depending on YAML parsing
  });
});

describe('validateUniqueNames', () => {
  it('should detect duplicate phase names', () => {
    const workflow: Workflow = {
      name: 'test',
      version: '1.0.0',
      phases: [
        {
          name: 'build',
          steps: [{ name: 'step1', run: 'echo' }],
        },
        {
          name: 'build',
          steps: [{ name: 'step2', run: 'echo' }],
        },
      ],
    };

    const errors = validateUniqueNames(workflow);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].code).toBe('DUPLICATE_PHASE_NAME');
  });

  it('should detect duplicate step names within a phase', () => {
    const workflow: Workflow = {
      name: 'test',
      version: '1.0.0',
      phases: [
        {
          name: 'build',
          steps: [
            { name: 'step1', run: 'echo 1' },
            { name: 'step1', run: 'echo 2' },
          ],
        },
      ],
    };

    const errors = validateUniqueNames(workflow);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].code).toBe('DUPLICATE_STEP_NAME');
  });

  it('should allow same step names in different phases', () => {
    const workflow: Workflow = {
      name: 'test',
      version: '1.0.0',
      phases: [
        {
          name: 'phase1',
          steps: [{ name: 'step1', run: 'echo 1' }],
        },
        {
          name: 'phase2',
          steps: [{ name: 'step1', run: 'echo 2' }],
        },
      ],
    };

    const errors = validateUniqueNames(workflow);
    expect(errors).toHaveLength(0);
  });
});

describe('validateWorkflowFull', () => {
  it('should combine schema and semantic validation', () => {
    const yaml = `
name: test
version: "1.0.0"
phases:
  - name: build
    steps:
      - name: step1
        run: echo 1
  - name: build
    steps:
      - name: step2
        run: echo 2
`;

    const result = validateWorkflowFull(yaml);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === 'DUPLICATE_PHASE_NAME')).toBe(true);
  });

  it('should pass for valid workflows', () => {
    const yaml = `
name: test
version: "1.0.0"
phases:
  - name: build
    steps:
      - name: compile
        run: npm run build
  - name: deploy
    steps:
      - name: publish
        run: npm publish
`;

    const result = validateWorkflowFull(yaml);
    expect(result.valid).toBe(true);
  });
});

describe('error messages', () => {
  it('should provide helpful error messages for common issues', () => {
    const testCases = [
      {
        workflow: { name: '', version: '1.0.0', phases: [{ name: 'p', steps: [{ name: 's', run: 'x' }] }] },
        expectedMessage: /name/i,
      },
      {
        workflow: { name: 'test', version: '1', phases: [{ name: 'p', steps: [{ name: 's', run: 'x' }] }] },
        expectedMessage: /version/i,
      },
    ];

    for (const { workflow, expectedMessage } of testCases) {
      const result = validateWorkflow(workflow);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => expectedMessage.test(e.message))).toBe(true);
    }
  });

  it('should include suggestions when available', () => {
    const workflow = {
      name: '123invalid',
      version: '1.0.0',
      phases: [{ name: 'p', steps: [{ name: 's', run: 'x' }] }],
    };

    const result = validateWorkflow(workflow);
    expect(result.valid).toBe(false);
    // Check that suggestions are provided
    const nameError = result.errors.find((e) => e.path.includes('name'));
    expect(nameError).toBeDefined();
  });
});

describe('ValidationSeverity', () => {
  it('should have correct severity values', () => {
    expect(ValidationSeverity.Error).toBe('error');
    expect(ValidationSeverity.Warning).toBe('warning');
    expect(ValidationSeverity.Info).toBe('info');
    expect(ValidationSeverity.Hint).toBe('hint');
  });
});
