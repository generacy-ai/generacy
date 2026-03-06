# Data Model: Post Clarification Questions on Issue

## Core Entities

### ClarificationQuestion

Represents a single parsed question from `clarifications.md`.

```typescript
interface ClarificationQuestion {
  /** Question number (e.g., 1, 2, 3) */
  number: number;
  /** Short topic/title */
  topic: string;
  /** Background context for the question */
  context: string;
  /** The actual question text */
  question: string;
  /** Optional multiple-choice options */
  options?: { label: string; description: string }[];
  /** Answer text, or null if pending */
  answer: string | null;
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
  /** Path to the clarifications file (if found) */
  filePath?: string;
}
```

## Relationships

```
phase-loop.ts
  └── ClarificationPoster
        ├── reads → clarifications.md (from checkoutPath)
        ├── parses → ClarificationQuestion[]
        ├── filters → pending questions only (answer === null)
        └── posts → GitHub issue comment (via GitHubClient)
```

## Validation Rules

- A question is "pending" when its answer field contains `*Pending*`
- A question is "answered" when it has any other answer text
- Only pending questions are included in the posted comment
- If no pending questions exist, no comment is posted
- The `clarifications.md` file path must match `specs/{issueNumber}-*/clarifications.md`
