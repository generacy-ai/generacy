# Research: Template System Implementation

## Template Rendering Library Evaluation

### Selected: Handlebars

**Version**: `4.7.8` (latest stable)

**Rationale**:
- Full conditionals and loops support (`{{#if}}`, `{{#each}}`)
- Well-established (used by Ember.js, Ghost, and others)
- Works both Node.js (generacy-cloud) and browser (potential web UI preview)
- Active maintenance (last updated 2023)
- Nested property access: `{{project.id}}`
- Helper functions for custom logic

**Alternatives Considered**:
- **Mustache**: Too limited for conditional file inclusion logic
- **Template Literals**: Risk of code injection, requires escaping for YAML/JSON
- **Custom**: Unnecessary maintenance burden

---

## Existing Template Patterns

### Current Workflow Templates

Location: `/workspaces/generacy/packages/generacy-extension/resources/templates/`

**Files**:
- `basic.yaml` - Simple single-step workflow
- `multi-phase.yaml` - Multi-phase workflow with dependencies
- `with-triggers.yaml` - Workflow with trigger conditions

**Current Pattern**: Simple YAML files without variable substitution.

**Implication**: This is the first templating system in the repo. We're establishing the pattern for future templates.

---

## Docker Compose Reference Architecture

### Existing: tetrad-development/docker-compose.generacy.yml

**Key Patterns Observed**:

1. **Redis Configuration**:
   - Uses `redis:7-alpine` image
   - Volume: `generacy-redis-data:/data`
   - Command: `redis-server --appendonly yes` (persistence enabled)
   - **Decision for templates**: Use ephemeral Redis (no volume), override via Q14

2. **Worker Scaling**:
   - Uses `deploy.replicas: ${WORKER_COUNT:-3}`
   - Default: 3 workers
   - **Matches clarification Q9**: `workerCount: 3`

3. **Environment Variables**:
   - Uses `env_file` with `required: false` for optional config
   - Inline `environment` for required vars
   - **Template pattern**: Separate `.generacy/generacy.env` with fallback

4. **Networking**:
   - Internal network for Redis/orchestrator/workers
   - Shared network for tetrad-development coordination
   - **Template pattern**: Single internal network for user projects

5. **Healthchecks**:
   - All services have healthcheck definitions
   - Workers depend on Redis: `condition: service_healthy`
   - **Template pattern**: Include healthchecks for production readiness

6. **Worker Repo Cloning**:
   - Workers receive `REPO_URL` and `REPO_BRANCH` env vars
   - Clone independently (no shared volume)
   - **Matches clarification Q6**: No shared workspace volume

---

## Dev Container Feature Tag Strategy

### Current State

Workflow exists: `/workspaces/generacy/.github/workflows/publish-devcontainer-feature.yml`

**Not yet published** to GHCR (tracked in issue #252).

### Tagging Strategy

Based on clarification Q4:

| Branch | npm Tag | Feature Tag | Use Case |
|--------|---------|-------------|----------|
| `develop` | `@preview` | `:preview` | Early adopters, beta testers |
| `main` | `@latest` | `:1` | Stable production use |

**Template Implementation**:
```handlebars
"features": {
  "ghcr.io/generacy-ai/generacy/generacy:{{devcontainer.featureTag}}": {}
}
```

Where `featureTag` = `:1` (default) or `:preview` based on project `releaseStream` setting.

---

## Repository URL Normalization

### Chosen Format: Shorthand `owner/repo`

**Examples**:
- Input: `acme/main-api`
- Expanded (runtime): `https://github.com/acme/main-api.git`

**Normalization Function** (to be implemented):

```typescript
function normalizeRepoUrl(shorthand: string, token: string): string {
  // Handle variations:
  // - "owner/repo"
  // - "github.com/owner/repo"
  // - "https://github.com/owner/repo"
  // - "git@github.com:owner/repo.git"

  const match = shorthand.match(/(?:github\.com\/|git@github\.com:)?([^\/]+)\/([^\/\.]+)/);
  if (!match) throw new Error(`Invalid repo format: ${shorthand}`);

  const [, owner, repo] = match;
  return `https://github.com/${owner}/${repo}.git`;
}
```

**Why Not Store Full URLs?**
- Clarity: Developers think in terms of `owner/repo`
- Brevity: Config files stay clean and readable
- Flexibility: Easy to migrate to GitLab/Bitbucket later

---

## Template Package Structure

### Proposed: `@generacy-ai/templates`

**Location**: `/workspaces/generacy/packages/templates/`

**Package Exports**:

```json
{
  "name": "@generacy-ai/templates",
  "version": "1.0.0",
  "exports": {
    ".": "./dist/index.js",
    "./shared/*": "./dist/shared/*",
    "./single-repo/*": "./dist/single-repo/*",
    "./multi-repo/*": "./dist/multi-repo/*"
  }
}
```

**API**:

```typescript
import { renderTemplate, TemplateContext } from '@generacy-ai/templates';

// Render single template
const configYaml = await renderTemplate('shared/config.yaml.hbs', context);

// Render all templates for a project
const files = await renderProject(context);
// Returns: Map<string, string> (target path → file content)
```

### CLI Integration

The CLI will depend on `@generacy-ai/templates`:

```typescript
// generacy/packages/generacy-cli/src/commands/init.ts
import { renderProject } from '@generacy-ai/templates';

