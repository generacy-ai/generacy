# Clarifications

Questions and answers to clarify the feature specification.

## Batch 1 - 2026-01-24 18:38

### Q1: Nested Workflow Step-Into
**Context**: The stepIn() method currently just delegates to stepNext(). For workflows that call sub-workflows (nested workflows), step-into could mean entering the sub-workflow's steps. This affects how users debug complex workflow hierarchies.
**Question**: Should step-into for nested workflows descend into sub-workflow steps, or should it stay at the current workflow level (same as step-next)?
**Options**:
- A: Descend into sub-workflows - stepping into a call-workflow step should pause at the first step of the called workflow
- B: Stay at current level - step-into behaves the same as step-next for all step types (current behavior)

**Answer**: *Pending*

### Q2: Error Recovery Strategy
**Context**: When a step fails during debugging, the session currently terminates if continueOnError is false. Users may want to retry failed steps, skip them, or modify variables before continuing.
**Question**: What error recovery options should be available when a step fails during a debug session?
**Options**:
- A: Minimal - Current behavior: step fails, workflow ends (unless continueOnError is true)
- B: Interactive - Pause on error, allow user to: 1) retry step, 2) skip step, 3) abort, or 4) modify variables then retry
- C: Resume support - Allow saving debug state to disk and resuming from the last successful step after fixing the issue

**Answer**: *Pending*

### Q3: Nested Variable Inspection
**Context**: The debug variable inspector can show top-level variables but cannot expand nested objects/arrays. The createChildReference() method currently returns 0 (no expansion), limiting inspection depth.
**Question**: Should nested object/array expansion be implemented for the Variables panel?
**Options**:
- A: Yes - Full expansion support for nested objects and arrays up to a reasonable depth limit
- B: Partial - Expand only one level deep (immediate children)
- C: No - Current behavior is sufficient; users can evaluate expressions in the debug console instead

**Answer**: *Pending*

### Q4: Step-Out Phase Behavior
**Context**: The stepOut() method is supposed to complete the current phase, but currently it just switches to 'run' mode. It doesn't track phase boundaries to pause at the next phase.
**Question**: What should step-out behavior be for workflow debugging?
**Options**:
- A: Complete current phase - Run remaining steps in phase, pause at first step of next phase
- B: Complete current call - If in a nested workflow, return to parent; if at top level, same as (A)
- C: Run to end - Continue execution without pausing (same as current 'run' behavior)

**Answer**: *Pending*

