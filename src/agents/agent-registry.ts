/**
 * Agent registry for managing agent invokers.
 *
 * Implements the registry pattern for registering, retrieving,
 * and managing AI coding agent invokers.
 */

import type { AgentInvoker } from './types.js';
import {
  AgentExistsError,
  AgentNotFoundError,
  DefaultAgentNotConfiguredError,
} from './errors.js';

/**
 * Registry for managing agent invokers.
 *
 * Provides methods to register, unregister, and retrieve agent invokers.
 * Also manages default agent configuration.
 */
export class AgentRegistry {
  /** Map of agent name to invoker */
  private agents = new Map<string, AgentInvoker>();

  /** Name of the default agent */
  private defaultAgentName?: string;

  /**
   * Register an agent invoker.
   * @param invoker The agent invoker to register
   * @throws AgentExistsError if an agent with the same name already exists
   */
  register(invoker: AgentInvoker): void {
    if (this.agents.has(invoker.name)) {
      throw new AgentExistsError(invoker.name);
    }
    this.agents.set(invoker.name, invoker);
  }

  /**
   * Unregister an agent invoker.
   * @param name The name of the agent to unregister
   */
  unregister(name: string): void {
    this.agents.delete(name);
  }

  /**
   * Get an agent invoker by name.
   * @param name The name of the agent
   * @returns The agent invoker or undefined if not found
   */
  get(name: string): AgentInvoker | undefined {
    return this.agents.get(name);
  }

  /**
   * List all registered agent invokers.
   * @returns Array of all registered agent invokers
   */
  list(): AgentInvoker[] {
    return Array.from(this.agents.values());
  }

  /**
   * Set the default agent by name.
   * @param name The name of the agent to set as default
   * @throws AgentNotFoundError if the agent is not registered
   */
  setDefault(name: string): void {
    if (!this.agents.has(name)) {
      throw new AgentNotFoundError(name);
    }
    this.defaultAgentName = name;
  }

  /**
   * Get the default agent invoker.
   * @returns The default agent invoker
   * @throws DefaultAgentNotConfiguredError if no default is configured
   * @throws AgentNotFoundError if the default agent was unregistered
   */
  getDefault(): AgentInvoker {
    if (!this.defaultAgentName) {
      throw new DefaultAgentNotConfiguredError();
    }

    const agent = this.agents.get(this.defaultAgentName);
    if (!agent) {
      throw new AgentNotFoundError(this.defaultAgentName);
    }

    return agent;
  }
}