export async function init(options: InitOptions) {
  const context = await buildTemplateContext(options);
  const files = await renderProject(context);

  for (const [path, content] of files) {
    await writeFile(path, content);
  }
}
```

### Cloud Service Integration

generacy-cloud will also depend on the same package:

```typescript
// generacy-cloud/services/onboarding/pr-generator.ts
import { renderProject } from '@generacy-ai/templates';

export async function generateOnboardingPR(project: Project) {
  const context = buildTemplateContextFromProject(project);
  const files = await renderProject(context);

  // Create branch, commit files, open PR via GitHub API
  await createPRWithFiles(files);
}
```

**Key Benefit**: Single source of truth for templates. CLI and cloud service always generate identical output.

---

## Extensions.json Smart Merge

### Current VS Code Behavior

VS Code merges recommendations from:
1. Workspace `.vscode/extensions.json`
2. User settings
3. Extension pack dependencies

**Our Requirement**: Add Generacy extensions without losing user's existing recommendations.

### Implementation Strategy

**Option A**: Modify file in PR generation service
```typescript
async function mergeExtensionsJson(
  octokit: Octokit,
  repo: string,
  branch: string
): Promise<string> {
  let existing: ExtensionsJson | null = null;

  try {
    const { data } = await octokit.rest.repos.getContent({
      owner,
      repo,
      path: '.vscode/extensions.json',
      ref: branch
    });

    if ('content' in data) {
      const decoded = Buffer.from(data.content, 'base64').toString();
      existing = JSON.parse(decoded);
    }
  } catch (err) {
    // File doesn't exist, use template default
  }

  return JSON.stringify(mergeExtensions(existing), null, 2);
}
```

**Option B**: Client-side merge in PR instructions

Less reliable - requires user to manually add extensions.

**Selected**: Option A (automated merge in PR generation).

---

## .gitignore Strategy: Separate File

### Decision (from Q3): `.generacy/.gitignore`

**Content**:
```gitignore
# Generacy local environment (secrets, API keys)
generacy.env

# Agent state (logs, temp files)
.agent-state/
```

**Why Not Patch Root `.gitignore`?**
- Avoids conflicts with existing patterns
- No risk of duplicates
- Scoped to `.generacy/` directory
- Works with Git 2.x nested `.gitignore` (universal)

**Git Behavior**: Patterns in `.generacy/.gitignore` only apply to files within `.generacy/` directory.

---

## Handlebars Helpers

Custom helpers for common template operations:

```typescript
import Handlebars from 'handlebars';

// Register custom helpers
Handlebars.registerHelper('urlEncode', (str: string) => {
  return encodeURIComponent(str);
});

Handlebars.registerHelper('json', (obj: any) => {
  return JSON.stringify(obj, null, 2);
});

Handlebars.registerHelper('repoName', (shorthand: string) => {
  return shorthand.split('/')[1];
});

// Usage in templates:
// {{repoName repos.primary}} → "main-api"
// {{json project}} → Pretty-printed JSON
```

---

## Template Validation

### Pre-Render Validation

Check template context before rendering:

```typescript
import Ajv from 'ajv';
import schema from './schema.json';

const ajv = new Ajv();
const validate = ajv.compile(schema);

export function validateContext(context: unknown): TemplateContext {
  if (!validate(context)) {
    throw new Error(`Invalid template context: ${ajv.errorsText(validate.errors)}`);
  }
  return context as TemplateContext;
}
```

### Post-Render Validation

Validate rendered output:

```typescript
import yaml from 'js-yaml';

export function validateRenderedConfig(rendered: string): void {
  try {
    const parsed = yaml.load(rendered);

    // Check required fields
    if (!parsed.project?.id) {
      throw new Error('Missing project.id in rendered config');
    }

    // Validate structure
    // ...
  } catch (err) {
    throw new Error(`Invalid rendered config: ${err.message}`);
  }
}
```

---

## Testing Strategy

### Unit Tests

Test individual template rendering:

```typescript
describe('config.yaml template', () => {
  it('renders single-repo project', () => {
    const context = {
      project: { id: 'proj_123', name: 'Test' },
      repos: {
        primary: 'test/repo',
        dev: [],
        clone: [],
        hasDevRepos: false,
        hasCloneRepos: false,
        isMultiRepo: false
      },
      // ... rest of context
    };

    const rendered = renderTemplate('shared/config.yaml.hbs', context);
    const parsed = yaml.load(rendered);

    expect(parsed.project.id).toBe('proj_123');
    expect(parsed.orchestrator).toBeUndefined();
  });
});
```

### Integration Tests

Test full project rendering:

```typescript
describe('renderProject', () => {
  it('generates all files for multi-repo project', async () => {
    const files = await renderProject(multiRepoContext);

    expect(files.has('.generacy/config.yaml')).toBe(true);
    expect(files.has('.devcontainer/docker-compose.yml')).toBe(true);
    expect(files.size).toBe(6); // All expected files
  });
});
```

### Snapshot Tests

Verify rendered output consistency:

```typescript
it('matches snapshot for standard multi-repo config', () => {
  const rendered = renderTemplate('shared/config.yaml.hbs', standardContext);
  expect(rendered).toMatchSnapshot();
});
```
