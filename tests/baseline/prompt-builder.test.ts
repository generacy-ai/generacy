import { describe, it, expect, beforeEach } from 'vitest';
import { PromptBuilder } from '../../src/baseline/prompt-builder.js';
import { DEFAULT_BASELINE_CONFIG } from '../../src/baseline/types.js';
import type { DecisionRequest, BaselineConfig } from '../../src/baseline/types.js';

// Sample decision requests for testing
function createMinimalDecisionRequest(): DecisionRequest {
  return {
    id: 'req-001',
    description: 'Choose a database for the application',
    options: [
      {
        id: 'opt-postgres',
        name: 'PostgreSQL',
        description: 'Relational database with ACID compliance',
      },
      {
        id: 'opt-mongo',
        name: 'MongoDB',
        description: 'NoSQL document database',
      },
    ],
    context: {
      name: 'Test Project',
    },
    requestedAt: new Date('2024-01-15T10:00:00Z'),
  };
}

function createFullDecisionRequest(): DecisionRequest {
  return {
    id: 'req-002',
    description: 'Select a frontend framework for the e-commerce platform',
    options: [
      {
        id: 'opt-react',
        name: 'React',
        description: 'Component-based UI library by Meta',
        pros: ['Large ecosystem', 'Strong community support', 'Flexible architecture'],
        cons: ['Steep learning curve', 'Requires additional libraries for state management'],
        metadata: { version: '18.2', license: 'MIT' },
      },
      {
        id: 'opt-vue',
        name: 'Vue.js',
        description: 'Progressive JavaScript framework',
        pros: ['Gentle learning curve', 'Built-in state management', 'Excellent documentation'],
        cons: ['Smaller ecosystem than React', 'Fewer job opportunities'],
        metadata: { version: '3.4', license: 'MIT' },
      },
      {
        id: 'opt-svelte',
        name: 'Svelte',
        description: 'Compiler-based framework with no virtual DOM',
        pros: ['Excellent performance', 'Less boilerplate', 'Simple syntax'],
        cons: ['Smaller community', 'Fewer third-party libraries'],
      },
    ],
    context: {
      name: 'E-Commerce Platform',
      description: 'A modern e-commerce platform for retail products',
      techStack: ['Node.js', 'TypeScript', 'PostgreSQL', 'Redis'],
      teamSize: 8,
      phase: 'development',
      domain: 'E-commerce',
      additionalContext: {
        targetUsers: 'B2C customers',
        scalabilityRequirement: 'High',
      },
    },
    constraints: {
      deadline: new Date('2024-06-30T00:00:00Z'),
      budget: { amount: 50000, currency: 'USD' },
      requiredFeatures: ['Server-side rendering', 'TypeScript support', 'Internationalization'],
      excludedTechnologies: ['jQuery', 'AngularJS'],
    },
    requestedAt: new Date('2024-01-15T10:00:00Z'),
  };
}

