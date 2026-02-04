# Clarifications

Questions and answers to clarify the feature specification.

## Batch 1 - 2026-02-04 20:18

### Q1: Action wrapping mechanism
**Context**: The existing action system uses BaseAction subclasses with executeInternal(). The spec proposes wrapping MCP tools, but the speckit MCP server runs as a separate process. How actions invoke MCP tools needs to be defined to avoid architectural issues.
**Question**: Should speckit actions invoke the MCP tools via the existing agent.invoke action (delegating to Claude Code which has MCP access), or should they directly call speckit logic by importing it as a library dependency?
**Options**:
- A: Use agent.invoke - each speckit action composes a prompt and delegates to Claude Code CLI, which calls speckit MCP tools. Simpler but slower and less deterministic.
- B: Import speckit as a library - add speckit as a package dependency and call its functions directly from action code. Faster and deterministic but requires speckit to export a programmatic API.
- C: Hybrid - use library calls for deterministic operations (create_feature, get_paths) and agent.invoke for AI-dependent steps (specify, plan, implement).

**Answer**: *Pending*

### Q2: Gate field in workflow schema
**Context**: The spec shows gate: clarification-review on steps, but the current StepDefinition schema in loader/schema.ts has no gate field. Adding this requires schema changes to the workflow engine.
**Question**: Should the gate/review checkpoint mechanism be implemented as a new field on StepDefinition, or should it use the existing humancy.request_review action as a separate step?
**Options**:
- A: Add gate field to StepDefinition schema - cleaner YAML syntax but requires workflow engine schema changes.
- B: Use humancy.request_review as a separate step after each gated action - works with existing schema, more verbose YAML.

**Answer**: *Pending*

### Q3: ActionType registration approach
**Context**: The current ActionType is a string union with 6 types. Adding 6+ speckit action types would more than double the union. The parseActionType function needs to handle these.
**Question**: Should each speckit operation (create_feature, specify, clarify, plan, tasks, implement) be a separate ActionType, or should there be a single speckit ActionType that dispatches internally based on a sub-action parameter?
**Options**:
- A: Separate ActionTypes - speckit.create_feature, speckit.specify, etc. Each gets its own handler class. More files but follows existing pattern.
- B: Single speckit ActionType with sub-action dispatching - one SpecKitAction class that routes internally. Fewer files but deviates from current 1:1 pattern.

**Answer**: *Pending*

### Q4: Dependency on issue 155
**Context**: The spec lists a dependency on #155 (@generacy-ai/generacy npm package) but the package already exists at packages/generacy/. It's unclear what from #155 is actually blocking this work.
**Question**: What specific capability from issue #155 is required before implementing speckit actions? Is it already available, or is there a blocking dependency?

**Answer**: *Pending*

### Q5: Scope of workflow templates
**Context**: The spec lists 3 workflow templates (feature, epic, bugfix) but doesn't specify whether these are just YAML files in the workflows/ directory or if they need a template discovery/instantiation mechanism.
**Question**: Are the workflow templates just static YAML files that users copy and customize, or do they need a templating system with variable substitution and a discovery mechanism (e.g., generacy init --template speckit-feature)?
**Options**:
- A: Static YAML files in workflows/ directory - users copy and modify them. Simple, no new infrastructure needed.
- B: Template system with generacy init --template - requires template registry, variable substitution, and CLI integration. More useful but more work.

**Answer**: *Pending*

