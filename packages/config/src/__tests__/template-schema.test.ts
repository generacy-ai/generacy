import { describe, expect, it } from 'vitest';
import {
  AgentEntrySchema,
  AgentsConfigSchema,
  EffortSchema,
  OrchestratorSettingsSchema,
  TemplateConfigSchema,
  WorkflowAgentEntriesSchema,
} from '../template-schema.js';

describe('TemplateConfigSchema', () => {
  const validFullConfig = {
    project: { org_name: 'generacy-ai' },
    repos: {
      primary: 'generacy',
      dev: ['tetrad-development'],
      clone: ['contracts'],
    },
  };

  it('accepts a valid full config with project and repos', () => {
    const result = TemplateConfigSchema.parse(validFullConfig);
    expect(result).toEqual(validFullConfig);
  });

  it('accepts a minimal config with repos.primary only', () => {
    const result = TemplateConfigSchema.parse({
      repos: { primary: 'generacy' },
    });
    expect(result.repos.primary).toBe('generacy');
  });

  it('defaults dev to empty array when omitted', () => {
    const result = TemplateConfigSchema.parse({
      repos: { primary: 'generacy' },
    });
    expect(result.repos.dev).toEqual([]);
  });

  it('defaults clone to empty array when omitted', () => {
    const result = TemplateConfigSchema.parse({
      repos: { primary: 'generacy' },
    });
    expect(result.repos.clone).toEqual([]);
  });

  it('project.org_name is optional', () => {
    const result = TemplateConfigSchema.parse({
      project: {},
      repos: { primary: 'generacy' },
    });
    expect(result.project).toEqual({});
    expect(result.project?.org_name).toBeUndefined();
  });

  it('project with extra fields passes through', () => {
    const result = TemplateConfigSchema.parse({
      project: { org_name: 'generacy-ai', description: 'A cool project', version: 2 },
      repos: { primary: 'generacy' },
    });
    expect(result.project).toEqual({
      org_name: 'generacy-ai',
      description: 'A cool project',
      version: 2,
    });
  });

  it('rejects missing repos', () => {
    expect(() =>
      TemplateConfigSchema.parse({ project: { org_name: 'generacy-ai' } }),
    ).toThrow();
  });

  it('rejects empty repos.primary', () => {
    expect(() =>
      TemplateConfigSchema.parse({ repos: { primary: '' } }),
    ).toThrow();
  });

  it('coerces null dev to empty array', () => {
    const result = TemplateConfigSchema.parse({
      repos: { primary: 'generacy', dev: null },
    });
    expect(result.repos.dev).toEqual([]);
  });

  it('coerces null clone to empty array', () => {
    const result = TemplateConfigSchema.parse({
      repos: { primary: 'generacy', clone: null },
    });
    expect(result.repos.clone).toEqual([]);
  });

  it('rejects repos.dev with empty string', () => {
    expect(() =>
      TemplateConfigSchema.parse({ repos: { primary: 'generacy', dev: [''] } }),
    ).toThrow();
  });

  it('rejects repos.clone with empty string', () => {
    expect(() =>
      TemplateConfigSchema.parse({ repos: { primary: 'generacy', clone: [''] } }),
    ).toThrow();
  });

  it('accepts a top-level branch', () => {
    const result = TemplateConfigSchema.parse({
      branch: 'main',
      repos: { primary: 'generacy' },
    });
    expect(result.branch).toBe('main');
  });

  it('leaves branch undefined when omitted', () => {
    const result = TemplateConfigSchema.parse({ repos: { primary: 'generacy' } });
    expect(result.branch).toBeUndefined();
  });

  it('rejects empty branch', () => {
    expect(() =>
      TemplateConfigSchema.parse({ branch: '', repos: { primary: 'generacy' } }),
    ).toThrow();
  });
});

