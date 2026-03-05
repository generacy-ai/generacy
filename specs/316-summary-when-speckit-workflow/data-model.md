# Data Model: Post Clarification Questions to Issue

## Core Entities

### PendingQuestion

Represents a single unanswered clarification question extracted from `clarifications.md`.

```typescript
interface PendingQuestion {
  /** Question number (e.g., 1, 2, 3) */
  number: number;
  /** Short topic/title */
  topic: string;
  /** Context explaining why this matters */
  context: string;
  /** The actual question text */
  question: string;
  /** Optional multiple-choice options */
  options?: string[];
}
```

### PostClarificationOptions

Options passed to the `postClarificationQuestions` function.

```typescript
interface PostClarificationOptions {
  /** Path to the git checkout (worktree) */
  checkoutPath: string;
  /** GitHub issue number */
  issueNumber: number;
  /** GitHub client for API calls */
  github: GitHubClient;
  /** Repository owner */
  owner: string;
  /** Repository name */
  repo: string;
  /** Logger instance */
  logger: Logger;
}
```

## Relationships

```
phase-loop.ts
  └── calls postClarificationQuestions(opts)
        ├── globs for specs/{issueNumber}-*/clarifications.md
        ├── reads file content
        ├── calls parsePendingQuestions(content) → PendingQuestion[]
        ├── calls formatQuestionsComment(questions) → string
        └── calls github.addIssueComment(owner, repo, issueNumber, comment)
```

## Validation Rules

| Field | Rule |
|-------|------|
| `topic` | Non-empty string, extracted from `### Q\d+: <topic>` |
| `context` | Non-empty string, extracted from `**Context**: <text>` |
| `question` | Non-empty string, extracted from `**Question**: <text>` |
| `options` | Optional array; only present if `**Options**:` section exists |
| Answer filter | Only questions with `**Answer**: *Pending*` are included |

## Input Format (clarifications.md)

```markdown
### Q1: [Topic]
**Context**: [Description]
**Question**: [Question text]
**Options**:
- A: [Option]
- B: [Option]

**Answer**: *Pending*
```

## Output Format (GitHub comment)

```markdown
## 🔍 Clarification Questions

The following questions need your input before we can proceed:

### Q1: [Topic]
**Context**: [Description]

**Question**: [Question text]

**Options**:
- A: [Option]
- B: [Option]

---

*Reply to this issue with your answers. The workflow will resume when answers are detected.*
```
