/**
 * Integrations API endpoints for Generacy cloud API.
 * Provides methods for managing integration connections and configuration.
 */
import { z } from 'zod';
import { getApiClient } from '../client';
import {
  Integration,
  IntegrationSchema,
  IntegrationType,
  IntegrationStatus,
  SuccessResponse,
  SuccessResponseSchema,
} from '../types';

// ============================================================================
// Extended Types for Integrations API
// ============================================================================

/**
 * GitHub App installation details
 */
export interface GitHubInstallation {
  /** Installation ID */
  installationId: number;
  /** Account name (user or org) */
  accountName: string;
  /** Account type */
  accountType: 'User' | 'Organization';
  /** Connected repositories */
  repositories: GitHubRepository[];
  /** Permission scopes */
  permissions: string[];
  /** Installation URL for reconfiguration */
  configUrl: string;
}

/**
 * GitHub repository info
 */
export interface GitHubRepository {
  /** Repository ID */
  id: number;
  /** Full name (owner/repo) */
  fullName: string;
  /** Repository name */
  name: string;
  /** Is private */
  isPrivate: boolean;
}

/**
 * Integration with extended details
 */
export interface IntegrationDetails extends Integration {
  /** GitHub-specific installation details */
  github?: GitHubInstallation;
  /** Configuration options */
  config?: Record<string, unknown>;
}

/**
 * Webhook configuration
 */
export interface Webhook {
  /** Webhook ID */
  id: string;
  /** Webhook URL */
  url: string;
  /** Events subscribed to */
  events: string[];
  /** Is active */
  active: boolean;
  /** Last delivery status */
  lastDeliveryStatus?: 'success' | 'failure';
  /** Last delivery time */
  lastDeliveryAt?: string;
  /** Creation time */
  createdAt: string;
}

/**
 * Webhook creation request
 */
export interface CreateWebhookRequest {
  /** Webhook URL */
  url: string;
  /** Events to subscribe to */
  events: string[];
  /** Secret for payload signing */
  secret?: string;
}

// ============================================================================
// Zod Schemas
// ============================================================================

export const GitHubRepositorySchema = z.object({
  id: z.number(),
  fullName: z.string(),
  name: z.string(),
  isPrivate: z.boolean(),
});

export const GitHubInstallationSchema = z.object({
  installationId: z.number(),
  accountName: z.string(),
  accountType: z.enum(['User', 'Organization']),
  repositories: z.array(GitHubRepositorySchema),
  permissions: z.array(z.string()),
  configUrl: z.string().url(),
});

export const IntegrationDetailsSchema = IntegrationSchema.extend({
  github: GitHubInstallationSchema.optional(),
  config: z.record(z.unknown()).optional(),
});

export const WebhookSchema = z.object({
  id: z.string(),
  url: z.string().url(),
  events: z.array(z.string()),
  active: z.boolean(),
  lastDeliveryStatus: z.enum(['success', 'failure']).optional(),
  lastDeliveryAt: z.string().datetime().optional(),
  createdAt: z.string().datetime(),
});

export const IntegrationsListSchema = z.array(IntegrationSchema);
export const IntegrationDetailsResponseSchema = IntegrationDetailsSchema;
export const WebhooksListSchema = z.array(WebhookSchema);

// ============================================================================
// API Methods
// ============================================================================

/**
 * Integrations API methods
 */
export const integrationsApi = {
  /**
   * Get all integrations with their connection status
   */
  async getIntegrations(): Promise<Integration[]> {
    const client = getApiClient();
    const response = await client.getValidated('/integrations', IntegrationsListSchema);
    return response.data;
  },

  /**
   * Get detailed information about a specific integration
   */
  async getIntegrationDetails(type: IntegrationType): Promise<IntegrationDetails> {
    const client = getApiClient();
    const response = await client.getValidated(
      `/integrations/${type}`,
      IntegrationDetailsResponseSchema
    );
    return response.data;
  },

  /**
   * Get integration connection status
   */
  async getIntegrationStatus(type: IntegrationType): Promise<IntegrationStatus> {
    const client = getApiClient();
    const response = await client.getValidated(
      `/integrations/${type}/status`,
      z.object({ status: z.enum(['connected', 'disconnected', 'error']) })
    );
    return response.data.status;
  },

  /**
   * Initiate integration connection
   * Returns the authorization URL for OAuth-based integrations
   */
  async connectIntegration(type: IntegrationType): Promise<{ authUrl: string }> {
    const client = getApiClient();
    const response = await client.postValidated(
      `/integrations/${type}/connect`,
      z.object({ authUrl: z.string().url() })
    );
    return response.data;
  },

  /**
   * Disconnect an integration
   */
  async disconnectIntegration(type: IntegrationType): Promise<SuccessResponse> {
    const client = getApiClient();
    const response = await client.postValidated(
      `/integrations/${type}/disconnect`,
      SuccessResponseSchema
    );
    return response.data;
  },

  /**
   * Update integration configuration
   */
  async updateIntegrationConfig(
    type: IntegrationType,
    config: Record<string, unknown>
  ): Promise<IntegrationDetails> {
    const client = getApiClient();
    const response = await client.patchValidated(
      `/integrations/${type}/config`,
      IntegrationDetailsResponseSchema,
      config
    );
    return response.data;
  },

  /**
   * Get webhooks for an integration
   */
  async getWebhooks(type: IntegrationType): Promise<Webhook[]> {
    const client = getApiClient();
    const response = await client.getValidated(
      `/integrations/${type}/webhooks`,
      WebhooksListSchema
    );
    return response.data;
  },

  /**
   * Create a webhook
   */
  async createWebhook(type: IntegrationType, request: CreateWebhookRequest): Promise<Webhook> {
    const client = getApiClient();
    const response = await client.postValidated(
      `/integrations/${type}/webhooks`,
      WebhookSchema,
      request
    );
    return response.data;
  },

  /**
   * Delete a webhook
   */
  async deleteWebhook(type: IntegrationType, webhookId: string): Promise<SuccessResponse> {
    const client = getApiClient();
    const response = await client.deleteValidated(
      `/integrations/${type}/webhooks/${webhookId}`,
      SuccessResponseSchema
    );
    return response.data;
  },

  /**
   * Test a webhook by sending a test payload
   */
  async testWebhook(
    type: IntegrationType,
    webhookId: string
  ): Promise<{ success: boolean; statusCode?: number; error?: string }> {
    const client = getApiClient();
    const response = await client.postValidated(
      `/integrations/${type}/webhooks/${webhookId}/test`,
      z.object({
        success: z.boolean(),
        statusCode: z.number().optional(),
        error: z.string().optional(),
      })
    );
    return response.data;
  },

  /**
   * Toggle webhook active state
   */
  async toggleWebhook(type: IntegrationType, webhookId: string, active: boolean): Promise<Webhook> {
    const client = getApiClient();
    const response = await client.patchValidated(
      `/integrations/${type}/webhooks/${webhookId}`,
      WebhookSchema,
      { active }
    );
    return response.data;
  },
};

/**
 * Get the integrations API instance
 */
export function getIntegrationsApi(): typeof integrationsApi {
  return integrationsApi;
}