describe('PromptBuilder', () => {
  let promptBuilder: PromptBuilder;

  beforeEach(() => {
    promptBuilder = new PromptBuilder();
  });

  describe('constructor', () => {
    it('should use DEFAULT_BASELINE_CONFIG when no config provided', () => {
      const builder = new PromptBuilder();
      // Verify by checking that all factors are enabled in the generated system prompt
      const systemPrompt = builder.buildSystemPrompt();
      expect(systemPrompt).toContain('Project Context');
      expect(systemPrompt).toContain('Domain Best Practices');
      expect(systemPrompt).toContain('Team Size');
      expect(systemPrompt).toContain('Existing Technology Stack');
    });

    it('should accept custom config', () => {
      const customConfig: BaselineConfig = {
        factors: {
          projectContext: true,
          domainBestPractices: false,
          teamSize: false,
          existingStack: true,
        },
        confidenceThreshold: 70,
        requireReasoning: true,
      };

      const builder = new PromptBuilder(customConfig);
      const systemPrompt = builder.buildSystemPrompt();

      expect(systemPrompt).toContain('Project Context');
      expect(systemPrompt).toContain('Existing Technology Stack');
      expect(systemPrompt).not.toContain('Domain Best Practices');
      expect(systemPrompt).not.toContain('Team Size');
    });
  });

  describe('setConfig', () => {
    it('should update the config', () => {
      const newConfig: BaselineConfig = {
        factors: {
          projectContext: false,
          domainBestPractices: true,
          teamSize: false,
          existingStack: false,
        },
        confidenceThreshold: 60,
        requireReasoning: false,
      };

      promptBuilder.setConfig(newConfig);
      const systemPrompt = promptBuilder.buildSystemPrompt();

      expect(systemPrompt).toContain('Domain Best Practices');
      expect(systemPrompt).not.toContain('Project Context:');
      expect(systemPrompt).not.toContain('Team Size:');
      expect(systemPrompt).not.toContain('Existing Technology Stack');
    });

    it('should affect subsequent prompt generation', () => {
      // Initial prompt with all factors enabled
      const initialPrompt = promptBuilder.buildSystemPrompt();
      expect(initialPrompt).toContain('Project Context');

      // Update config to disable all factors
      const noFactorsConfig: BaselineConfig = {
        factors: {
          projectContext: false,
          domainBestPractices: false,
          teamSize: false,
          existingStack: false,
        },
        confidenceThreshold: 50,
        requireReasoning: true,
      };

      promptBuilder.setConfig(noFactorsConfig);
      const updatedPrompt = promptBuilder.buildSystemPrompt();

      // Should fall back to general best practices
      expect(updatedPrompt).toContain('General best practices');
      expect(updatedPrompt).not.toContain('Project Context:');
    });
  });

  describe('buildSystemPrompt', () => {
    it('should return a non-empty string', () => {
      const systemPrompt = promptBuilder.buildSystemPrompt();
      expect(systemPrompt).toBeTruthy();
      expect(typeof systemPrompt).toBe('string');
      expect(systemPrompt.length).toBeGreaterThan(0);
    });

    it('should include instructions about objective analysis', () => {
      const systemPrompt = promptBuilder.buildSystemPrompt();
      expect(systemPrompt).toContain('objective');
      expect(systemPrompt).toContain('technical decision analyzer');
      expect(systemPrompt).toContain('objective best practices');
    });

    it('should list enabled factors when all factors enabled', () => {
      const systemPrompt = promptBuilder.buildSystemPrompt();

      expect(systemPrompt).toContain("Project Context: Consider the project's goals");
      expect(systemPrompt).toContain('Domain Best Practices: Apply industry standards');
      expect(systemPrompt).toContain('Team Size: Consider how team size affects');
      expect(systemPrompt).toContain('Existing Technology Stack: Evaluate compatibility');
    });

    it('should only list enabled factors when some disabled', () => {
      const partialConfig: BaselineConfig = {
        factors: {
          projectContext: true,
          domainBestPractices: false,
          teamSize: true,
          existingStack: false,
        },
        confidenceThreshold: 50,
        requireReasoning: true,
      };

      promptBuilder.setConfig(partialConfig);
      const systemPrompt = promptBuilder.buildSystemPrompt();

      expect(systemPrompt).toContain('Project Context');
      expect(systemPrompt).toContain('Team Size');
      expect(systemPrompt).not.toContain('Domain Best Practices');
      expect(systemPrompt).not.toContain('Existing Technology Stack');
    });

    it('should include JSON output format instructions', () => {
      const systemPrompt = promptBuilder.buildSystemPrompt();

      expect(systemPrompt).toContain('JSON');
      expect(systemPrompt).toContain('optionId');
      expect(systemPrompt).toContain('confidence');
      expect(systemPrompt).toContain('reasoning');
      expect(systemPrompt).toContain('factors');
      expect(systemPrompt).toContain('alternativeOptionAnalysis');
      expect(systemPrompt).toContain('Output Format');
    });

    it('should mention NOT using human-specific knowledge', () => {
      const systemPrompt = promptBuilder.buildSystemPrompt();

      expect(systemPrompt).toContain('NOT');
      expect(systemPrompt).toContain('human-specific knowledge');
    });

    it('should fall back to general best practices when no factors enabled', () => {
      const noFactorsConfig: BaselineConfig = {
        factors: {
          projectContext: false,
          domainBestPractices: false,
          teamSize: false,
          existingStack: false,
        },
        confidenceThreshold: 50,
        requireReasoning: true,
      };

      promptBuilder.setConfig(noFactorsConfig);
      const systemPrompt = promptBuilder.buildSystemPrompt();

      expect(systemPrompt).toContain('General best practices');
    });

    it('should include confidence scoring guidelines', () => {
      const systemPrompt = promptBuilder.buildSystemPrompt();

      expect(systemPrompt).toContain('Confidence Scoring');
      expect(systemPrompt).toContain('90-100');
      expect(systemPrompt).toContain('70-89');
      expect(systemPrompt).toContain('50-69');
      expect(systemPrompt).toContain('Below 50');
    });
  });

  describe('buildUserPrompt', () => {
    it('should include the decision description', () => {
      const request = createMinimalDecisionRequest();
      const userPrompt = promptBuilder.buildUserPrompt(request);

      expect(userPrompt).toContain('Choose a database for the application');
      expect(userPrompt).toContain('Decision Request');
    });

    it('should include all option names and IDs', () => {
      const request = createMinimalDecisionRequest();
      const userPrompt = promptBuilder.buildUserPrompt(request);

      expect(userPrompt).toContain('PostgreSQL');
      expect(userPrompt).toContain('opt-postgres');
      expect(userPrompt).toContain('MongoDB');
      expect(userPrompt).toContain('opt-mongo');
      expect(userPrompt).toContain('Available Options');
    });

    it('should include option pros and cons when present', () => {
      const request = createFullDecisionRequest();
      const userPrompt = promptBuilder.buildUserPrompt(request);

      // Check React pros
      expect(userPrompt).toContain('Large ecosystem');
      expect(userPrompt).toContain('Strong community support');
      expect(userPrompt).toContain('Flexible architecture');

      // Check React cons
      expect(userPrompt).toContain('Steep learning curve');
      expect(userPrompt).toContain('Requires additional libraries for state management');

      // Check Vue.js pros and cons
      expect(userPrompt).toContain('Gentle learning curve');
      expect(userPrompt).toContain('Smaller ecosystem than React');

      // Verify formatting
      expect(userPrompt).toContain('**Pros**');
      expect(userPrompt).toContain('**Cons**');
    });

    it('should include project context name', () => {
      const request = createFullDecisionRequest();
      const userPrompt = promptBuilder.buildUserPrompt(request);

      expect(userPrompt).toContain('E-Commerce Platform');
      expect(userPrompt).toContain('**Project Name**');
    });

    it('should include project context tech stack', () => {
      const request = createFullDecisionRequest();
      const userPrompt = promptBuilder.buildUserPrompt(request);

      expect(userPrompt).toContain('Node.js');
      expect(userPrompt).toContain('TypeScript');
      expect(userPrompt).toContain('PostgreSQL');
      expect(userPrompt).toContain('Redis');
      expect(userPrompt).toContain('**Technology Stack**');
    });

    it('should include project context team size', () => {
      const request = createFullDecisionRequest();
      const userPrompt = promptBuilder.buildUserPrompt(request);

      expect(userPrompt).toContain('8 members');
      expect(userPrompt).toContain('**Team Size**');
    });

    it('should include project context phase', () => {
      const request = createFullDecisionRequest();
      const userPrompt = promptBuilder.buildUserPrompt(request);

      expect(userPrompt).toContain('development');
      expect(userPrompt).toContain('**Project Phase**');
    });

    it('should include project context domain', () => {
      const request = createFullDecisionRequest();
      const userPrompt = promptBuilder.buildUserPrompt(request);

      expect(userPrompt).toContain('E-commerce');
      expect(userPrompt).toContain('**Business Domain**');
    });

    it('should include constraints deadline when present', () => {
      const request = createFullDecisionRequest();
      const userPrompt = promptBuilder.buildUserPrompt(request);

      expect(userPrompt).toContain('**Deadline**');
      expect(userPrompt).toContain('2024-06-30');
    });

    it('should include constraints budget when present', () => {
      const request = createFullDecisionRequest();
      const userPrompt = promptBuilder.buildUserPrompt(request);

      expect(userPrompt).toContain('**Budget**');
      expect(userPrompt).toContain('50000');
      expect(userPrompt).toContain('USD');
    });

    it('should include constraints required features when present', () => {
      const request = createFullDecisionRequest();
      const userPrompt = promptBuilder.buildUserPrompt(request);

      expect(userPrompt).toContain('**Required Features**');
      expect(userPrompt).toContain('Server-side rendering');
      expect(userPrompt).toContain('TypeScript support');
      expect(userPrompt).toContain('Internationalization');
    });

    it('should include constraints excluded technologies when present', () => {
      const request = createFullDecisionRequest();
      const userPrompt = promptBuilder.buildUserPrompt(request);

      expect(userPrompt).toContain('**Excluded Technologies**');
      expect(userPrompt).toContain('jQuery');
      expect(userPrompt).toContain('AngularJS');
    });

    it('should handle missing optional fields gracefully', () => {
      const request = createMinimalDecisionRequest();
      const userPrompt = promptBuilder.buildUserPrompt(request);

      // Should not throw and should still have required content
      expect(userPrompt).toContain('Test Project');
      expect(userPrompt).toContain('PostgreSQL');
      expect(userPrompt).toContain('MongoDB');

      // Should not contain optional fields
      expect(userPrompt).not.toContain('**Technology Stack**');
      expect(userPrompt).not.toContain('**Team Size**');
      expect(userPrompt).not.toContain('**Project Phase**');
      expect(userPrompt).not.toContain('**Business Domain**');
      expect(userPrompt).not.toContain('## Constraints');
    });

    it('should format the request for JSON response', () => {
      const request = createMinimalDecisionRequest();
      const userPrompt = promptBuilder.buildUserPrompt(request);

      expect(userPrompt).toContain('## Request');
      expect(userPrompt).toContain('JSON');
      expect(userPrompt).toContain('recommendation');
    });

    it('should include option descriptions', () => {
      const request = createMinimalDecisionRequest();
      const userPrompt = promptBuilder.buildUserPrompt(request);

      expect(userPrompt).toContain('Relational database with ACID compliance');
      expect(userPrompt).toContain('NoSQL document database');
    });

    it('should include option metadata when present', () => {
      const request = createFullDecisionRequest();
      const userPrompt = promptBuilder.buildUserPrompt(request);

      expect(userPrompt).toContain('Additional Metadata');
      expect(userPrompt).toContain('version');
      expect(userPrompt).toContain('18.2');
    });

    it('should include project description when present', () => {
      const request = createFullDecisionRequest();
      const userPrompt = promptBuilder.buildUserPrompt(request);

      expect(userPrompt).toContain('**Project Description**');
      expect(userPrompt).toContain('modern e-commerce platform for retail products');
    });

    it('should include additional context when present', () => {
      const request = createFullDecisionRequest();
      const userPrompt = promptBuilder.buildUserPrompt(request);

      expect(userPrompt).toContain('**Additional Context**');
      expect(userPrompt).toContain('targetUsers');
      expect(userPrompt).toContain('B2C customers');
      expect(userPrompt).toContain('scalabilityRequirement');
      expect(userPrompt).toContain('High');
    });

    it('should include the request ID', () => {
      const request = createMinimalDecisionRequest();
      const userPrompt = promptBuilder.buildUserPrompt(request);

      expect(userPrompt).toContain('req-001');
      expect(userPrompt).toContain('**Request ID**');
    });

    it('should handle options without pros and cons', () => {
      const request: DecisionRequest = {
        id: 'req-003',
        description: 'Choose a cloud provider',
        options: [
          {
            id: 'opt-aws',
            name: 'AWS',
            description: 'Amazon Web Services',
          },
          {
            id: 'opt-gcp',
            name: 'GCP',
            description: 'Google Cloud Platform',
          },
        ],
        context: {
          name: 'Cloud Migration Project',
        },
        requestedAt: new Date(),
      };

      const userPrompt = promptBuilder.buildUserPrompt(request);

      expect(userPrompt).toContain('AWS');
      expect(userPrompt).toContain('GCP');
      expect(userPrompt).not.toContain('**Pros**');
      expect(userPrompt).not.toContain('**Cons**');
    });

    it('should handle constraints with only some fields present', () => {
      const request: DecisionRequest = {
        id: 'req-004',
        description: 'Choose a testing framework',
        options: [
          {
            id: 'opt-jest',
            name: 'Jest',
            description: 'JavaScript testing framework',
          },
        ],
        context: {
          name: 'Testing Project',
        },
        constraints: {
          requiredFeatures: ['Snapshot testing', 'Mocking'],
        },
        requestedAt: new Date(),
      };

      const userPrompt = promptBuilder.buildUserPrompt(request);

      expect(userPrompt).toContain('## Constraints');
      expect(userPrompt).toContain('**Required Features**');
      expect(userPrompt).toContain('Snapshot testing');
      expect(userPrompt).not.toContain('**Deadline**');
      expect(userPrompt).not.toContain('**Budget**');
      expect(userPrompt).not.toContain('**Excluded Technologies**');
    });

    it('should not include constraints section when all constraint fields are empty', () => {
      const request: DecisionRequest = {
        id: 'req-005',
        description: 'Choose a linter',
        options: [
          {
            id: 'opt-eslint',
            name: 'ESLint',
            description: 'JavaScript linter',
          },
        ],
        context: {
          name: 'Linting Project',
        },
        constraints: {}, // Empty constraints object
        requestedAt: new Date(),
      };

      const userPrompt = promptBuilder.buildUserPrompt(request);

      expect(userPrompt).not.toContain('## Constraints');
    });

    it('should handle empty arrays in constraints', () => {
      const request: DecisionRequest = {
        id: 'req-006',
        description: 'Choose an IDE',
        options: [
          {
            id: 'opt-vscode',
            name: 'VS Code',
            description: 'Visual Studio Code',
          },
        ],
        context: {
          name: 'IDE Selection',
        },
        constraints: {
          requiredFeatures: [],
          excludedTechnologies: [],
        },
        requestedAt: new Date(),
      };

      const userPrompt = promptBuilder.buildUserPrompt(request);

      // Empty arrays should not create constraint entries
      expect(userPrompt).not.toContain('## Constraints');
    });

    it('should handle empty tech stack array', () => {
      const request: DecisionRequest = {
        id: 'req-007',
        description: 'Choose a build tool',
        options: [
          {
            id: 'opt-webpack',
            name: 'Webpack',
            description: 'Module bundler',
          },
        ],
        context: {
          name: 'Build Tool Project',
          techStack: [],
        },
        requestedAt: new Date(),
      };

      const userPrompt = promptBuilder.buildUserPrompt(request);

      expect(userPrompt).not.toContain('**Technology Stack**');
    });

    it('should handle empty additional context', () => {
      const request: DecisionRequest = {
        id: 'req-008',
        description: 'Choose a package manager',
        options: [
          {
            id: 'opt-npm',
            name: 'npm',
            description: 'Node Package Manager',
          },
        ],
        context: {
          name: 'Package Manager Project',
          additionalContext: {},
        },
        requestedAt: new Date(),
      };

      const userPrompt = promptBuilder.buildUserPrompt(request);

      expect(userPrompt).not.toContain('**Additional Context**');
    });
  });
});
