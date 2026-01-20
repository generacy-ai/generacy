import type {
  ConnectedAgent,
  AgentConnectionStatus,
  AgentType,
} from '../types/index.js';

/**
 * Agent registration data
 */
export interface AgentRegistration {
  id: string;
  name: string;
  type: AgentType;
  capabilities: string[];
  metadata?: {
    version?: string;
    platform?: string;
  };
}

/**
 * Agent registry - tracks connected agents
 */
export class AgentRegistry {
  private agents: Map<string, ConnectedAgent> = new Map();
  private readonly heartbeatTimeout: number;

  constructor(options: { heartbeatTimeout?: number } = {}) {
    this.heartbeatTimeout = options.heartbeatTimeout ?? 30000; // 30 seconds
  }

  /**
   * Register a new agent
   */
  register(registration: AgentRegistration): ConnectedAgent {
    const agent: ConnectedAgent = {
      id: registration.id,
      name: registration.name,
      type: registration.type,
      status: 'connected',
      capabilities: registration.capabilities,
      lastSeen: new Date().toISOString(),
      metadata: {
        version: registration.metadata?.version,
        platform: registration.metadata?.platform,
      },
    };

    this.agents.set(registration.id, agent);
    return agent;
  }

  /**
   * Unregister an agent
   */
  unregister(id: string): boolean {
    return this.agents.delete(id);
  }

  /**
   * Update agent heartbeat
   */
  heartbeat(id: string): boolean {
    const agent = this.agents.get(id);
    if (!agent) {
      return false;
    }

    agent.lastSeen = new Date().toISOString();
    if (agent.status === 'disconnected') {
      agent.status = 'connected';
    }

    return true;
  }

  /**
   * Update agent status
   */
  updateStatus(id: string, status: AgentConnectionStatus): boolean {
    const agent = this.agents.get(id);
    if (!agent) {
      return false;
    }

    agent.status = status;
    agent.lastSeen = new Date().toISOString();
    return true;
  }

  /**
   * Associate agent with a workflow
   */
  assignWorkflow(id: string, workflowId: string): boolean {
    const agent = this.agents.get(id);
    if (!agent) {
      return false;
    }

    agent.metadata.workflowId = workflowId;
    agent.status = 'busy';
    agent.lastSeen = new Date().toISOString();
    return true;
  }

  /**
   * Release agent from workflow
   */
  releaseWorkflow(id: string): boolean {
    const agent = this.agents.get(id);
    if (!agent) {
      return false;
    }

    agent.metadata.workflowId = undefined;
    agent.status = 'idle';
    agent.lastSeen = new Date().toISOString();
    return true;
  }

  /**
   * Get agent by ID
   */
  get(id: string): ConnectedAgent | undefined {
    return this.agents.get(id);
  }

  /**
   * List all connected agents
   */
  list(): ConnectedAgent[] {
    return Array.from(this.agents.values());
  }

  /**
   * List agents by status
   */
  listByStatus(status: AgentConnectionStatus): ConnectedAgent[] {
    return this.list().filter((agent) => agent.status === status);
  }

  /**
   * List agents by type
   */
  listByType(type: AgentType): ConnectedAgent[] {
    return this.list().filter((agent) => agent.type === type);
  }

  /**
   * List available agents (connected and idle)
   */
  listAvailable(): ConnectedAgent[] {
    return this.list().filter(
      (agent) => agent.status === 'connected' || agent.status === 'idle'
    );
  }

  /**
   * Check for stale agents and mark them as disconnected
   */
  checkHeartbeats(): string[] {
    const now = Date.now();
    const staleIds: string[] = [];

    for (const agent of this.agents.values()) {
      const lastSeen = new Date(agent.lastSeen).getTime();
      if (now - lastSeen > this.heartbeatTimeout && agent.status !== 'disconnected') {
        agent.status = 'disconnected';
        staleIds.push(agent.id);
      }
    }

    return staleIds;
  }

  /**
   * Remove disconnected agents
   */
  pruneDisconnected(): number {
    let removed = 0;
    for (const [id, agent] of this.agents) {
      if (agent.status === 'disconnected') {
        this.agents.delete(id);
        removed++;
      }
    }
    return removed;
  }

  /**
   * Get count of agents by status
   */
  getStats(): Record<AgentConnectionStatus, number> {
    const stats: Record<AgentConnectionStatus, number> = {
      connected: 0,
      idle: 0,
      busy: 0,
      disconnected: 0,
    };

    for (const agent of this.agents.values()) {
      stats[agent.status]++;
    }

    return stats;
  }

  /**
   * Clear all agents (for testing)
   */
  clear(): void {
    this.agents.clear();
  }

  /**
   * Get total agent count
   */
  size(): number {
    return this.agents.size;
  }
}
