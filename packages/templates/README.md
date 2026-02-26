# @generacy-ai/templates

Template system for generating onboarding PRs that add Generacy configuration and dev container setup to user repositories.

## Overview

This package provides a complete template rendering system for Generacy's onboarding flow. It generates all necessary configuration files to integrate Generacy into a developer's repository, including:

- **.generacy/config.yaml** - Project configuration and repository definitions
- **.generacy/generacy.env.template** - Environment variable template for local secrets
- **.devcontainer/devcontainer.json** - VS Code Dev Container configuration
- **.devcontainer/docker-compose.yml** - Multi-repo orchestration (multi-repo only)
- **.vscode/extensions.json** - VS Code extension recommendations
- **.generacy/.gitignore** - Ignored files (secrets, state)

Templates support both **single-repo** and **multi-repo** projects using [Handlebars](https://handlebarsjs.com/) for variable substitution and conditional logic.

## Installation

```bash
npm install @generacy-ai/templates
# or
pnpm add @generacy-ai/templates
# or
yarn add @generacy-ai/templates
```

## Quick Start

### Single-Repo Project

```typescript
import { buildSingleRepoContext, renderProject } from '@generacy-ai/templates';
import { writeFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';

// Build context for a single-repo project
const context = buildSingleRepoContext({
  projectId: 'proj_abc123',
  projectName: 'My API',
  primaryRepo: 'acme/main-api',
  releaseStream: 'stable',
});

// Render all templates
const files = await renderProject(context);

// Write files to disk
for (const [path, content] of files) {
  const fullPath = join(process.cwd(), path);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, 'utf-8');
}

console.log(`Generated ${files.size} files`);
```

### Multi-Repo Project

```typescript
import { buildMultiRepoContext, renderProject } from '@generacy-ai/templates';

// Build context for a multi-repo project
const context = buildMultiRepoContext({
  projectId: 'proj_xyz789',
  projectName: 'Acme Platform',
  primaryRepo: 'acme/orchestrator',
  devRepos: ['acme/api', 'acme/frontend'],
  cloneRepos: ['acme/shared-lib'],
  workerCount: 3,
});

// Render all templates
const files = await renderProject(context);

// Files will include docker-compose.yml for multi-repo orchestration
console.log('Generated files:', Array.from(files.keys()));
```

## Usage Scenarios

### CLI Scenario: `generacy init`

The CLI uses this package to scaffold Generacy configuration locally:

```typescript
import { quickSingleRepo, renderProject, validateAllRenderedFiles } from '@generacy-ai/templates';

async function initCommand(projectId: string, projectName: string, repo: string) {
  // Build context with defaults
  const context = quickSingleRepo(projectId, projectName, repo);

  // Render templates
  const files = await renderProject(context);

  // Validate all output
  validateAllRenderedFiles(files);

  // Write to disk (current directory)
  for (const [path, content] of files) {
    await writeFile(path, content);
    console.log(`✓ Created ${path}`);
  }

  console.log('\nGeneracy configuration initialized!');
  console.log('Next steps:');
  console.log('  1. Copy .generacy/generacy.env.template to .generacy/generacy.env');
  console.log('  2. Add your secrets (GITHUB_TOKEN, ANTHROPIC_API_KEY)');
  console.log('  3. Open in VS Code with Dev Containers extension');
}
```

### Cloud Service Scenario: PR Generation

The cloud service uses this package to generate PR content when projects are created:

```typescript
import { buildMultiRepoContext, renderProject, withGeneratedBy } from '@generacy-ai/templates';
import { Octokit } from '@octokit/rest';

async function createOnboardingPR(project: ProjectData) {
  // Build context from project data
  let context = buildMultiRepoContext({
    projectId: project.id,
    projectName: project.name,
    primaryRepo: project.primaryRepo,
    devRepos: project.devRepos,
    workerCount: project.workers,
  });

  // Tag as cloud-generated
  context = withGeneratedBy(context, 'generacy-cloud');

  // Render templates
  const files = await renderProject(context);

  // Create PR via GitHub API
  const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

  // Create branch
  await octokit.git.createRef({
    owner: project.owner,
    repo: project.repo,
    ref: `refs/heads/generacy-onboarding`,
    sha: project.mainBranchSha,
  });

  // Commit files
  for (const [path, content] of files) {
    await octokit.repos.createOrUpdateFileContents({
      owner: project.owner,
      repo: project.repo,
      path,
      message: `Add Generacy configuration`,
      content: Buffer.from(content).toString('base64'),
      branch: 'generacy-onboarding',
    });
  }

  // Create PR
  const pr = await octokit.pulls.create({
    owner: project.owner,
    repo: project.repo,
    title: 'Add Generacy Configuration',
    head: 'generacy-onboarding',
    base: project.baseBranch,
    body: generatePRDescription(files),
  });

  return pr.data.html_url;
}
```

## API Reference

### Context Builders

#### `buildSingleRepoContext(options: SingleRepoInput): TemplateContext`

Build template context for single-repository projects. Single-repo projects have only one repository (the primary repo) and use a direct dev container without Docker Compose.

**Parameters:**
- `projectId` (string) - Unique project identifier (e.g., "proj_abc123")
- `projectName` (string) - Human-readable project name
- `primaryRepo` (string) - Repository in "owner/repo" format
- `releaseStream` (optional) - "stable" | "preview" (default: "stable")
- `region` (optional) - AWS region (default: "us-west-2")
- `tier` (optional) - "free" | "pro" | "enterprise" (default: "pro")
- `baseImage` (optional) - Docker base image (default: "mcr.microsoft.com/devcontainers/typescript-node:20")

**Returns:** Validated `TemplateContext` ready for rendering

**Example:**
```typescript
const context = buildSingleRepoContext({
  projectId: 'proj_abc123',
  projectName: 'My API',
  primaryRepo: 'acme/main-api',
  releaseStream: 'stable',
  region: 'us-east-1',
  tier: 'enterprise',
});
```

#### `buildMultiRepoContext(options: MultiRepoInput): TemplateContext`

Build template context for multi-repository projects. Multi-repo projects have multiple development repositories and use Docker Compose with orchestrator/worker architecture.

**Parameters:**
- `projectId` (string) - Unique project identifier
- `projectName` (string) - Human-readable project name
- `primaryRepo` (string) - Primary repository in "owner/repo" format
- `devRepos` (string[]) - Development repositories (mounted read-write)
- `cloneRepos` (optional) - Clone-only repositories (mounted read-only, default: [])
- `workerCount` (optional) - Number of worker replicas (default: 2)
- `pollIntervalMs` (optional) - Worker poll interval (default: 5000)
- `releaseStream` (optional) - "stable" | "preview" (default: "stable")
- `region` (optional) - AWS region (default: "us-west-2")
- `tier` (optional) - "free" | "pro" | "enterprise" (default: "pro")
- `baseImage` (optional) - Docker base image (default: "mcr.microsoft.com/devcontainers/typescript-node:20")

**Returns:** Validated `TemplateContext` ready for rendering

**Example:**
```typescript
const context = buildMultiRepoContext({
  projectId: 'proj_xyz789',
  projectName: 'Acme Platform',
  primaryRepo: 'acme/orchestrator',
  devRepos: ['acme/api', 'acme/frontend'],
  cloneRepos: ['acme/shared-lib'],
  workerCount: 3,
  pollIntervalMs: 3000,
});
```

#### Quick Builders

For minimal projects with all defaults:

```typescript
// Single-repo with minimal config
const context = quickSingleRepo('proj_123', 'My App', 'acme/app');

// Multi-repo with minimal config
const context = quickMultiRepo(
  'proj_456',
  'Platform',
  'acme/orchestrator',
  ['acme/api', 'acme/frontend']
);
```

### Context Modifiers

Override specific fields after building context:

```typescript
import { withBaseImage, withBaseBranch, withOrchestrator, withGeneratedBy } from '@generacy-ai/templates';

// Change base image for language-specific projects
const pythonContext = withBaseImage(context, 'mcr.microsoft.com/devcontainers/python:3.11');

// Change default base branch
const developContext = withBaseBranch(context, 'develop');

// Tune orchestrator settings
const tunedContext = withOrchestrator(context, {
  workerCount: 5,
  pollIntervalMs: 3000,
});

// Tag as cloud-generated
const cloudContext = withGeneratedBy(context, 'generacy-cloud');
```

### Template Rendering

#### `renderProject(context: TemplateContext, existingFiles?: Map<string, string>): Promise<Map<string, string>>`

Render all templates for a project. Returns a Map of target file paths to rendered content.

**Parameters:**
- `context` - Template context containing all variables for rendering
- `existingFiles` (optional) - Map of existing file content for merging (e.g., extensions.json)

**Returns:** Map of target paths to rendered content

**Throws:** Error if any template fails to render or validate

**Example:**
```typescript
const files = await renderProject(context);

console.log(`Generated ${files.size} files`);
for (const [path, content] of files) {
  console.log(`  ${path}: ${content.length} bytes`);
}
```

#### `renderTemplate(templatePath: string, context: TemplateContext): Promise<string>`

Render a single template with context.

**Parameters:**
- `templatePath` - Path to template file (relative to templates directory)
- `context` - Template context object

**Returns:** Rendered template content

**Example:**
```typescript
const yaml = await renderTemplate('shared/config.yaml.hbs', context);
console.log(yaml);
```

#### `renderExtensionsJson(context: TemplateContext, existingContent?: string): Promise<string>`

Render extensions.json with smart merging. If existing extensions.json content is provided, merges Generacy extensions into the existing recommendations array. Otherwise, creates a new file.

**Parameters:**
- `context` - Template context
- `existingContent` (optional) - Existing extensions.json content

**Returns:** Rendered extensions.json content

**Example:**
```typescript
// Create new extensions.json
const newFile = await renderExtensionsJson(context);

// Merge with existing extensions.json
import { readFile } from 'fs/promises';
const existing = await readFile('.vscode/extensions.json', 'utf-8');
const merged = await renderExtensionsJson(context, existing);
```

### Validation

#### `validateContext(context: unknown): TemplateContext`

Validate template context against schema using Zod. Ensures all required fields are present and have correct types before rendering templates.

**Parameters:**
- `context` - Unknown context object to validate

**Returns:** Validated and typed `TemplateContext`

**Throws:** `ValidationError` with detailed error messages if validation fails

**Example:**
```typescript
try {
  const validContext = validateContext(userInput);
  // Safe to use validContext for rendering
} catch (error) {
  if (error instanceof ValidationError) {
    console.error('Validation failed:');
    error.errors.forEach(e => console.error(`  ${e.path}: ${e.message}`));
  }
}
```

#### Post-Render Validation

Validate rendered output to ensure templates produced valid files:

```typescript
import {
  validateRenderedConfig,
  validateRenderedDevContainer,
  validateRenderedDockerCompose,
  validateRenderedExtensionsJson,
  validateAllRenderedFiles,
  findUndefinedVariables,
} from '@generacy-ai/templates';

// Validate specific files
const configYaml = await renderTemplate('shared/config.yaml.hbs', context);
validateRenderedConfig(configYaml); // Throws if invalid

// Validate all files at once
const files = await renderProject(context);
validateAllRenderedFiles(files); // Throws on first validation error

// Check for undefined template variables
const rendered = await renderTemplate('config.yaml.hbs', context);
const undefined = findUndefinedVariables(rendered);
if (undefined.length > 0) {
  console.warn(`Template has undefined variables: ${undefined.join(', ')}`);
}
```

### Introspection

Get information about what templates will be rendered:

```typescript
import { selectTemplates, getTemplatePaths, getTargetPaths, getTemplateMapping } from '@generacy-ai/templates';

// Get template selection logic
const templates = selectTemplates(context);
console.log(`Will render ${templates.length} templates`);

// Get all template paths
const templatePaths = getTemplatePaths(context);
console.log('Templates:', templatePaths);

// Get all target paths
const targetPaths = getTargetPaths(context);
console.log('Will generate:', targetPaths);

// Get template-to-target mapping
const mapping = getTemplateMapping(context);
for (const [template, target] of mapping) {
  console.log(`${template} -> ${target}`);
}
```

## Template Context Schema

The complete context structure passed to templates:

```typescript
interface TemplateContext {
  project: {
    id: string;           // e.g., "proj_abc123"
    name: string;         // e.g., "My API"
  };

  repos: {
    isMultiRepo: boolean;
    primary: string;      // "owner/repo"
    dev: string[];        // ["owner/repo1", "owner/repo2"]
    clone: string[];      // ["owner/shared-lib"]
  };

  defaults: {
    region: string;       // "us-west-2"
    tier: string;         // "free" | "pro" | "enterprise"
    baseBranch: string;   // "main"
  };

  orchestrator?: {       // Multi-repo only
    workerCount: number;
    pollIntervalMs: number;
  };

  devcontainer: {
    baseImage: string;    // Docker image
    featureTag: string;   // Dev Container Feature version
  };

  metadata: {
    generatedAt: string;  // ISO 8601 timestamp
    generatedBy: string;  // "generacy-cli" | "generacy-cloud"
    schemaVersion: string; // "1.0"
  };
}
```

## Template Files

### Shared Templates (All Projects)

#### `.generacy/config.yaml`
**Template:** `src/shared/config.yaml.hbs`

Main Generacy configuration file. Contains project metadata, repository definitions, default settings, and optionally orchestrator configuration.

**Conditionals:**
- `repos.dev` and `repos.clone` arrays only rendered if non-empty
- `orchestrator` section only rendered if `repos.isMultiRepo` is true

#### `.generacy/generacy.env.template`
**Template:** `src/shared/generacy.env.template.hbs`

Environment variable template for local development secrets. Users copy this to `generacy.env` and fill in their credentials.

**Variables:**
- `GITHUB_TOKEN` - GitHub personal access token
- `ANTHROPIC_API_KEY` - Claude API key
- `PROJECT_ID` - Auto-filled from context
- `REDIS_URL` - Default for local dev
- `LOG_LEVEL` - Default logging level

#### `.vscode/extensions.json`
**Template:** `src/shared/extensions.json.hbs`

VS Code extension recommendations. Recommends Agency and Generacy extensions.

**Smart Merging:** When rendering with existing extensions.json, merges recommendations arrays and preserves other properties.

#### `.generacy/.gitignore`
**Static File:** `src/shared/.gitignore`

Ignores sensitive files:
- `generacy.env` (secrets)
- `.agent-state/` (runtime state)

### Single-Repo Templates

#### `.devcontainer/devcontainer.json`
**Template:** `src/single-repo/devcontainer.json.hbs`

Direct dev container configuration. Uses `image` field with base image and adds Generacy Dev Container Feature.

**Key Fields:**
- `name`: Project name
- `image`: Base Docker image
- `features`: Generacy feature reference
- `customizations.vscode.extensions`: Extension recommendations

### Multi-Repo Templates

#### `.devcontainer/devcontainer.json`
**Template:** `src/multi-repo/devcontainer.json.hbs`

Dev container configuration for Docker Compose orchestration. References `docker-compose.yml` and defines workspace folders for all repositories.

**Key Fields:**
- `name`: Project name
- `dockerComposeFile`: Reference to docker-compose.yml
- `service`: "orchestrator"
- `workspaceFolder`: Primary repo path
- `workspaceFolders`: All repos as multi-root workspace

#### `.devcontainer/docker-compose.yml`
**Template:** `src/multi-repo/docker-compose.yml.hbs`

Docker Compose orchestration for multi-repo projects.

**Services:**
- `redis`: Ephemeral Redis for task queue
- `orchestrator`: Primary service with Generacy feature (mounts all repos)
- `worker`: Scaled service with configurable replica count

**Loops:**
- Workspace mounts: `{{#each repos.dev}}...{{/each}}`
- Clone mounts: `{{#each repos.clone}}...{{/each}}`

## Handlebars Helpers

Custom helpers available in all templates:

### `repoName`
Extract repository name from "owner/repo" format.

```handlebars
{{repoName "acme/api"}}
<!-- Output: api -->
```

### `json`
Pretty-print objects as JSON (useful for debugging).

```handlebars
{{json repos}}
<!-- Output: formatted JSON -->
```

### `urlEncode`
URL-encode strings.

```handlebars
{{urlEncode project.name}}
<!-- Output: URL-encoded name -->
```

## Generated File Structure

### Single-Repo Project
```
.generacy/
├── config.yaml              # 5 files total
├── generacy.env.template
└── .gitignore

.devcontainer/
└── devcontainer.json

.vscode/
└── extensions.json
```

### Multi-Repo Project
```
.generacy/
├── config.yaml              # 6 files total
├── generacy.env.template
└── .gitignore

.devcontainer/
├── devcontainer.json
└── docker-compose.yml       # Additional file for orchestration

.vscode/
└── extensions.json
```

## Error Handling

The package provides detailed error messages for common issues:

### Validation Errors

```typescript
import { ValidationError } from '@generacy-ai/templates';

try {
  const context = buildSingleRepoContext({ /* ... */ });
} catch (error) {
  if (error instanceof ValidationError) {
    // Access structured errors
    error.errors.forEach(e => {
      console.log(`${e.path}: ${e.message}`);
    });
  }
}
```

### Template Rendering Errors

```typescript
try {
  const files = await renderProject(context);
} catch (error) {
  // Clear error messages with template name and line numbers
  console.error(error.message);
}
```

### Post-Render Validation Errors

```typescript
try {
  validateRenderedConfig(configYaml);
} catch (error) {
  // Errors include YAML/JSON parsing details
  console.error(error.message);
}
```

## Troubleshooting

### Problem: Rendered templates contain `{{undefined}}`

**Cause:** Template variable not provided in context.

**Solution:** Check that all required fields are present in your context. Use `findUndefinedVariables()` to detect these:

```typescript
const rendered = await renderTemplate('config.yaml.hbs', context);
const undefined = findUndefinedVariables(rendered);
if (undefined.length > 0) {
  console.warn(`Missing variables: ${undefined.join(', ')}`);
}
```

### Problem: YAML parsing error after rendering

**Cause:** Template produced invalid YAML (often indentation issues).

**Solution:** Use post-render validation to catch this early:

```typescript
const yaml = await renderTemplate('shared/config.yaml.hbs', context);
validateRenderedConfig(yaml); // Throws with line number
```

### Problem: Extensions.json merge not working

**Cause:** Existing extensions.json has invalid JSON syntax.

**Solution:** Ensure existing file is valid JSON before merging:

```typescript
try {
  const existing = await readFile('.vscode/extensions.json', 'utf-8');
  JSON.parse(existing); // Validate first
  const merged = await renderExtensionsJson(context, existing);
} catch (error) {
  console.error('Existing extensions.json is invalid:', error.message);
}
```

### Problem: Multi-repo templates not including all repos

**Cause:** Repos not specified in context.

**Solution:** Ensure `devRepos` and `cloneRepos` are provided:

```typescript
const context = buildMultiRepoContext({
  projectId: 'proj_123',
  projectName: 'Platform',
  primaryRepo: 'acme/orchestrator',
  devRepos: ['acme/api', 'acme/frontend'], // Required for multi-repo
  cloneRepos: ['acme/shared-lib'],         // Optional
});
```

## Testing

The package includes comprehensive tests:

```bash
# Run all tests
pnpm test

# Run tests in watch mode
pnpm test:watch

# Generate coverage report
pnpm test:coverage
```

**Test Coverage:**
- Unit tests for renderer, validators, builders
- Integration tests for full rendering flow
- Snapshot tests for template output stability
- Edge case tests for error conditions

**Coverage Target:** ≥80% across all source files

## Development

### Building

```bash
# Build TypeScript to dist/
pnpm build

# Watch mode for development
pnpm dev
```

### Adding New Templates

1. Create template file in `src/shared/`, `src/single-repo/`, or `src/multi-repo/`
2. Update `selectTemplates()` in `renderer.ts` to include new template
3. Add target path mapping in `renderProject()`
4. Add post-render validation if needed
5. Add snapshot test for new template
6. Update README with template documentation

### Modifying Context Schema

1. Update Zod schemas in `schema.ts`
2. Update TypeScript types (auto-generated from Zod)
3. Update context builders in `builders.ts`
4. Update test fixtures
5. Update README schema documentation
6. Run snapshot tests and update if needed

## Contributing

Contributions are welcome! Please follow these guidelines:

1. **Code Style:** Follow existing TypeScript conventions
2. **Tests:** Add tests for all new functionality (maintain ≥80% coverage)
3. **Snapshots:** Update snapshots when template output intentionally changes
4. **Documentation:** Update README for API changes
5. **Type Safety:** All public APIs must be fully typed

### Commit Messages

Follow Conventional Commits:
- `feat:` New features
- `fix:` Bug fixes
- `docs:` Documentation updates
- `test:` Test additions/changes
- `refactor:` Code refactoring

## License

MIT

## Related Packages

- **@generacy-ai/cli** - CLI tool that consumes this package for `generacy init`
- **@generacy-ai/cloud** - Cloud service that generates onboarding PRs

## Support

- **Issues:** https://github.com/generacy-ai/generacy/issues
- **Documentation:** https://docs.generacy.ai
- **Discord:** https://discord.gg/generacy
