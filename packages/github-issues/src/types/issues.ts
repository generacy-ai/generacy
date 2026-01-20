import { z } from 'zod';

/**
 * GitHub user representation
 */
export interface User {
  id: number;
  login: string;
  avatarUrl: string;
  type: 'User' | 'Bot' | 'Organization';
}

/**
 * Issue label
 */
export interface Label {
  id: number;
  name: string;
  color: string;
  description: string | null;
}

/**
 * Issue comment
 */
export interface Comment {
  id: number;
  body: string;
  author: User;
  createdAt: string;
  updatedAt: string;
  htmlUrl: string;
}

/**
 * Milestone
 */
export interface Milestone {
  id: number;
  number: number;
  title: string;
  description: string | null;
  state: 'open' | 'closed';
  dueOn: string | null;
}

/**
 * GitHub issue representation
 */
export interface Issue {
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  labels: Label[];
  assignees: User[];
  milestone: Milestone | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  author: User;
  url: string;
  htmlUrl: string;
}

/**
 * Pull request reference
 */
export interface PullRequest {
  number: number;
  title: string;
  state: 'open' | 'closed' | 'merged';
  author: User;
  htmlUrl: string;
  linkedIssues: number[];
}

/**
 * Parameters for creating an issue
 */
export interface CreateIssueParams {
  title: string;
  body?: string;
  labels?: string[];
  assignees?: string[];
  milestone?: number;
}

/**
 * Parameters for updating an issue
 */
export interface UpdateIssueParams {
  title?: string;
  body?: string;
  state?: 'open' | 'closed';
  labels?: string[];
  assignees?: string[];
  milestone?: number | null;
}

/**
 * Filter for listing issues
 */
export interface IssueFilter {
  state?: 'open' | 'closed' | 'all';
  labels?: string[];
  assignee?: string;
  creator?: string;
  mentioned?: string;
  milestone?: number | 'none' | '*';
  since?: string;
  sort?: 'created' | 'updated' | 'comments';
  direction?: 'asc' | 'desc';
}

// Zod schemas for validation

export const CreateIssueParamsSchema = z.object({
  title: z.string().min(1, 'Title is required').max(256, 'Title must be 256 characters or less'),
  body: z.string().max(65536, 'Body must be 65536 characters or less').optional(),
  labels: z.array(z.string()).optional(),
  assignees: z.array(z.string()).optional(),
  milestone: z.number().positive('Milestone must be positive').optional(),
});

export const UpdateIssueParamsSchema = z.object({
  title: z.string().min(1).max(256).optional(),
  body: z.string().max(65536).optional(),
  state: z.enum(['open', 'closed']).optional(),
  labels: z.array(z.string()).optional(),
  assignees: z.array(z.string()).optional(),
  milestone: z.number().positive().nullable().optional(),
});

export const IssueFilterSchema = z.object({
  state: z.enum(['open', 'closed', 'all']).optional(),
  labels: z.array(z.string()).optional(),
  assignee: z.string().optional(),
  creator: z.string().optional(),
  mentioned: z.string().optional(),
  milestone: z.union([z.number(), z.literal('none'), z.literal('*')]).optional(),
  since: z.string().datetime().optional(),
  sort: z.enum(['created', 'updated', 'comments']).optional(),
  direction: z.enum(['asc', 'desc']).optional(),
});
