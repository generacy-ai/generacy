# Research: Onboarding Slash Command Suite

**Feature**: `382-phase-4-2-cloud` | **Date**: 2026-03-14

## Technology Decisions

### TD-1: Two-Layer Plugin Architecture

**Decision**: Implement as `agency-plugin-onboard` (MCP server) + `claude-plugin-agency-onboard` (Claude Code plugin), following the speckit pattern.

**Rationale**: The speckit commands (`/speckit:specify`, `/speckit:clarify`, etc.) use this exact architecture successfully. MCP tools provide reusable functionality callable from any MCP client, while Claude Code command `.md` files provide the interactive UX layer. This separation means the tools can be used by other systems (e.g., the orchestrator's phase loop) without being tied to Claude Code.

**Alternatives considered**:
- **Raw `.claude/commands/` files in cluster-base**: Simpler but loses versioning, marketplace distribution, and MCP reusability. Would require manual updates across all projects.
- **Single package with both tools and commands**: Couples MCP and Claude Code concerns. The speckit precedent shows keeping them separate is cleaner for maintenance and distribution.

### TD-2: Stack Detection Strategy

**Decision**: File-based heuristic detection using known indicators (file extensions, dependency files, config files).

**Rationale**: No need for complex AST parsing or build system execution. Checking for `package.json`, `go.mod`, `Cargo.toml`, `requirements.txt`, etc. covers the vast majority of projects accurately. This is what tools like GitHub Linguist and dependabot use.

**Implementation pattern**:
```typescript
interface StackDetector {
  name: string;
  detect(projectRoot: string): Promise<DetectionResult>;
}

// Each detector checks for specific signals
const languageDetector: StackDetector = {
  name: 'language',
  async detect(root) {
    const signals: DetectionResult = { languages: [] };
    if (await fileExists(join(root, 'package.json'))) {
      signals.languages.push({ name: 'TypeScript/JavaScript', confidence: 'high' });
    }
    if (await fileExists(join(root, 'go.mod'))) {
      signals.languages.push({ name: 'Go', confidence: 'high' });
    }
    // ... more checks
    return signals;
  }
};
```

**Alternatives considered**:
- **GitHub Linguist API**: Requires GitHub API call, doesn't detect frameworks/tools, only languages.
- **AST parsing**: Over-engineered for detection; checking file existence is sufficient and much faster.

### TD-3: YAML for Stack Output

**Decision**: Write stack detection results to `.generacy/stack.yaml` using the `yaml` npm package.

**Rationale**: The `.generacy/` directory already contains structured YAML files (`config.yaml`, `cluster.yaml`). YAML is human-readable and machine-parseable. Other onboarding commands (`/onboard:plugins`, `/onboard:mcp`) need to programmatically consume the detected stack to make recommendations.

**Key sources**: Existing `.generacy/cluster.yaml` structure in cluster-base repo.

### TD-4: Traffic-Light Scoring for Readiness

**Decision**: Use red/yellow/green per category (environment, configuration, permissions, documentation) with overall status = worst category.

**Rationale**: Percentage-based scoring (0-100%) creates false precision — what's the difference between 72% and 78% readiness? Traffic lights give clear, actionable signals: green = good, yellow = workable but should improve, red = blocker. Worst-category-wins for overall status is conservative and prevents users from ignoring critical gaps.

**Implementation pattern**:
```typescript
type TrafficLight = 'green' | 'yellow' | 'red';

interface CategoryResult {
  status: TrafficLight;
  checks: CheckResult[];
  summary: string;
}

interface ReadinessReport {
  overall: TrafficLight;  // = worst of all categories
  categories: {
    environment: CategoryResult;
    configuration: CategoryResult;
    permissions: CategoryResult;
    documentation: CategoryResult;
  };
  nextSteps: string[];
}
```

### TD-5: Hardcoded Catalogs with Extensibility Path

**Decision**: Ship with hardcoded plugin catalog (6 plugins) and MCP server recommendation map (3 servers). MCP catalog extensible via `.generacy/mcp-servers.yaml`.

**Rationale**: No marketplace API exists yet. The 6 plugins (`git`, `npm`, `docker`, `firebase`, `humancy`, `spec-kit`) are the only known plugins. Similarly, only 3 MCP servers are in active use (`agency`, `playwright`, `vscode-mcp-server`). Hardcoding now with a clear TODO for dynamic discovery is pragmatic.

**Extension mechanism for MCP servers**:
```yaml
# .generacy/mcp-servers.yaml (optional, per-project)
servers:
  - name: custom-db-server
    package: "@company/mcp-db"
    recommend_when:
      - "postgresql"
      - "mysql"
    description: "Database query and migration tools"
```

### TD-6: GitHub API for Backlog Population

**Decision**: Use `@octokit/rest` (already available in the agency monorepo) for creating GitHub issues in `/onboard:backlog`.

**Rationale**: The speckit plugin already uses Octokit for GitHub operations (`tasks-to-issues` tool). Reusing the same dependency and auth pattern (GitHub token from environment) keeps things consistent.

**Batch approval pattern**: Present issues in groups of 3-5 for user review, creating only approved issues. This prevents overwhelming users with a wall of suggested issues.

## Implementation Patterns

### Pattern 1: Tool Structure

Follow the speckit tool pattern — each tool is a standalone module exporting a tool definition:

```typescript
// tools/evaluate-readiness.ts
import { z } from 'zod';
import type { ToolDefinition } from '@generacy-ai/agency';

export const evaluateReadiness: ToolDefinition = {
  name: 'evaluate_readiness',
  description: 'Assess project onboarding readiness with traffic-light scoring',
  inputSchema: z.object({
    projectRoot: z.string().describe('Path to the project root directory'),
  }),
  async execute({ projectRoot }) {
    // ... implementation
  },
};
```

### Pattern 2: Command Markdown Structure

Follow speckit command `.md` file pattern with YAML frontmatter:

```markdown
---
name: onboard-evaluate
description: Assess project onboarding readiness
---

# Onboard Evaluate

## Instructions
1. Call the `evaluate_readiness` MCP tool with the current project root
2. Present the readiness report to the user...
```

### Pattern 3: Idempotent File Writing

All commands that write config files use merge semantics:

```typescript
async function mergeYaml(filePath: string, updates: Record<string, unknown>) {
  const existing = await readYamlSafe(filePath); // returns {} if not found
  const merged = deepMerge(existing, updates);
  await writeYaml(filePath, merged);
}
```

### Pattern 4: Detector Composition

Stack detection uses a pipeline of independent detectors that can run in parallel:

```typescript
const detectors = [languageDetector, frameworkDetector, buildToolDetector,
                    testingDetector, ciCdDetector, infrastructureDetector];

const results = await Promise.all(
  detectors.map(d => d.detect(projectRoot))
);

const stack = mergeDetectionResults(results);
```

## Key Sources & References

- **Speckit plugin pattern**: `/workspaces/agency/packages/agency-plugin-spec-kit/` — tool structure, plugin class, manifest
- **Claude plugin pattern**: `/workspaces/agency/packages/claude-plugin-agency-spec-kit/` — command `.md` files, plugin.json
- **Existing `.generacy/` conventions**: `/workspaces/cluster-base/.generacy/` — config.yaml, cluster.yaml structure
- **Phase 4 architecture**: `/workspaces/tetrad-development/docs/cloud-platform-buildout-reference.md` — onboarding command descriptions, conversation proxy integration

## Open Questions

All design questions were resolved in `clarifications.md`. No remaining open questions.

---

*Generated by speckit*
