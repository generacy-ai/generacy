/**
 * Core knowledge types for the Knowledge Store
 * Based on data-model.md specification
 */

/**
 * A core value that guides decision-making
 */
export interface Value {
  name: string;
  description: string;
  priority: number; // 1-10 ranking
}

/**
 * A belief statement with confidence level
 */
export interface Belief {
  statement: string;
  confidence: number; // 0.0-1.0
  domain: string[];
}

/**
 * Identity information for the user
 */
export interface Identity {
  professionalTitle?: string;
  expertise?: string[];
  yearsExperience?: number;
}

/**
 * Core values and beliefs that rarely change
 */
export interface Philosophy {
  values: Value[];
  beliefs: Belief[];
  identity: Identity;
}

/**
 * Evidence supporting a principle
 */
export interface Evidence {
  decision: string;
  context: string;
  outcome?: 'positive' | 'negative' | 'neutral';
  timestamp: string;
}

/**
 * Status of a principle
 */
export type PrincipleStatus = 'active' | 'deprecated' | 'draft';

/**
 * Metadata for a principle
 */
export interface PrincipleMetadata {
  createdAt: string;
  updatedAt: string;
  source?: string;
  deprecatedAt?: string;
  deprecationReason?: string;
}

/**
 * Reusable decision rules with evidence
 */
export interface Principle {
  id: string;
  content: string;
  domain: string[];
  weight: number; // 0.0-1.0 importance
  evidence: Evidence[];
  status: PrincipleStatus;
  metadata: PrincipleMetadata;
}

/**
 * A single occurrence of a pattern
 */
export interface PatternOccurrence {
  context: string;
  timestamp: string;
  decision: string;
}

/**
 * Status of a pattern
 */
export type PatternStatus = 'emerging' | 'established' | 'promoted' | 'rejected';

/**
 * Emerging behaviors that may become principles
 */
export interface Pattern {
  id: string;
  description: string;
  occurrences: PatternOccurrence[];
  status: PatternStatus;
  domain: string[];
  firstSeen: string;
  lastSeen: string;
  promotedTo?: string; // Principle ID if promoted
}

/**
 * A recent decision made by the user
 */
export interface RecentDecision {
  summary: string;
  timestamp: string;
  principlesApplied: string[]; // Principle IDs
}

/**
 * Current project context
 */
export interface CurrentProject {
  name: string;
  type: string;
  technologies: string[];
}

/**
 * User preferences
 */
export interface UserPreferences {
  verbosity: 'minimal' | 'normal' | 'detailed';
  codeStyle?: string;
  [key: string]: unknown;
}

/**
 * Temporary, session-relevant information
 */
export interface UserContext {
  currentProject?: CurrentProject;
  recentDecisions: RecentDecision[];
  activeGoals: string[];
  preferences: UserPreferences;
}

/**
 * Metadata for the knowledge profile
 */
export interface KnowledgeMetadata {
  createdAt: string;
  updatedAt: string;
  version: number;
}

/**
 * The complete knowledge profile for a user
 */
export interface IndividualKnowledge {
  userId: string;
  philosophy: Philosophy;
  principles: Principle[];
  patterns: Pattern[];
  context: UserContext;
  metadata: KnowledgeMetadata;
}
