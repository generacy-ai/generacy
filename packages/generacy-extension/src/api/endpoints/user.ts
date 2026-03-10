/**
 * User profile API endpoints for Generacy cloud API.
 * Provides methods for fetching the authenticated user's profile and organization memberships.
 */
import { z } from 'zod';
import { getApiClient } from '../client';

// ============================================================================
// Types
// ============================================================================

/**
 * Organization membership in user profile
 */
export interface UserOrg {
  /** Organization ID */
  id: string;
  /** Organization name */
  name: string;
  /** User's role in the organization */
  role: 'owner' | 'admin' | 'member';
}

/**
 * User profile returned by GET /users/me
 */
export interface UserProfile {
  /** Unique user ID */
  id: string;
  /** Username (login handle) */
  username: string;
  /** Display name */
  displayName: string;
  /** Email address */
  email: string;
  /** Avatar URL */
  avatarUrl?: string;
  /** Account tier */
  tier: string;
  /** Organization memberships */
  organizations: UserOrg[];
}

// ============================================================================
// Schemas
// ============================================================================

/**
 * Zod schema for organization membership
 */
export const UserOrgSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: z.enum(['owner', 'admin', 'member']),
});

/**
 * Zod schema for user profile
 */
export const UserProfileSchema = z.object({
  id: z.string(),
  username: z.string(),
  displayName: z.string(),
  email: z.string().email(),
  avatarUrl: z.string().url().optional(),
  tier: z.string(),
  organizations: z.array(UserOrgSchema),
});

// ============================================================================
// API Methods
// ============================================================================

/**
 * User API methods
 */
export const userApi = {
  /**
   * Get the authenticated user's profile and organization memberships.
   * Requires a valid access token.
   */
  async getProfile(): Promise<UserProfile> {
    const client = getApiClient();
    const response = await client.getValidated('/users/me', UserProfileSchema);
    return response.data;
  },
};

/**
 * Get the user API instance
 */
export function getUserApi(): typeof userApi {
  return userApi;
}
