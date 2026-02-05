# Research: Speckit as Generacy Workflow Actions

## Technology Decisions

### TD-001: Hybrid Implementation Strategy

**Decision**: Use library calls for deterministic operations and agent.invoke for AI-dependent operations.

**Context**: The spec proposed two options:
- Option A: Wrap existing MCP tools (agent invokes speckit MCP server)
- Option B: Port logic directly (copy speckit code into Generacy)

**Analysis**:
- Option A is simpler but slower - each call requires MCP server spin-up and JSON serialization
- Option B is faster but creates code duplication and maintenance burden
- Speckit operations fall into two categories:
  1. **Deterministic**: `create_feature`, `get_paths`, `check_prereqs`, `copy_template` - pure TypeScript logic
  2. **AI-dependent**: `specify`, `clarify`, `plan`, `tasks`, `implement` - require LLM capabilities

**Selected**: Option C (Hybrid)
- Port deterministic operations directly for speed and reliability
- Use agent.invoke for AI operations (no need to duplicate LLM prompting)

**Trade-offs**:
- (+) Fast deterministic operations (no MCP overhead)
- (+) Clean separation of concerns
- (+) AI operations benefit from Claude Code's full context
- (-) Code duplication for deterministic operations
- (-) Requires keeping ported code in sync with upstream

### TD-002: Single ActionType with Dispatch Pattern

**Decision**: Implement one `speckit` ActionType that internally routes to operations.

**Context**: Adding 6+ individual ActionTypes would more than double the current union.

**Alternatives Considered**:
1. **Separate ActionTypes**: `speckit.create_feature`, `speckit.specify`, etc. as individual union members
2. **Single ActionType**: One `speckit` type with operation dispatch

**Analysis**:
- The ActionType union impacts type checking throughout the codebase
- Existing patterns suggest actions can handle multiple related operations
- Step YAML already supports dotted notation (`uses: speckit.create_feature`)

**Selected**: Single ActionType
- Parse dotted notation to extract operation: `speckit.create_feature` → `type=speckit, op=create_feature`
- SpecKitAction class handles dispatch internally

**Implementation Pattern**:
```typescript
// parseActionType already handles dotted notation
// speckit.create_feature → extracts 'speckit' as type
// Operation extracted separately in SpecKitAction

class SpecKitAction extends BaseAction {
  readonly type: ActionType = 'speckit';

  protected extractOperation(step: StepDefinition): string {
    const uses = step.uses || step.action || '';
    // 'speckit.create_feature' → 'create_feature'
    // 'speckit/specify' → 'specify'
    const match = uses.match(/^speckit[./](.+)$/);
    return match?.[1] || '';
  }
}
```

### TD-003: Gate Implementation via StepDefinition Field

**Decision**: Add `gate` field to StepDefinition for review checkpoints.

**Context**: The spec shows gate syntax on steps, but current schema lacks this field.

**Alternatives Considered**:
1. **New StepDefinition field**: Add `gate?: string` to step schema
2. **Separate humancy.request_review step**: Use existing action after each gated step

**Analysis**:
- Option 1 is cleaner YAML but requires schema changes
- Option 2 works today but doubles step count and is verbose

**Selected**: StepDefinition field
- Cleaner authoring experience
- Single step expresses "do X, then wait for Y review"
- Integrates with executor's step completion logic

**Schema Change**:
```typescript
// types/workflow.ts
interface StepDefinition {
  // ... existing fields ...
  gate?: string;  // e.g., 'clarification-review', 'plan-review'
}

// loader/schema.ts
const StepDefinitionSchema = z.object({
  // ... existing fields ...
  gate: z.string().optional(),
});
```

**Executor Integration**:
```typescript
// After step.execute()
if (step.gate) {
  await this.handleGate(step.gate, context);
}
```

### TD-004: Static Workflow Templates

**Decision**: Provide static YAML files that users copy and customize.

**Context**: Spec mentions 3 templates without specifying delivery mechanism.

**Alternatives Considered**:
1. **Static YAML files**: Place in `workflows/` directory for manual copying
2. **Template system**: Implement `generacy init --template speckit-feature` with variable substitution

**Analysis**:
- Template system is more user-friendly but requires significant infrastructure
- Static files work immediately and are easily modified
- Users can inspect examples directly without special tooling

