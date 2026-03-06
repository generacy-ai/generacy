# Data Model: Clarification Posting

## Core Entities

### ClarificationQuestion
Represents a single parsed question from `clarifications.md`.

```typescript
interface ClarificationQuestion {
  /** Question number (1-based) */
  number: number;
  /** Short topic/title */
  topic: string;
  /** Context explaining why the question matters */
  context: string;
  /** The actual question text */
  question: string;
  /** Optional multiple-choice options */
  options?: ClarificationOption[];
  /** Whether the question has been answered */
  answered: boolean;
  /** The answer text, if answered */
  answer?: string;
}

interface ClarificationOption {
  /** Option label (A, B, C, etc.) */
  label: string;
  /** Option description */
  description: string;
}
```

### ClarificationPostResult
Result of attempting to post clarifications.

```typescript
interface ClarificationPostResult {
  /** Whether a comment was posted */
  posted: boolean;
  /** Number of pending questions found */
  pendingCount: number;
  /** Reason if not posted */
  reason?: 'no-pending-questions' | 'already-posted' | 'file-not-found' | 'post-failed';
}
```

## Validation Rules

- `number` must be positive integer
- `topic` must be non-empty string
- `question` must be non-empty string
- A question is "pending" when `answered === false` (parsed from `**Answer**: *Pending*`)
- At least one pending question must exist to trigger posting

## Relationships

```
phase-loop.ts
  └── calls ClarificationPoster.postClarifications()
        ├── reads specs/{issueNum}-*/clarifications.md
        ├── parses → ClarificationQuestion[]
        ├── filters → pending questions only
        ├── checks → existing marker comment on issue
        └── posts → formatted GitHub comment
```