describe('OrchestratorSettingsSchema', () => {
  it('accepts a valid block with all three fields', () => {
    const result = OrchestratorSettingsSchema.parse({
      labelMonitor: true,
      webhookSetup: false,
      smeeChannelUrl: 'https://smee.io/abc123',
    });
    expect(result).toEqual({ labelMonitor: true, webhookSetup: false, smeeChannelUrl: 'https://smee.io/abc123' });
  });

  it('accepts a partial block with only labelMonitor', () => {
    const result = OrchestratorSettingsSchema.parse({ labelMonitor: true });
    expect(result.labelMonitor).toBe(true);
    expect(result.webhookSetup).toBeUndefined();
    expect(result.smeeChannelUrl).toBeUndefined();
  });

  it('accepts a partial block with only webhookSetup', () => {
    const result = OrchestratorSettingsSchema.parse({ webhookSetup: true });
    expect(result.webhookSetup).toBe(true);
  });

  it('accepts a partial block with only smeeChannelUrl', () => {
    const result = OrchestratorSettingsSchema.parse({ smeeChannelUrl: 'https://smee.io/xyz' });
    expect(result.smeeChannelUrl).toBe('https://smee.io/xyz');
  });

  it('rejects an invalid smeeChannelUrl (non-URL string)', () => {
    expect(() =>
      OrchestratorSettingsSchema.parse({ smeeChannelUrl: 'not-a-url' }),
    ).toThrow();
  });

  it('TemplateConfigSchema parses orchestrator block when present', () => {
    const result = TemplateConfigSchema.parse({
      repos: { primary: 'generacy' },
      orchestrator: { labelMonitor: true, smeeChannelUrl: 'https://smee.io/abc' },
    });
    expect(result.orchestrator?.labelMonitor).toBe(true);
    expect(result.orchestrator?.smeeChannelUrl).toBe('https://smee.io/abc');
  });

  it('TemplateConfigSchema accepts missing orchestrator key', () => {
    const result = TemplateConfigSchema.parse({ repos: { primary: 'generacy' } });
    expect(result.orchestrator).toBeUndefined();
  });
});

describe('EffortSchema + AgentEntrySchema (issue #1095)', () => {
  it('EffortSchema accepts all five vocabulary values', () => {
    expect(EffortSchema.parse('low')).toBe('low');
    expect(EffortSchema.parse('medium')).toBe('medium');
    expect(EffortSchema.parse('high')).toBe('high');
    expect(EffortSchema.parse('xhigh')).toBe('xhigh');
    expect(EffortSchema.parse('max')).toBe('max');
  });

  it('AgentEntrySchema accepts a valid entry with effort xhigh', () => {
    const result = AgentEntrySchema.parse({ provider: 'claude-code', model: 'fable', effort: 'xhigh' });
    expect(result).toEqual({ provider: 'claude-code', model: 'fable', effort: 'xhigh' });
  });

  it('AgentEntrySchema accepts an entry with only effort set', () => {
    const result = AgentEntrySchema.parse({ effort: 'high' });
    expect(result.effort).toBe('high');
    expect(result.provider).toBeUndefined();
    expect(result.model).toBeUndefined();
  });

  it('AgentEntrySchema rejects effort "super" with a message naming effort and the invalid value (SC-005)', () => {
    let caught: unknown;
    try {
      AgentEntrySchema.parse({ effort: 'super' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const msg = String((caught as Error).message);
    expect(msg).toContain('effort');
    expect(msg).toContain('super');
  });

  it('AgentEntrySchema rejects an unknown key inside an entry (efort:)', () => {
    let caught: unknown;
    try {
      AgentEntrySchema.parse({ efort: 'high' } as unknown as Record<string, unknown>);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(String((caught as Error).message)).toContain('efort');
  });
});

describe('AgentsConfigSchema strict mode (issue #1095, SC-006)', () => {
  it('accepts a well-formed agents block', () => {
    const result = AgentsConfigSchema.parse({
      default: { provider: 'claude-code', model: 'opus-4-7' },
      workflows: {
        'speckit-feature': {
          default: { model: 'opus-4-7' },
          phases: {
            plan: { model: 'fable', effort: 'xhigh' },
            implement: { model: 'opus-4-7', effort: 'high' },
          },
        },
      },
    });
    expect(result.workflows?.['speckit-feature']?.phases?.plan?.effort).toBe('xhigh');
    expect(result.workflows?.['speckit-feature']?.phases?.implement?.effort).toBe('high');
  });

  it('rejects an unknown top-level key (defualt:) under agents:', () => {
    let caught: unknown;
    try {
      AgentsConfigSchema.parse({ defualt: { model: 'opus' } } as unknown as Record<string, unknown>);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(String((caught as Error).message)).toContain('defualt');
  });

  it('rejects an unknown phase key (implment:) inside phases', () => {
    let caught: unknown;
    try {
      WorkflowAgentEntriesSchema.parse({
        phases: { implment: { model: 'opus' } } as unknown as Record<string, unknown>,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(String((caught as Error).message)).toContain('implment');
  });
});
