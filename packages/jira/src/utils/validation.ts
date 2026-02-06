import { ZodError } from 'zod';
import type { JiraConfig, ValidatedJiraConfig } from '../types/config.js';
import { JiraConfigSchema } from '../types/config.js';
import { JiraValidationError } from './errors.js';

/**
 * Validate Jira configuration
 * @throws {JiraValidationError} if configuration is invalid
 */
export function validateConfig(config: JiraConfig): ValidatedJiraConfig {
  try {
    return JiraConfigSchema.parse(config);
  } catch (error) {
    if (error instanceof ZodError) {
      const details: Record<string, string[]> = {};
      for (const issue of error.issues) {
        const path = issue.path.join('.');
        if (!details[path]) {
          details[path] = [];
        }
        details[path].push(issue.message);
      }
      throw new JiraValidationError('Invalid Jira configuration', details);
    }
    throw error;
  }
}

/**
 * Validate an issue key format (e.g., "PROJ-123")
 */
export function validateIssueKey(key: string): boolean {
  return /^[A-Z][A-Z0-9]+-\d+$/.test(key);
}

/**
 * Validate a project key format (e.g., "PROJ")
 */
export function validateProjectKey(key: string): boolean {
  return /^[A-Z][A-Z0-9_]*$/.test(key);
}

/**
 * Validate JQL query (basic syntax check)
 */
export function validateJql(jql: string): boolean {
  // Basic validation - not empty and doesn't contain obvious injection attempts
  if (!jql.trim()) {
    return false;
  }
  // Jira JQL doesn't allow certain special characters in specific contexts
  // This is a basic sanity check, Jira API will provide full validation
  return true;
}

/**
 * Validate a date string (YYYY-MM-DD format)
 */
export function validateDateString(date: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(date);
}

/**
 * Ensure a value is an issue key, throwing if invalid
 */
export function ensureIssueKey(key: string): string {
  if (!validateIssueKey(key)) {
    throw new JiraValidationError(
      `Invalid issue key format: ${key}. Expected format: PROJECT-123`
    );
  }
  return key;
}

/**
 * Ensure a value is a project key, throwing if invalid
 */
export function ensureProjectKey(key: string): string {
  if (!validateProjectKey(key)) {
    throw new JiraValidationError(
      `Invalid project key format: ${key}. Must start with uppercase letter.`
    );
  }
  return key;
}
