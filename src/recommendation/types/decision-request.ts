/**
 * Decision Request Types
 * Interim types until generacy-ai/contracts package provides canonical versions
 */

/**
 * A decision that needs to be made
 */
export interface DecisionRequest {
  /** Unique identifier for this decision request */
  id: string;

  /** Domain tags for principle matching (e.g., ['career', 'finance']) */
  domain: string[];

  /** The question or decision to be made */
  question: string;

  /** Available options to choose from */
  options: DecisionOption[];

  /** Optional constraints on the decision */
  constraints?: Constraint[];

  /** Optional deadline for the decision */
  deadline?: string; // ISO 8601 date string

  /** Additional context specific to this request */
  metadata?: Record<string, unknown>;
}

/**
 * An option available for a decision
 */
export interface DecisionOption {
  /** Unique identifier for this option */
  id: string;

  /** Human-readable name */
  name: string;

  /** Description of what this option entails */
  description: string;

  /** Structured attributes for comparison */
  attributes: Record<string, unknown>;

  /** Whether this option is reversible */
  reversible?: boolean;

  /** Complexity rating 1-10 */
  complexity?: number;
}

/**
 * A constraint on a decision
 */
export interface Constraint {
  /** Type of constraint */
  type: 'time' | 'budget' | 'resource' | 'custom';

  /** Constraint value */
  value: string | number;

  /** Unit for numeric constraints */
  unit?: string;

  /** Whether this is a hard constraint (violation = option invalid) */
  hard?: boolean;
}
