# Clarifications

Questions and answers to clarify the feature specification.

## Batch 1 - 2026-01-24 23:57

### Q1: Error propagation strategy
**Context**: When the executor encounters a step error during debug mode, the behavior differs from normal execution. The debug adapter needs to decide how to surface errors - as DAP 'exception' stopped events, as output events, or both. This affects the error-analysis.ts integration and user experience.
**Question**: When a workflow step fails during a debug session, should the debugger pause at the failed step (like an exception breakpoint) automatically, or should it only pause if the user has explicitly enabled 'break on error' in their debug configuration?
**Options**:
- A: Always pause on step errors (exception-breakpoint style) - debugger stops at every failed step regardless of configuration
- B: Only pause if 'break on error' is enabled in launch config - matches standard DAP behavior where exception breakpoints are configurable
- C: Pause on errors by default, but allow disabling via launch config - safe default with opt-out

**Answer**: *Pending*

### Q2: Variable scope hierarchy
**Context**: The variables view needs to show step state, but workflow execution has multiple scopes: global workflow variables, phase-level context, step inputs/outputs, and action results. The DAP protocol supports variable scopes and hierarchical display. How these are organized affects both implementation complexity and user experience.
**Question**: How should variables be organized in the debug variables view? Should they be flat (all variables at one level) or hierarchical (grouped by scope: workflow globals, phase context, step inputs, step outputs, action results)?
**Options**:
- A: Hierarchical scopes - separate groups for Workflow, Phase, Step, and Action variables (richer but more complex)
- B: Flat with prefixes - all variables at one level with naming like 'step.input.X', 'workflow.Y' (simpler implementation)
- C: Two levels only - 'Inputs' and 'Outputs' for the current step, plus a 'Workflow' scope for globals (balanced approach)

**Answer**: *Pending*

### Q3: Replay integration scope
**Context**: The replay-controller.ts already exists for replay functionality. When wiring the debug adapter to the real executor, replay could either re-execute steps through the actual executor or use cached results. This significantly affects the implementation approach and whether replay works offline.
**Question**: Should the replay controller re-execute steps through the real executor (live replay) or use cached execution results from the history panel (recorded replay)? This determines whether replay requires the same environment as original execution.
**Options**:
- A: Live replay - re-execute through the real executor (requires same environment, but gets fresh results)
- B: Recorded replay - use cached results from history (works offline, but results may be stale)
- C: Both modes - default to recorded replay but allow switching to live replay (most flexible, more implementation work)

**Answer**: *Pending*

### Q4: Watch expression evaluation context
**Context**: Watch expressions need to evaluate against actual step state. The current watch-expressions.ts has placeholder evaluation. The question is what expression language/syntax to support - simple property access (step.output.field), JSONPath, or something more expressive. This affects how users interact with the debugger.
**Question**: What expression syntax should watch expressions support for evaluating step state? This determines how users can inspect nested workflow data during debugging.
**Options**:
- A: Simple dot-notation property access only (e.g., 'step.output.status') - easy to implement, limited power
- B: JSONPath expressions (e.g., '$.steps[*].output') - standard query syntax, moderate complexity
- C: JavaScript-like expressions with step context (e.g., 'step.output.items.filter(i => i.status)') - most powerful, hardest to sandbox safely

**Answer**: *Pending*

### Q5: Step-over granularity
**Context**: The 'Step Over' debug control needs to advance execution. In a workflow, stepping could mean advancing to the next step within the same phase, or to the next phase if at the end of a phase. The executor has both step-level and phase-level events. This affects how 'Step Into' and 'Step Out' map to the workflow hierarchy.
**Question**: What should 'Step Over', 'Step Into', and 'Step Out' mean in the workflow debugging context?
**Options**:
- A: Step Over = next step in same phase, Step Into = enter action detail, Step Out = skip to phase end
- B: Step Over = next step (any phase), Step Into = show action sub-steps, Step Out = skip to workflow end
- C: Step Over = next step (any phase), Step Into = enter nested workflow (if applicable), Step Out = complete current phase

**Answer**: *Pending*

