# Implementation Plan: Architecture Overview for Adopters

## Summary

Replace the existing internal-focused architecture overview (`docs/docs/architecture/overview.md`) with an adopter-focused document that explains how Generacy works from the outside in. Move internal architecture details (Redis, BullMQ, PostgreSQL, deployment topology) to a new `docs/docs/architecture/internals.md` page. The new overview uses Mermaid diagrams, a hybrid conversational/reference tone, and is self-contained (readable end-to-end without clicking links) while linking to deeper docs for optional depth.

## Technical Context

- **Framework**: Docusaurus (TypeScript config, Mermaid enabled via `@docusaurus/theme-mermaid`)
- **Diagram format**: Mermaid (already configured in `docusaurus.config.ts` line 25 and 28)
- **Sidebar**: `docs/sidebars.ts` — Architecture category at lines 103-115
- **Existing file to replace**: `docs/docs/architecture/overview.md` (311 lines)
- **No code changes** — this is a documentation-only feature

## Architecture of the Change

```
docs/docs/architecture/
├── overview.md          ← REWRITE (adopter-focused, ~400 lines)
├── internals.md         ← NEW (internal details moved here)
├── contracts.md         ← unchanged
└── security.md          ← unchanged

docs/sidebars.ts         ← ADD internals entry
```

## Source Material

The new overview synthesizes from these authoritative sources:

| Source | Path | What to extract |
|--------|------|-----------------|
| Label protocol | `/workspaces/tetrad-development/docs/label-protocol.md` | Adopter-relevant labels, lifecycle, clarification/review patterns |
| Feature workflow | `/workspaces/generacy/workflows/speckit-feature.yaml` | Real YAML excerpt for customization section |
| Stage comment mgr | `packages/orchestrator/src/worker/stage-comment-manager.ts` | How progress appears on issues |
| Phase resolver | `packages/orchestrator/src/worker/phase-resolver.ts` | Gate mapping for review cycle docs |
| Existing overview | `docs/docs/architecture/overview.md` | Triad description, high-level diagrams (simplified) |
| Existing intro | `docs/docs/intro.md` | Progressive adoption levels |

## Implementation Phases

### Phase 1: Create Architecture Internals Page

**File**: `docs/docs/architecture/internals.md`

Move internal details from the current overview to this new page:
- Redis + BullMQ queue architecture
- PostgreSQL state management
- Deployment architecture diagrams (local Level 1-3 and cloud Level 4)
- Message flow / communication channels
- Key design decisions (why Redis, why PostgreSQL, why MCP)
- Worker pool configuration

Add frontmatter:
```yaml
---
sidebar_position: 4
---
```

Add a note at the top linking back to the adopter overview:
> Looking for a high-level understanding of how Generacy works? See the [Architecture Overview](/docs/architecture/overview).

### Phase 2: Rewrite Architecture Overview

**File**: `docs/docs/architecture/overview.md`

Complete rewrite with the following structure:

#### Section 1: Introduction (~20 lines)
- One-liner: this doc covers the orchestrated workflow (Level 3+)
- Link to getting-started docs for simpler setups (Level 1-2)
- What readers will learn

#### Section 2: High-Level Architecture Diagram (~40 lines)
- Simplified Mermaid diagram showing:
  - GitHub (issues + PRs) ↔ Orchestrator ↔ Worker ↔ AI Agent
  - Labels as the communication mechanism
  - Review gates as pause points
- Omit: Redis, PostgreSQL, BullMQ, S3, load balancers

#### Section 3: How It Works — Workflow Lifecycle (~80 lines)
- Conversational walkthrough of the speckit-feature flow:
  1. You label an issue → orchestrator picks it up
  2. Agent generates a specification → creates a draft PR
  3. Agent posts clarification questions → workflow pauses
  4. You answer → workflow resumes
  5. Agent plans, generates tasks, implements
  6. PR marked ready for review → you review
  7. Agent addresses feedback if needed
- **Stage comments**: brief explanation that progress appears as structured comments on the issue, updated automatically as phases complete

#### Section 4: Label Protocol (~60 lines)
- Adopter-relevant labels only (per Q4 answer: option B)
- Two categories with tables:
  - **Labels you add**: trigger labels (`process:speckit-feature`, `process:speckit-bugfix`), completion signals (`completed:clarification`, `completed:spec-review`, etc.)
  - **Labels you'll observe**: status indicators (`agent:in-progress`, `agent:error`, `waiting-for:*`)
- Brief explanation of the pattern: trigger → process → waiting → completed → resume

#### Section 5: Clarification and Review Cycles (~60 lines)
- Unified pattern explanation (per Q6 answer: option C):
  - The system pauses → posts a comment explaining what it needs → you review → you signal completion via label → system resumes
- Then list each review type:
  - **Clarification** (`waiting-for:clarification` / `completed:clarification`): answer questions posted as issue comment
  - **Spec review** (`waiting-for:spec-review` / `completed:spec-review`): review generated specification
  - **Plan review** (`waiting-for:plan-review` / `completed:plan-review`): review implementation plan
  - **Tasks review** (`waiting-for:tasks-review` / `completed:tasks-review`): review task breakdown
  - **PR feedback** (`waiting-for:address-pr-feedback`): standard GitHub PR review — system auto-addresses comments