**Selected**: Static YAML files
- Place in `workflows/` directory at package root
- Document in README with copy instructions
- Future: Add template system in separate feature

## Implementation Patterns

### Pattern 1: Operation Dispatch

```typescript
// SpecKitAction handles all speckit.* operations
class SpecKitAction extends BaseAction {
  async executeInternal(step, context) {
    const op = this.extractOperation(step);

    switch (op) {
      case 'create_feature':
        return this.createFeature(step, context);
      case 'specify':
        return this.specify(step, context);
      // ...
    }
  }

  // Deterministic - direct library call
  private async createFeature(step, context) {
    const input = this.getInput<CreateFeatureInput>(step, context, 'with');
    const result = await createFeatureLib(input);
    return this.successResult(result);
  }

  // AI-dependent - agent.invoke delegation
  private async specify(step, context) {
    const featureDir = this.getRequiredInput(step, context, 'feature_dir');
    const prompt = this.buildSpecifyPrompt(featureDir);

    // Delegate to Claude Code via agent.invoke
    const agentResult = await this.invokeAgent(context, {
      prompt,
      timeout: 300,
      workdir: featureDir,
    });

    return this.successResult({
      spec_file: join(featureDir, 'spec.md'),
      summary: agentResult.summary,
    });
  }
}
```

### Pattern 2: Porting Speckit Library Code

When porting from speckit MCP, follow this pattern:

```typescript
// Original MCP tool (returns MCP response format)
// Source: /workspaces/claude-plugins/plugins/speckit/mcp-server/src/tools/feature.ts
export function registerCreateFeature(server: McpServer) {
  server.tool('create_feature', ..., async (params) => {
    // ... implementation ...
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });
}

// Ported library function (returns typed result directly)
// Target: packages/workflow-engine/src/actions/builtin/speckit/lib/feature.ts
export async function createFeature(params: CreateFeatureInput): Promise<CreateFeatureResult> {
  // Same implementation, but return typed result
  return {
    success: true,
    branch_name: branchName,
    feature_dir: featureDir,
    // ...
  };
}
```

### Pattern 3: Agent Prompt Composition

For AI-dependent operations, compose prompts with context:

```typescript
private buildSpecifyPrompt(featureDir: string): string {
  return `
Generate a comprehensive feature specification.

Feature directory: ${featureDir}
Spec file: ${join(featureDir, 'spec.md')}

Instructions:
1. Read any existing spec.md if present
2. Analyze the feature description
3. Generate user stories with acceptance criteria
4. Define functional requirements
5. Document assumptions and out-of-scope items

Write the specification to spec.md in the feature directory.
`;
}
```

## Alternatives Rejected

### Rejected: Direct MCP Server Communication

**Proposal**: Have Generacy actions communicate directly with speckit MCP server.

**Why Rejected**:
- Adds MCP server as runtime dependency
- Requires server process management
- JSON serialization overhead for every call
- More complex error handling

### Rejected: Forking Speckit as Separate Package

**Proposal**: Fork speckit into `@generacy/speckit` as independent package.

**Why Rejected**:
- Creates maintenance burden for two codebases
- Complicates version synchronization
- Hybrid approach achieves same benefits with less duplication

### Rejected: gates as Separate Actions

**Proposal**: Require explicit `humancy.request_review` step after each gated action.

**Why Rejected**:
- Doubles step count for gated workflows
- Verbose YAML that obscures intent
- Gate concept is tightly coupled to step completion

## Key Sources

| Source | Used For |
|--------|----------|
| `/workspaces/claude-plugins/plugins/speckit/mcp-server/src/` | Reference implementation for porting |
| `/workspaces/generacy/packages/workflow-engine/src/actions/` | Existing action patterns |
| `/workspaces/generacy/packages/workflow-engine/src/types/` | Type definitions |
| Clarifications Q1-Q5 | Technical decision guidance |

## Open Questions

1. **Gate timeout behavior**: What happens if review times out? Auto-approve? Auto-reject? Block indefinitely?
   - *Recommendation*: Block indefinitely by default, with optional timeout parameter

2. **Speckit MCP version alignment**: How to handle upstream speckit changes?
   - *Recommendation*: Document version baseline; update ported code periodically

3. **Error recovery in AI operations**: If agent.invoke fails mid-task, how to resume?
   - *Recommendation*: Track task progress externally; support retry from last checkpoint

---

*Generated by speckit*
