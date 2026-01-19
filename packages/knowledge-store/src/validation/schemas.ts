/**
 * Zod schemas for Knowledge Store validation
 * Based on data-model.md specification
 */

import { z } from 'zod';

/**
 * Schema for Value
 */
export const valueSchema = z.object({
  name: z.string().min(2).max(100),
  description: z.string().max(500),
  priority: z.number().int().min(1).max(10),
});

/**
 * Schema for Belief
 */
export const beliefSchema = z.object({
  statement: z.string().min(10).max(300),
  confidence: z.number().min(0).max(1),
  domain: z.array(z.string()),
});

/**
 * Schema for Identity
 */
export const identitySchema = z.object({
  professionalTitle: z.string().optional(),
  expertise: z.array(z.string()).optional(),
  yearsExperience: z.number().int().min(0).optional(),
});

/**
 * Schema for Philosophy
 */
export const philosophySchema = z.object({
  values: z.array(valueSchema).max(20),
  beliefs: z.array(beliefSchema).max(50),
  identity: identitySchema,
});

/**
 * Schema for Evidence
 */
export const evidenceSchema = z.object({
  decision: z.string().min(1),
  context: z.string().min(1),
  outcome: z.enum(['positive', 'negative', 'neutral']).optional(),
  timestamp: z.string().datetime(),
});

/**
 * Schema for PrincipleMetadata
 */
export const principleMetadataSchema = z.object({
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  source: z.string().optional(),
  deprecatedAt: z.string().datetime().optional(),
  deprecationReason: z.string().optional(),
});

/**
 * Schema for Principle
 */
export const principleSchema = z.object({
  id: z.string().uuid(),
  content: z.string().min(10).max(500),
  domain: z.array(z.string()).min(1).max(10),
  weight: z.number().min(0).max(1),
  evidence: z.array(evidenceSchema).default([]),
  status: z.enum(['active', 'deprecated', 'draft']),
  metadata: principleMetadataSchema,
});

/**
 * Schema for PatternOccurrence
 */
export const patternOccurrenceSchema = z.object({
  context: z.string().min(1),
  timestamp: z.string().datetime(),
  decision: z.string().min(1),
});

/**
 * Schema for Pattern
 */
export const patternSchema = z.object({
  id: z.string().uuid(),
  description: z.string().min(10).max(500),
  occurrences: z.array(patternOccurrenceSchema),
  status: z.enum(['emerging', 'established', 'promoted', 'rejected']),
  domain: z.array(z.string()),
  firstSeen: z.string().datetime(),
  lastSeen: z.string().datetime(),
  promotedTo: z.string().uuid().optional(),
});

/**
 * Schema for RecentDecision
 */
export const recentDecisionSchema = z.object({
  summary: z.string().min(1),
  timestamp: z.string().datetime(),
  principlesApplied: z.array(z.string()),
});

/**
 * Schema for CurrentProject
 */
export const currentProjectSchema = z.object({
  name: z.string().min(1),
  type: z.string().min(1),
  technologies: z.array(z.string()),
});

/**
 * Schema for UserPreferences
 */
export const userPreferencesSchema = z
  .object({
    verbosity: z.enum(['minimal', 'normal', 'detailed']),
    codeStyle: z.string().optional(),
  })
  .passthrough();

/**
 * Schema for UserContext
 */
export const userContextSchema = z.object({
  currentProject: currentProjectSchema.optional(),
  recentDecisions: z.array(recentDecisionSchema),
  activeGoals: z.array(z.string()),
  preferences: userPreferencesSchema,
});

/**
 * Schema for KnowledgeMetadata
 */
export const knowledgeMetadataSchema = z.object({
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  version: z.number().int().min(0),
});

/**
 * Schema for IndividualKnowledge
 */
export const individualKnowledgeSchema = z.object({
  userId: z.string().min(1),
  philosophy: philosophySchema,
  principles: z.array(principleSchema),
  patterns: z.array(patternSchema),
  context: userContextSchema,
  metadata: knowledgeMetadataSchema,
});

// Type exports inferred from schemas
export type ValueInput = z.input<typeof valueSchema>;
export type BeliefInput = z.input<typeof beliefSchema>;
export type PhilosophyInput = z.input<typeof philosophySchema>;
export type EvidenceInput = z.input<typeof evidenceSchema>;
export type PrincipleInput = z.input<typeof principleSchema>;
export type PatternInput = z.input<typeof patternSchema>;
export type UserContextInput = z.input<typeof userContextSchema>;
export type IndividualKnowledgeInput = z.input<typeof individualKnowledgeSchema>;
