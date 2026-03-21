/**
 * Organization API endpoints for Generacy cloud API.
 * Provides methods for fetching organization details, members, and usage.
 */
import { z } from 'zod';
import { getApiClient } from '../client';
import {
  OrganizationSchema,
  OrgMemberSchema,
  OrgUsageSchema,
  type Organization,
  type OrgMember,
  type OrgUsage,
  createPaginatedSchema,
} from '../types';

// ============================================================================
// Response Schemas
// ============================================================================

/**
 * Organization details with members response
 */
export interface OrganizationDetails extends Organization {
  /** Organization members */
  members: OrgMember[];
}

const OrganizationDetailsSchema = OrganizationSchema.extend({
  members: z.array(OrgMemberSchema),
});

/**
 * Organization billing information
 */
export interface OrgBilling {
  /** Current plan name */
  plan: string;
  /** Price per seat */
  pricePerSeat: number;
  /** Billing cycle (monthly/annual) */
  billingCycle: 'monthly' | 'annual';
  /** Next billing date */
  nextBillingDate: string;
  /** Current amount due */
  amountDue: number;
  /** Currency code */
  currency: string;
  /** Whether billing is active */
  isActive: boolean;
  /** Payment method summary (e.g., "Visa ending in 4242") */
  paymentMethod?: string;
}

const OrgBillingSchema = z.object({
  plan: z.string(),
  pricePerSeat: z.number().nonnegative(),
  billingCycle: z.enum(['monthly', 'annual']),
  nextBillingDate: z.string().datetime(),
  amountDue: z.number().nonnegative(),
  currency: z.string(),
  isActive: z.boolean(),
  paymentMethod: z.string().optional(),
});

/**
 * Combined organization dashboard data
 */
export interface OrgDashboardData {
  /** Organization details */
  organization: Organization;
  /** Organization members */
  members: OrgMember[];
  /** Usage metrics */
  usage: OrgUsage;
  /** Billing information */
  billing: OrgBilling;
}

const OrgDashboardDataSchema = z.object({
  organization: OrganizationSchema,
  members: z.array(OrgMemberSchema),
  usage: OrgUsageSchema,
  billing: OrgBillingSchema,
});

const PaginatedMembersSchema = createPaginatedSchema(OrgMemberSchema);

// ============================================================================
// API Functions
// ============================================================================

/**
 * Get organization details by ID
 */
export async function getOrganization(orgId: string): Promise<Organization> {
  const client = getApiClient();
  const response = await client.getValidated(`/orgs/${orgId}`, OrganizationSchema);
  return response.data;
}

/**
 * Get organization details with members
 */
export async function getOrganizationDetails(orgId: string): Promise<OrganizationDetails> {
  const client = getApiClient();
  const response = await client.getValidated(`/orgs/${orgId}/details`, OrganizationDetailsSchema);
  return response.data;
}

/**
 * Get organization members with pagination
 */
export async function getOrganizationMembers(
  orgId: string,
  options?: { page?: number; pageSize?: number }
): Promise<{ items: OrgMember[]; total: number; page: number; pageSize: number; hasMore: boolean }> {
  const client = getApiClient();
  const response = await client.getValidated(`/orgs/${orgId}/members`, PaginatedMembersSchema, {
    params: {
      page: options?.page,
      pageSize: options?.pageSize,
    },
  });
  return response.data;
}

/**
 * Get organization usage metrics
 */
export async function getOrganizationUsage(orgId: string): Promise<OrgUsage> {
  const client = getApiClient();
  const response = await client.getValidated(`/orgs/${orgId}/usage`, OrgUsageSchema);
  return response.data;
}

/**
 * Get organization billing information
 */
export async function getOrganizationBilling(orgId: string): Promise<OrgBilling> {
  const client = getApiClient();
  const response = await client.getValidated(`/orgs/${orgId}/billing`, OrgBillingSchema);
  return response.data;
}

/**
 * Get complete dashboard data in a single request
 */
export async function getOrganizationDashboard(orgId: string): Promise<OrgDashboardData> {
  const client = getApiClient();
  const response = await client.getValidated(`/orgs/${orgId}/dashboard`, OrgDashboardDataSchema);
  return response.data;
}

/**
 * Get tier limits for display
 */
export function getTierLimits(tier: Organization['tier']): {
  executionSlots: number;
  maxClusters: number;
  agentHoursPerMonth: number;
  features: string[];
} {
  switch (tier) {
    case 'starter':
      return {
        executionSlots: 3,
        maxClusters: 1,
        agentHoursPerMonth: 100,
        features: ['GitHub integration', 'Basic support'],
      };
    case 'team':
      return {
        executionSlots: 10,
        maxClusters: 3,
        agentHoursPerMonth: 500,
        features: ['All integrations', 'SSO', 'Priority support'],
      };
    case 'enterprise':
      return {
        executionSlots: -1, // Unlimited
        maxClusters: -1, // Unlimited
        agentHoursPerMonth: -1, // Unlimited
        features: ['All integrations', 'SSO', 'Dedicated support', 'SLA', 'Custom limits'],
      };
  }
}

/**
 * Get tier display name
 */
export function getTierDisplayName(tier: Organization['tier']): string {
  switch (tier) {
    case 'starter':
      return 'Starter';
    case 'team':
      return 'Team';
    case 'enterprise':
      return 'Enterprise';
  }
}

/**
 * Get tier pricing
 */
export function getTierPricing(tier: Organization['tier']): { price: number | null; description: string } {
  switch (tier) {
    case 'starter':
      return { price: 49, description: '$49/seat/month (min 3 seats)' };
    case 'team':
      return { price: 99, description: '$99/seat/month (min 5 seats)' };
    case 'enterprise':
      return { price: null, description: 'Contact sales for pricing' };
  }
}
