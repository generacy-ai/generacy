# Clarifications

Questions and answers to clarify the feature specification.

## Batch 1 - 2026-01-19 20:44

### Q1: Decision Storage
**Context**: The spec references decision history and building evidence trails, but doesn't specify how decisions are persisted. This affects architecture and dependencies.
**Question**: How should decisions be stored for learning loop analysis?
**Options**:
- A: In-memory storage (suitable for MVP, decisions lost on restart)
- B: Repository pattern with pluggable backend (abstract storage, configure later)
- C: Direct integration with existing data layer (requires knowledge of current persistence)

**Answer**: B - Repository pattern with pluggable backend. The humancy-knowledge-architecture.md establishes Decision as a core entity with rich relationships. The architecture emphasizes plugin extensibility throughout. A repository pattern allows starting with in-memory for testing/MVP, swapping backends without changing business logic, and aligning with the "Recommended Stack" section.

### Q2: Pattern Detection Thresholds
**Context**: Pattern detection evaluates when regularities should be promoted to principles, but no thresholds are defined. This affects the algorithm design.
**Question**: What thresholds should trigger pattern-to-principle promotion?
**Options**:
- A: Fixed thresholds (e.g., 5+ occurrences, 80%+ consistency)
- B: Configurable thresholds per domain/user
- C: AI-determined thresholds based on context

**Answer**: B - Configurable thresholds per domain/user. The knowledge architecture defines Pattern with frequency and confidence fields. The Humancy vision emphasizes personalization - different humans have different decision styles. Ship with sensible defaults (e.g., 5+ occurrences, 80%+ consistency) that can be overridden.

### Q3: Update Approval UX
**Context**: The spec mentions humans can approve/reject updates, but not how this workflow operates. This affects integration with the broader system.
**Question**: How should knowledge update approval be presented to users?
**Options**:
- A: Individual approval per update (immediate, granular control)
- B: Batched approval (daily/weekly summary of pending updates)
- C: Auto-approve low-confidence updates, require approval for high-impact changes

**Answer**: C - Auto-approve low-confidence updates, require approval for high-impact changes. This aligns with the "Do Without Doing" philosophy and the focus on "efficient intervention" - human attention goes to genuinely novel decisions. Low-confidence principle reinforcements shouldn't require approval, but new principles or significant weight changes should.

### Q4: Knowledge Store Integration
**Context**: The processor generates KnowledgeUpdate objects but the actual storage mechanism isn't specified. Need to understand the boundary.
**Question**: What is the expected interface to the knowledge store?
**Options**:
- A: This processor owns the knowledge store (implement storage here)
- B: Emit events/updates for external knowledge store to consume
- C: Call existing knowledge store API (assuming #24 Knowledge Store Management)

**Answer**: C - Call existing knowledge store API (assuming #24 Knowledge Store Management). The issue mentions dependency on generacy-ai/contracts - Knowledge store schemas and there's a separate issue #24 for Knowledge Store Management. The separation of concerns suggests this processor generates KnowledgeUpdate objects but delegates storage to the knowledge store component.

### Q5: MVP Scope
**Context**: The spec lists many features (decision capture, coaching analysis, pattern detection, principle refinement, update verification). Clarifying scope helps prioritize implementation.
**Question**: What's the minimum viable scope for initial implementation?
**Options**:
- A: Full feature set - implement everything listed
- B: Core learning only - decision capture + coaching processing, defer pattern detection
- C: Scaffolding only - interfaces and basic flow, detailed logic later

**Answer**: B - Core learning only (decision capture + coaching processing, defer pattern detection). Decision capture and coaching processing are the foundation. Pattern detection is valuable but computationally heavier and can be added incrementally. The acceptance criteria prioritizes "Processes all decisions into learning events" and "Extracts learning from coaching data" first.

