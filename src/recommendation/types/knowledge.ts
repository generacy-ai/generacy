/**
 * Knowledge Store Types
 * Interim types until @generacy/knowledge-store package is available
 *
 * These types represent a human's individual knowledge used
 * to personalize recommendations.
 */

/**
 * A human's complete knowledge profile
 */
export interface IndividualKnowledge {
  /** Unique identifier for this knowledge store */
  id: string;

  /** Human who owns this knowledge */
  ownerId: string;

  /** Core philosophy - values, beliefs, risk tolerance */
  philosophy: Philosophy;

  /** Domain-specific decision patterns */
  principles: Principle[];

  /** Observed regularities from past decisions */
  patterns: Pattern[];

  /** Current context - priorities, constraints, energy */
  context: UserContext;
}

/**
 * Core philosophy representing values, beliefs, and preferences
 */
export interface Philosophy {
  /** Core values ranked by importance */
  values: Value[];

  /** Beliefs and worldview */
  beliefs: Belief[];

  /** Risk tolerance (0-1, where 0 is very risk-averse) */
  riskTolerance: number;

  /** Preferred time horizon for decisions */
  timeHorizon: 'short' | 'medium' | 'long';

  /** Absolute boundaries that must not be crossed */
  boundaries: Boundary[];
}

/**
 * A core value
 */
export interface Value {
  /** Value name */
  name: string;

  /** Value description */
  description: string;

  /** Relative importance (0-10) */
  importance: number;
}

/**
 * A belief or worldview element
 */
export interface Belief {
  /** Belief statement */
  statement: string;

  /** Confidence in this belief (0-1, where 1 is absolute) */
  confidence: number;

  /** Related domains */
  domains: string[];
}

/**
 * An absolute boundary that must not be crossed
 */
export interface Boundary {
  /** Boundary description */
  description: string;

  /** Type of boundary */
  type: 'ethical' | 'legal' | 'personal' | 'financial';

  /** Whether this is a hard boundary (never cross) */
  hard: boolean;
}

/**
 * A domain-specific decision principle
 */
export interface Principle {
  /** Unique identifier */
  id: string;

  /** Short name for the principle */
  name: string;

  /** Full text of the principle */
  content: string;

  /** Domains where this principle applies */
  domains: string[];

  /** Weight/importance of this principle (0-10) */
  weight: number;

  /** Whether this principle is currently active */
  active: boolean;

  /** Exceptions or "unless" conditions */
  exceptions?: string[];

  /** Source of this principle (learned, stated, inferred) */
  source: 'learned' | 'stated' | 'inferred';
}

/**
 * An observed pattern from past decisions
 */
export interface Pattern {
  /** Unique identifier */
  id: string;

  /** Pattern description */
  description: string;

  /** Domains where this pattern has been observed */
  domains: string[];

  /** Confidence in this pattern (0-1) */
  confidence: number;

  /** Number of observations supporting this pattern */
  observations: number;
}

/**
 * Current user context
 */
export interface UserContext {
  /** Current active goals */
  activeGoals: Goal[];

  /** Current constraints */
  constraints: ContextConstraint[];

  /** Energy/fatigue level (1-10, where 10 is fully energized) */
  energyLevel: number;

  /** Current decision fatigue level (0-1, where 1 is very fatigued) */
  decisionFatigue: number;

  /** Current priorities */
  priorities: string[];

  /** Timestamp of last update */
  lastUpdated: string;
}

/**
 * An active goal
 */
export interface Goal {
  /** Goal identifier */
  id: string;

  /** Goal description */
  description: string;

  /** Priority (1 = highest) */
  priority: number;

  /** Related domains */
  domains: string[];

  /** Deadline if any */
  deadline?: string;
}

/**
 * A context-specific constraint
 */
export interface ContextConstraint {
  /** Constraint type */
  type: 'time' | 'budget' | 'resource' | 'energy' | 'custom';

  /** Description of the constraint */
  description: string;

  /** Severity (how limiting) */
  severity: 'low' | 'medium' | 'high' | 'critical';
}
