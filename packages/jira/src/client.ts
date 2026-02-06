import { Version3Client, AgileClient } from 'jira.js';
import type { JiraConfig, ValidatedJiraConfig } from './types/config.js';
import { validateConfig } from './utils/validation.js';
import {
  JiraAuthError,
  JiraRateLimitError,
  JiraConnectionError,
  wrapJiraError,
} from './utils/errors.js';

/**
 * Jira API client wrapper with authentication and error handling
 *
 * Uses the official jira.js SDK with Basic Auth (email + API token)
 */
export class JiraClient {
  private readonly v3Client: Version3Client;
  private readonly agileClient: AgileClient;
  private readonly config: ValidatedJiraConfig;

  constructor(config: JiraConfig) {
    this.config = validateConfig(config);

    const clientConfig = {
      host: this.config.host,
      authentication: {
        basic: {
          email: this.config.email,
          apiToken: this.config.apiToken,
        },
      },
      ...(this.config.timeout && { timeout: this.config.timeout }),
    };

    this.v3Client = new Version3Client(clientConfig);
    this.agileClient = new AgileClient(clientConfig);
  }

  /**
   * Access to the Version3 API client
   */
  get v3(): Version3Client {
    return this.v3Client;
  }

  /**
   * Access to the Agile API client (for sprints, boards, etc.)
   */
  get agile(): AgileClient {
    return this.agileClient;
  }

  /**
   * Get the host from config
   */
  get host(): string {
    return this.config.host;
  }

  /**
   * Get the default project key from config
   */
  get projectKey(): string | undefined {
    return this.config.projectKey;
  }

  /**
   * Get issue type mapping from config
   */
  get issueTypeMapping(): NonNullable<ValidatedJiraConfig['issueTypeMapping']> | undefined {
    return this.config.issueTypeMapping;
  }

  /**
   * Get workflow mapping from config
   */
  get workflowMapping(): ValidatedJiraConfig['workflowMapping'] {
    return this.config.workflowMapping;
  }

  /**
   * Get webhook secret from config
   */
  get webhookSecret(): string | undefined {
    return this.config.webhookSecret;
  }

  /**
   * Verify authentication by fetching the current user
   */
  async verifyAuth(): Promise<{ accountId: string; displayName: string; email: string }> {
    try {
      const user = await this.v3Client.myself.getCurrentUser();
      return {
        accountId: user.accountId ?? '',
        displayName: user.displayName ?? '',
        email: user.emailAddress ?? '',
      };
    } catch (error) {
      throw new JiraAuthError('Failed to verify Jira authentication', error);
    }
  }

  /**
   * Check connectivity by fetching server info
   */
  async checkConnection(): Promise<{ version: string; baseUrl: string }> {
    try {
      const info = await this.v3Client.serverInfo.getServerInfo();
      return {
        version: info.version ?? 'unknown',
        baseUrl: info.baseUrl ?? this.config.host,
      };
    } catch (error) {
      if (error instanceof Error && (error.message.includes('ECONNREFUSED') || error.message.includes('ETIMEDOUT'))) {
        throw new JiraConnectionError(`Failed to connect to Jira at ${this.config.host}`, error);
      }
      throw wrapJiraError(error, 'Failed to check connection');
    }
  }

  /**
   * Execute a request with error handling and automatic retries
   */
  async request<T>(
    operation: () => Promise<T>,
    context?: string
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      // Check for rate limit error (Jira uses 429)
      if (
        typeof error === 'object' &&
        error !== null &&
        'status' in error &&
        (error as Record<string, unknown>).status === 429
      ) {
        const headers = (error as Record<string, unknown>).headers as Record<string, string> | undefined;
        const retryAfter = headers?.['retry-after'];
        const resetAt = retryAfter ? new Date(Date.now() + parseInt(retryAfter, 10) * 1000) : undefined;
        throw new JiraRateLimitError(
          `Rate limit exceeded${context ? ` for ${context}` : ''}`,
          resetAt,
          error
        );
      }

      throw wrapJiraError(error, context);
    }
  }

  /**
   * Paginate through results using an async generator
   */
  async *paginate<T>(
    fetchPage: (startAt: number, maxResults: number) => Promise<{ values?: T[]; total?: number; startAt?: number; maxResults?: number }>,
    options: { pageSize?: number; maxPages?: number } = {}
  ): AsyncGenerator<T> {
    const pageSize = options.pageSize ?? 50;
    const maxPages = options.maxPages ?? 100;
    let startAt = 0;
    let page = 0;

    while (page < maxPages) {
      const response = await fetchPage(startAt, pageSize);
      const values = response.values ?? [];

      for (const item of values) {
        yield item;
      }

      // Check if we've fetched all items
      const total = response.total ?? 0;
      startAt += values.length;

      if (values.length < pageSize || startAt >= total) {
        break;
      }

      page++;
    }
  }
}

/**
 * Create a new Jira client instance
 */
export function createClient(config: JiraConfig): JiraClient {
  return new JiraClient(config);
}

/**
 * Create a new Jira client and verify authentication
 */
export async function createClientAsync(config: JiraConfig): Promise<JiraClient> {
  const client = new JiraClient(config);
  await client.verifyAuth();
  return client;
}
