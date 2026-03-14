# Data Model: Onboarding Slash Command Suite

**Feature**: `382-phase-4-2-cloud` | **Date**: 2026-03-14

## Core Types

### Readiness Assessment (`/onboard:evaluate`)

```typescript
type TrafficLight = 'green' | 'yellow' | 'red';

interface CheckResult {
  name: string;            // e.g., "Node.js version"
  status: TrafficLight;
  detail: string;          // e.g., "v20.11.0 detected (≥20 required)"
  fix?: string;            // e.g., "Install Node.js 20+ via nvm"
}

interface CategoryResult {
  status: TrafficLight;    // worst of all checks in category
  checks: CheckResult[];
  summary: string;         // one-line category summary
}

interface ReadinessReport {
  overall: TrafficLight;   // worst of all categories
  categories: {
    environment: CategoryResult;
    configuration: CategoryResult;
    permissions: CategoryResult;
    documentation: CategoryResult;
  };
  nextSteps: string[];     // ordered recommendations
  timestamp: string;       // ISO 8601
}
```

### Stack Detection (`/onboard:stack`)

```typescript
type Confidence = 'high' | 'medium' | 'low';

interface DetectedItem {
  name: string;            // e.g., "TypeScript", "React", "vitest"
  version?: string;        // e.g., "5.3.2" (from package.json, go.mod, etc.)
  confidence: Confidence;
  source: string;          // e.g., "package.json", "tsconfig.json"
}

interface DetectionResult {
  languages: DetectedItem[];
  frameworks: DetectedItem[];
  buildTools: DetectedItem[];
  testing: DetectedItem[];
  ciCd: DetectedItem[];
  infrastructure: DetectedItem[];
  packageManager?: string;  // npm | pnpm | yarn | bun
  monorepo?: boolean;       // detected via workspaces, turbo.json, nx.json
}
```

### Stack YAML Output Schema (`.generacy/stack.yaml`)

```yaml
# .generacy/stack.yaml
version: "1"

languages:
  - name: TypeScript
    version: "5.3.2"
    confidence: high

frameworks:
  - name: React
    version: "18.2.0"
    confidence: high
  - name: Next.js
    version: "14.1.0"
    confidence: high

buildTools:
  - name: turbo
    version: "1.12.0"
    confidence: high
  - name: pnpm
    version: "8.15.0"
    confidence: high

testing:
  - name: vitest
    version: "1.2.0"
    confidence: high

ciCd:
  - name: GitHub Actions
    confidence: high

infrastructure:
  - name: Docker
    confidence: high
  - name: Firebase
    version: "13.0.0"
    confidence: high
  - name: Redis
    confidence: medium

packageManager: pnpm
monorepo: true
detectedAt: "2026-03-14T10:30:00Z"
```

### Plugin Catalog (`/onboard:plugins`)

```typescript
interface PluginDefinition {
  id: string;              // e.g., "git", "npm", "docker"
  name: string;            // e.g., "Git Plugin"
  description: string;
  packageName: string;     // e.g., "@generacy-ai/agency-plugin-git"
  stackSignals: string[];  // stack.yaml keys that trigger recommendation
  alwaysRecommend: boolean;
  configSchema?: z.ZodType; // plugin-specific config schema
}

interface PluginSelection {
  pluginId: string;
  enabled: boolean;
  config?: Record<string, unknown>;
}
```

### MCP Server Catalog (`/onboard:mcp`)

```typescript
interface McpServerDefinition {
  id: string;              // e.g., "playwright", "agency"
  name: string;            // e.g., "Playwright MCP"
  description: string;
  command: string;          // e.g., "npx"
  args: string[];           // e.g., ["@anthropic/mcp-playwright"]
  stackSignals: string[];  // stack.yaml keys that trigger recommendation
  alwaysRecommend: boolean;
}

interface McpJsonEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

// Output: .mcp.json
interface McpConfig {
  mcpServers: Record<string, McpJsonEntry>;
}
```

### Architecture Analysis (`/onboard:architecture`)

```typescript
interface ArchitectureSection {
  title: string;
  content: string;         // markdown content
}

interface ArchitectureDoc {
  projectName: string;
  overview: string;
  sections: ArchitectureSection[];  // e.g., "Project Structure", "Key Modules", "Data Flow"
  patterns: string[];       // detected patterns (e.g., "monorepo", "microservices")
  decisions: string[];      // key design decisions
}
```

### Backlog Issue (`/onboard:backlog`)

```typescript
type IssueCategory = 'testing' | 'documentation' | 'tech-debt' | 'feature' | 'ci-cd' | 'security';

interface SuggestedIssue {
  title: string;
  body: string;            // markdown
  labels: string[];
  category: IssueCategory;
  priority: 'high' | 'medium' | 'low';
  source: string;          // what triggered the suggestion (e.g., "missing tests for src/services/")
}

interface IssueBatch {
  issues: SuggestedIssue[];
  batchNumber: number;
  totalBatches: number;
}

interface CreatedIssue {
  number: number;
  title: string;
  url: string;
}
```

## Validation Rules

| Type | Rule | Enforcement |
|------|------|-------------|
| `TrafficLight` | Must be `'green' \| 'yellow' \| 'red'` | Zod enum |
| `Confidence` | Must be `'high' \| 'medium' \| 'low'` | Zod enum |
| `stack.yaml version` | Must be `"1"` | Zod literal |
| `DetectedItem.name` | Non-empty string | Zod min(1) |
| `SuggestedIssue.title` | Max 256 characters | Zod max(256) |
| `PluginDefinition.id` | Lowercase alphanumeric + hyphens | Zod regex |
| `McpServerDefinition.command` | Non-empty string | Zod min(1) |

## Entity Relationships

```
ReadinessReport
  └── CategoryResult[]
        └── CheckResult[]

DetectionResult (→ stack.yaml)
  ├── consumed by → PluginDefinition.stackSignals (matching)
  └── consumed by → McpServerDefinition.stackSignals (matching)

PluginSelection[]  → .generacy/config.yaml (plugins section)
McpJsonEntry{}     → .mcp.json (mcpServers section)

SuggestedIssue[]  → GitHub Issues (via Octokit)
```

---

*Generated by speckit*
