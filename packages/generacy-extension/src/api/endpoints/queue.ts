/**
 * Queue API endpoints for Generacy cloud API.
 * Provides methods for fetching and managing workflow queue items.
 */
import { getApiClient } from '../client';
import {
  JobProgress,
  JobProgressSchema,
  QueueItem,
  QueueListResponse,
  QueueListResponseSchema,
  QueueItemSchema,
  QueueStatus,
  SuccessResponse,
  SuccessResponseSchema,
} from '../types';

/**
 * Queue filter options
 */
export interface QueueFilterOptions {
  /** Filter by status */
  status?: QueueStatus | QueueStatus[];
  /** Filter by repository (owner/repo format) */
  repository?: string;
  /** Filter by assignee user ID */
  assigneeId?: string;
  /** Page number (1-indexed) */
  page?: number;
  /** Items per page */
  pageSize?: number;
}

/**
 * Queue API methods
 */
export const queueApi = {
  /**
   * Get the workflow queue with optional filters
   */
  async getQueue(filters?: QueueFilterOptions): Promise<QueueListResponse> {
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

    if (filters?.repository) {
      params.repository = filters.repository;
    }

    if (filters?.assigneeId) {
      params.assigneeId = filters.assigneeId;
    }

    const response = await client.getValidated('/queue', QueueListResponseSchema, {
      params,
    });

    return response.data;
  },

  /**
   * Get a single queue item by ID
   */
  async getQueueItem(id: string): Promise<QueueItem> {
    const client = getApiClient();
    const response = await client.getValidated(`/queue/${id}`, QueueItemSchema);
    return response.data;
  },

  /**
   * Cancel a queued workflow
   */
  async cancelQueueItem(id: string): Promise<SuccessResponse> {
    const client = getApiClient();
    const response = await client.postValidated(`/queue/${id}/cancel`, SuccessResponseSchema);
    return response.data;
  },

  /**
   * Retry a failed workflow
   */
  async retryQueueItem(id: string): Promise<QueueItem> {
    const client = getApiClient();
    const response = await client.postValidated(`/queue/${id}/retry`, QueueItemSchema);
    return response.data;
  },

  /**
   * Get detailed progress for a job (phase/step breakdown)
   */
  async getJobProgress(id: string): Promise<JobProgress> {
    const client = getApiClient();
    const response = await client.getValidated(`/queue/${id}/progress`, JobProgressSchema);
    return response.data;
  },

  /**
   * Update queue item priority
   */
  async updatePriority(
    id: string,
    priority: 'low' | 'normal' | 'high' | 'urgent'
  ): Promise<QueueItem> {
    const client = getApiClient();
    const response = await client.patchValidated(`/queue/${id}`, QueueItemSchema, { priority });
    return response.data;
  },
};

/**
 * Get the queue API instance
 */
export function getQueueApi(): typeof queueApi {
  return queueApi;
}
