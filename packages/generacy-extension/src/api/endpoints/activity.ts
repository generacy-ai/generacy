/**
 * Activity API endpoints for Generacy cloud API.
 * Provides methods for fetching the orchestration activity feed.
 */
import { getApiClient } from '../client';
import {
  ActivityEventType,
  ActivityListResponse,
  ActivityListResponseSchema,
} from '../types';

/**
 * Activity feed filter options
 */
export interface ActivityFilterOptions {
  /** Filter by event type */
  type?: ActivityEventType | ActivityEventType[];
  /** Maximum number of events to return (default: 50) */
  limit?: number;
  /** Offset for pagination */
  offset?: number;
  /** Page number (1-indexed) */
  page?: number;
  /** Items per page */
  pageSize?: number;
}

/**
 * Activity API methods
 */
export const activityApi = {
  /**
   * Get the activity feed with optional filters
   */
  async getActivity(filters?: ActivityFilterOptions): Promise<ActivityListResponse> {
    const client = getApiClient();

    const params: Record<string, string | number | boolean | undefined> = {
      page: filters?.page ?? 1,
      pageSize: filters?.pageSize ?? 50,
    };

    if (filters?.limit !== undefined) {
      params.limit = filters.limit;
    }

    if (filters?.offset !== undefined) {
      params.offset = filters.offset;
    }

    // Handle type filter (can be single or array)
    if (filters?.type) {
      if (Array.isArray(filters.type)) {
        params.type = filters.type.join(',');
      } else {
        params.type = filters.type;
      }
    }

    const response = await client.getValidated('/activity', ActivityListResponseSchema, {
      params,
    });

    return response.data;
  },
};

/**
 * Get the activity API instance
 */
export function getActivityApi(): typeof activityApi {
  return activityApi;
}
