/**
 * Agents API endpoints for Generacy cloud API.
 * Provides methods for fetching agent status, stats, logs, and managing assignments.
 */
import { getApiClient } from '../client';
import {
  Agent,
  AgentConnectionStatus,
  AgentListResponse,
  AgentListResponseSchema,
  AgentSchema,
  AgentStats,
  AgentStatsSchema,
  AgentLogsResponse,
  AgentLogsResponseSchema,
  SuccessResponse,
  SuccessResponseSchema,
} from '../types';

/**
 * Agent filter options
 */
export interface AgentFilterOptions {
  /** Filter by connection status */
  status?: AgentConnectionStatus | AgentConnectionStatus[];
  /** Page number (1-indexed) */
  page?: number;
  /** Items per page */
  pageSize?: number;
}

/**
 * Agent logs filter options
 */
export interface AgentLogsOptions {
  /** Number of log lines to fetch */
  limit?: number;
  /** Offset from the start */
  offset?: number;
}

/**
 * Agents API methods
 */
export const agentsApi = {
  /**
   * Get all agents with optional filters
   */
  async getAgents(filters?: AgentFilterOptions): Promise<AgentListResponse> {
    const client = getApiClient();

    const params: Record<string, string | number | boolean | undefined> = {
      page: filters?.page ?? 1,
      pageSize: filters?.pageSize ?? 50,
    };

    // Handle status filter (can be single or array)
    if (filters?.status) {
      if (Array.isArray(filters.status)) {
        params.status = filters.status.join(',');
      } else {
        params.status = filters.status;
      }
    }

    const response = await client.getValidated('/agents', AgentListResponseSchema, {
      params,
    });

    return response.data;
  },

  /**
   * Get a single agent by ID
   */
  async getAgent(id: string): Promise<Agent> {
    const client = getApiClient();
    const response = await client.getValidated(`/agents/${id}`, AgentSchema);
    return response.data;
  },

  /**
   * Get agent pool statistics
   */
  async getAgentStats(): Promise<AgentStats> {
    const client = getApiClient();
    const response = await client.getValidated('/agents/stats', AgentStatsSchema);
    return response.data;
  },

  /**
   * Get agent logs
   */
  async getAgentLogs(id: string, options?: AgentLogsOptions): Promise<AgentLogsResponse> {
    const client = getApiClient();

    const params: Record<string, string | number | boolean | undefined> = {
      limit: options?.limit ?? 200,
      offset: options?.offset ?? 0,
    };

    const response = await client.getValidated(`/agents/${id}/logs`, AgentLogsResponseSchema, {
      params,
    });

    return response.data;
  },

  /**
   * Assign a work item to an agent
   */
  async assignWorkItem(queueItemId: string, agentId: string): Promise<SuccessResponse> {
    const client = getApiClient();
    const response = await client.postValidated(
      `/queue/${queueItemId}/assign`,
      SuccessResponseSchema,
      { agentId }
    );
    return response.data;
  },
};

/**
 * Get the agents API instance
 */
export function getAgentsApi(): typeof agentsApi {
  return agentsApi;
}