#### Section 6: Customizing Workflows (~60 lines)
- Real minimal example from `speckit-feature.yaml` showing 2-3 phases (per Q3 answer: option A)
- Explain the structure: `name`, `phases[]`, `steps[]`, `uses` (action reference), `with` (inputs using `${{ }}` interpolation)
- List of built-in action namespaces (without full parameter docs):
  - `speckit.*` — specification, clarification, planning, tasks, implementation
  - `verification.*` — test and lint checking
  - `github.*` — label management, PR operations
  - `workflow.*` — gate checking, flow control
- Link to future workflow authoring guide when available

#### Section 7: Configuration Essentials (~30 lines)
- Minimal setup only (per Q5 answer: option A):
  - GitHub webhook URL and required events
  - Watched repositories YAML snippet
  - API token / GitHub App credentials
- "Learn more" link to existing config reference (`/docs/reference/config/generacy`)

#### Section 8: Error Handling (~40 lines)
- Mechanism + common scenarios (per Q7 answer: option B):
  - What `agent:error` means, error comment format
  - How to retry (remove error label, re-add trigger label)
  - Common scenarios:
    - **Timeout**: agent exceeded time limit — retry or break task into smaller pieces
    - **Context overflow**: issue too complex — simplify requirements or split into epic
    - **Test failures**: implementation didn't pass verification — review errors, fix manually or retry
    - **Merge conflicts**: branch diverged — resolve conflicts and retry

#### Section 9: Glossary (~20 lines)
- Quick-reference table: Orchestrator, Worker, Phase, Gate, Stage Comment, Workflow, Action

#### Section 10: Next Steps (~10 lines)
- Links to: Getting Started, Workflow Authoring Guide, Configuration Reference, Architecture Internals

### Phase 3: Update Sidebar

**File**: `docs/sidebars.ts`

Add `architecture/internals` to the Architecture category:

```typescript
items: [
  'architecture/overview',
  'architecture/internals',
  'architecture/contracts',
  'architecture/security',
],
```

### Phase 4: Verify

- Confirm all internal links resolve (no broken markdown links)
- Confirm Mermaid diagrams are syntactically valid
- Confirm sidebar renders correctly
- Confirm the overview is self-contained and readable without clicking links

## Key Technical Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Replace vs coexist | Replace + redirect internals | Avoids content drift; one canonical overview (Q1: option D) |
| Diagram format | Mermaid | Already configured; GitHub + Docusaurus native support (Q2: option A) |
| Workflow examples | Real excerpt from speckit-feature.yaml | Grounds explanation in reality (Q3: option A) |
| Label scope | Adopter-relevant only | Omit system-internal labels to reduce noise (Q4: option B) |
| Config depth | Minimal setup only | Avoids duplicating 419-line config reference (Q5: option A) |
| Review cycle structure | Unified pattern + list | One mental model, no repetition (Q6: option C) |
| Error handling depth | Mechanism + common scenarios | Actionable guidance without over-engineering (Q7: option B) |
| Adoption level context | Brief note at top | Document assumes Level 3+, links to simpler paths (Q8: option B) |
| Tone | Hybrid | Conversational for walkthroughs, reference for tables (Q9: option C) |
| Stage comments | Include | Core adopter experience, explain in lifecycle section (Q10: option A) |
| Cross-linking | Self-contained with "learn more" links | Readable end-to-end, optional depth (Q11: option A) |
| Webhook detail | Concept + link | Architecture doc, not setup guide (Q12: option C) |

## Risk Mitigation

| Risk | Impact | Mitigation |
|------|--------|------------|
| Broken links after moving content | Users hit 404s from bookmarks or external references | Keep the same path for overview (`architecture/overview`); internals is new |
| Content drift between overview and internals | Inconsistent information | Each doc has a distinct audience and scope — overview never mentions implementation details |
| Mermaid diagrams don't render | Diagrams appear as code blocks | Mermaid already proven in existing docs; test in Docusaurus dev server |
| Overview too long | Adopters don't finish reading | Target ~400 lines; use collapsible sections sparingly; every section earns its place |
| YAML excerpt becomes stale | Workflow example diverges from actual workflow | Use a simplified excerpt with a note: "Simplified for illustration — see actual workflow files for the full definition" |

## Files to Create/Modify

| File | Action | Lines (est.) |
|------|--------|-------------|
| `docs/docs/architecture/overview.md` | Rewrite | ~400 |
| `docs/docs/architecture/internals.md` | Create | ~250 |
| `docs/sidebars.ts` | Edit (add 1 line) | +1 |

## Out of Scope

- Detailed workflow authoring guide (separate future doc)
- Full parameter docs for built-in actions
- Installation/setup instructions (covered in getting-started)
- Internal architecture of the queue, database, or worker pool (moved to internals.md)
- Cloud deployment topology (moved to internals.md)
