# Data Model: Knowledge Store Management

## Core Entities

### IndividualKnowledge

The complete knowledge profile for a user.

```typescript
interface IndividualKnowledge {
  userId: string;
  philosophy: Philosophy;
  principles: Principle[];
  patterns: Pattern[];
  context: UserContext;
  metadata: {
    createdAt: string;      // ISO 8601
    updatedAt: string;      // ISO 8601
    version: number;
  };
}
```

### Philosophy

Core values and beliefs that rarely change.

```typescript
interface Philosophy {
  values: Value[];
  beliefs: Belief[];
  identity: {
    professionalTitle?: string;
    expertise?: string[];
    yearsExperience?: number;
  };
}

interface Value {
  name: string;           // e.g., "Quality over speed"
  description: string;    // Why this matters
  priority: number;       // 1-10 ranking
}

interface Belief {
  statement: string;      // e.g., "Code should be self-documenting"
  confidence: number;     // 0.0-1.0
  domain: string[];       // Where this applies
}
```

### Principle

Reusable decision rules with evidence.

```typescript
interface Principle {
  id: string;                       // UUID
  content: string;                  // The principle statement
  domain: string[];                 // e.g., ["coding", "typescript"]
  weight: number;                   // 0.0-1.0 importance
  evidence: Evidence[];             // Supporting decisions
  status: PrincipleStatus;
  metadata: {
    createdAt: string;
    updatedAt: string;
    source?: string;                // Where it came from
    deprecatedAt?: string;
    deprecationReason?: string;
  };
}

type PrincipleStatus = 'active' | 'deprecated' | 'draft';

interface Evidence {
  decision: string;                 // What was decided
  context: string;                  // Situation description
  outcome?: 'positive' | 'negative' | 'neutral';
  timestamp: string;
}
```

### Pattern

Emerging behaviors that may become principles.

```typescript
interface Pattern {
  id: string;                       // UUID
  description: string;              // What the pattern is
  occurrences: PatternOccurrence[];
  status: PatternStatus;
  domain: string[];
  firstSeen: string;
  lastSeen: string;
  promotedTo?: string;              // Principle ID if promoted
}

type PatternStatus = 'emerging' | 'established' | 'promoted' | 'rejected';

interface PatternOccurrence {
  context: string;
  timestamp: string;
  decision: string;
}
```

### UserContext

Temporary, session-relevant information.

```typescript
interface UserContext {
  currentProject?: {
    name: string;
    type: string;
    technologies: string[];
  };
  recentDecisions: RecentDecision[];
  activeGoals: string[];
  preferences: {
    verbosity: 'minimal' | 'normal' | 'detailed';
    codeStyle?: string;
    [key: string]: unknown;
  };
}

interface RecentDecision {
  summary: string;
  timestamp: string;
  principlesApplied: string[];    // Principle IDs
}
```

## Storage Types

### StorageProvider Interface

```typescript
interface StorageProvider {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
  exists(key: string): Promise<boolean>;

  // Versioning
  getVersion<T>(key: string, version: number): Promise<T | null>;
  listVersions(key: string): Promise<VersionInfo[]>;
  createVersion(key: string): Promise<number>;
}

interface VersionInfo {
  version: number;
  timestamp: string;
  size: number;           // Bytes
}
```

## Portability Types

### Export/Import

```typescript
type PortabilityLevel = 'full' | 'redacted' | 'abstracted';

interface ExportedKnowledge {
  version: string;          // Export format version
  level: PortabilityLevel;
  exportedAt: string;
  philosophy?: Philosophy;
  principles?: ExportedPrinciple[];
  patterns?: Pattern[];
  context?: UserContext;
  checksum: string;         // For integrity verification
}

interface ExportedPrinciple {
  id: string;
  content: string;
  domain: string[];
  weight: number;
  evidenceCount: number;    // For abstracted, just count
  evidence?: Evidence[];    // For full/redacted
}

interface ImportResult {
  success: boolean;
  imported: {
    principles: number;
    patterns: number;
    philosophy: boolean;
  };
  merged: {
    principles: number;
  };
  conflicts: ImportConflict[];
  errors: string[];
}

interface ImportConflict {
  type: 'principle' | 'philosophy' | 'pattern';
  existing: unknown;
  incoming: unknown;
  resolution: 'auto' | 'pending';
  autoResolved?: boolean;
  reason?: string;
}
```

## Validation Rules

### Principle Validation

```typescript
const principleSchema = z.object({
  id: z.string().uuid(),
  content: z.string().min(10).max(500),
  domain: z.array(z.string()).min(1).max(10),
  weight: z.number().min(0).max(1),
  evidence: z.array(evidenceSchema).default([]),
  status: z.enum(['active', 'deprecated', 'draft']),
  metadata: z.object({
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    source: z.string().optional(),
    deprecatedAt: z.string().datetime().optional(),
    deprecationReason: z.string().optional(),
  }),
});
```

### Philosophy Validation

```typescript
const philosophySchema = z.object({
  values: z.array(z.object({
    name: z.string().min(2).max(100),
    description: z.string().max(500),
    priority: z.number().int().min(1).max(10),
  })).max(20),
  beliefs: z.array(z.object({
    statement: z.string().min(10).max(300),
    confidence: z.number().min(0).max(1),
    domain: z.array(z.string()),
  })).max(50),
  identity: z.object({
    professionalTitle: z.string().optional(),
    expertise: z.array(z.string()).optional(),
    yearsExperience: z.number().int().min(0).optional(),
  }),
});
```

## Relationships

```
IndividualKnowledge
├── Philosophy (1:1)
│   ├── Values (1:N)
│   └── Beliefs (1:N)
├── Principles (1:N)
│   └── Evidence (1:N)
├── Patterns (1:N)
│   └── Occurrences (1:N)
└── Context (1:1)
    └── RecentDecisions (1:N)

Pattern ──promotes to──► Principle
Principle ──applied in──► RecentDecision
```

## File Storage Layout

```
{baseDir}/{userId}/
├── philosophy.json           # Philosophy document
├── principles.json           # Array of Principle objects
├── patterns.json             # Array of Pattern objects
├── context.json              # UserContext object
├── audit.json                # Audit trail entries
└── versions/
    ├── philosophy/
    │   ├── v1.json
    │   └── v2.json
    ├── principles/
    │   ├── v1.json
    │   └── v2.json
    └── patterns/
        └── v1.json
```
