import { describe, it, expect, beforeEach } from 'vitest';
import {
  AgentRegistry,
  AgentExistsError,
  AgentNotFoundError,
  DefaultAgentNotConfiguredError,
  AgentFeature,
  type AgentInvoker,
  type InvocationConfig,
  type InvocationResult,
} from '../../src/agents/index.js';

/** Create a mock agent invoker for testing */
function createMockAgent(name: string): AgentInvoker {
  return {
    name,
    supports: (_feature: AgentFeature) => true,
    isAvailable: async () => true,
    initialize: async () => {},
    invoke: async (_config: InvocationConfig): Promise<InvocationResult> => ({
      success: true,
      output: 'mock output',
      duration: 100,
    }),
    shutdown: async () => {},
  };
}

describe('AgentRegistry', () => {
  let registry: AgentRegistry;

  beforeEach(() => {
    registry = new AgentRegistry();
  });

  describe('register', () => {
    it('registers an agent invoker', () => {
      const agent = createMockAgent('test-agent');
      registry.register(agent);

      expect(registry.get('test-agent')).toBe(agent);
    });

    it('throws AgentExistsError on duplicate registration', () => {
      const agent1 = createMockAgent('test-agent');
      const agent2 = createMockAgent('test-agent');

      registry.register(agent1);
      expect(() => registry.register(agent2)).toThrow(AgentExistsError);
    });
  });

  describe('unregister', () => {
    it('unregisters an agent invoker', () => {
      const agent = createMockAgent('test-agent');
      registry.register(agent);
      registry.unregister('test-agent');

      expect(registry.get('test-agent')).toBeUndefined();
    });

    it('does not throw when unregistering non-existent agent', () => {
      // Unregister is idempotent - no error for missing agents
      expect(() => registry.unregister('non-existent')).not.toThrow();
    });
  });

  describe('get', () => {
    it('returns agent by name when found', () => {
      const agent = createMockAgent('test-agent');
      registry.register(agent);

      expect(registry.get('test-agent')).toBe(agent);
    });

    it('returns undefined for non-existent agent', () => {
      expect(registry.get('non-existent')).toBeUndefined();
    });
  });

  describe('list', () => {
    it('returns all registered agents', () => {
      const agent1 = createMockAgent('agent-1');
      const agent2 = createMockAgent('agent-2');
      const agent3 = createMockAgent('agent-3');

      registry.register(agent1);
      registry.register(agent2);
      registry.register(agent3);

      const agents = registry.list();
      expect(agents).toHaveLength(3);
      expect(agents).toContain(agent1);
      expect(agents).toContain(agent2);
      expect(agents).toContain(agent3);
    });

    it('returns empty array when no agents registered', () => {
      expect(registry.list()).toEqual([]);
    });
  });

  describe('setDefault', () => {
    it('sets the default agent by name', () => {
      const agent = createMockAgent('test-agent');
      registry.register(agent);
      registry.setDefault('test-agent');

      expect(registry.getDefault()).toBe(agent);
    });

    it('throws AgentNotFoundError when setting default to non-existent agent', () => {
      expect(() => registry.setDefault('non-existent')).toThrow(AgentNotFoundError);
    });
  });

  describe('getDefault', () => {
    it('returns the default agent', () => {
      const agent = createMockAgent('test-agent');
      registry.register(agent);
      registry.setDefault('test-agent');

      expect(registry.getDefault()).toBe(agent);
    });

    it('throws DefaultAgentNotConfiguredError when default not set', () => {
      expect(() => registry.getDefault()).toThrow(DefaultAgentNotConfiguredError);
    });

    it('throws AgentNotFoundError if default agent was unregistered', () => {
      const agent = createMockAgent('test-agent');
      registry.register(agent);
      registry.setDefault('test-agent');
      registry.unregister('test-agent');

      // Default is still set to 'test-agent' but agent is gone
      expect(() => registry.getDefault()).toThrow(AgentNotFoundError);
    });
  });

  describe('multiple agents', () => {
    it('maintains separate registrations', () => {
      const claude = createMockAgent('claude-code');
      const copilot = createMockAgent('copilot');

      registry.register(claude);
      registry.register(copilot);
      registry.setDefault('claude-code');

      expect(registry.get('claude-code')).toBe(claude);
      expect(registry.get('copilot')).toBe(copilot);
      expect(registry.getDefault()).toBe(claude);
      expect(registry.list()).toHaveLength(2);
    });
  });
});
