# Implementation Plan: Remove `@generacy-ai/templates` Package

**Branch**: `296-summary-generacy-ai-templates` | **Date**: 2026-03-04 | **Status**: Draft

## Summary

Remove the superseded `packages/templates/` package and migrate the `generacy init` command to fetch devcontainer files from the external `cluster-templates` GitHub repository via tarball download. CLI-generated files (config.yaml, env template, gitignore, extensions.json) are re-implemented inline without Handlebars.

## Technical Context

- **Language**: TypeScript (ESM, ES2022 target)
- **Runtime**: Node.js ≥20
- **Package manager**: pnpm with workspace protocol
- **Test framework**: Vitest
- **Affected packages**: `packages/generacy` (CLI), `packages/templates` (removed)
- **Dependencies removed**: `handlebars`, `js-yaml` (from templates), `zod` (from templates)
- **Dependencies added**: None (uses Node.js built-in `zlib` + `tar` extraction via `node:stream`)

## Architecture Overview

### Current Flow (Before)
```
CLI flags/prompts → InitOptions → buildContext() → TemplateContext
  → selectTemplates() → renderProject() [Handlebars] → writeFiles()
```

### New Flow (After)
```
CLI flags/prompts → InitOptions
  → fetchClusterTemplates(variant, ref) [GitHub tarball] → Map<path, content>
  → generateCliFiles(options) [inline generation] → Map<path, content>
  → merge both maps → checkConflicts() → writeFiles()
```

### Key Changes
1. **Template source**: Bundled Handlebars `.hbs` files → GitHub tarball from `cluster-templates`
2. **Rendering**: Handlebars compilation → No rendering needed (static files) + inline string generation for CLI files
3. **Context building**: Complex `TemplateContext` with Zod validation → Direct use of `InitOptions`
4. **Caching**: None → Local cache at `~/.generacy/template-cache/{ref}/` with `--refresh-templates` override
5. **Type location**: `ClusterVariant` moves from `@generacy-ai/templates` → `packages/generacy/src/cli/commands/init/types.ts`

---

## Implementation Phases

### Phase 1: Migrate `ClusterVariant` Type & Add Template Fetcher

**Goal**: Create the new template fetching infrastructure without breaking the existing flow.

#### 1.1 Move `ClusterVariant` to CLI package
- **File**: `packages/generacy/src/cli/commands/init/types.ts`
- Define `ClusterVariant` as a union type `'standard' | 'microservices'` directly (no Zod dependency needed)
- Update imports in `summary.ts` and `types.ts` to use the local definition
- Keep the `@generacy-ai/templates` import in `index.ts` for now (removed in Phase 3)

#### 1.2 Create template fetcher module
- **New file**: `packages/generacy/src/cli/commands/init/template-fetcher.ts`
- Implements `fetchClusterTemplates(options: FetchOptions): Promise<Map<string, string>>`
  - `options`: `{ variant: ClusterVariant, ref?: string, token?: string | null, refreshCache?: boolean }`
  - Default `ref`: `'develop'` (overridable via `--template-ref` flag or `GENERACY_TEMPLATE_REF` env var)
- Tarball download flow:
  1. Check cache at `~/.generacy/template-cache/{ref}/{variant}/`
  2. If cached and `!refreshCache`, read from cache and return
  3. Fetch tarball: `GET https://api.github.com/repos/generacy-ai/cluster-templates/tarball/{ref}`
  4. Include `Authorization: Bearer {token}` header if token available
  5. Extract `.tar.gz` using `node:zlib` (createGunzip) + tar stream parsing
  6. Filter to files under `{variant}/` directory in the archive
  7. Map archive paths to target paths (e.g., `standard/Dockerfile` → `.devcontainer/Dockerfile`)
  8. Write to cache directory
  9. Return `Map<targetPath, fileContent>`
- Error handling: fail fast with clear message on network/HTTP errors

#### 1.3 Add CLI flags
- **File**: `packages/generacy/src/cli/commands/init/index.ts`
- Add `--template-ref <ref>` option (default: `process.env.GENERACY_TEMPLATE_REF || 'develop'`)
- Add `--refresh-templates` boolean flag (default: false)

#### 1.4 Add tar extraction utility
- **New file**: `packages/generacy/src/cli/commands/init/tar-utils.ts`
- Implements `extractTarGz(buffer: Buffer, filter: (path: string) => boolean): Promise<Map<string, string>>`
- Uses `node:zlib.createGunzip()` and a streaming tar parser
- **Dependency decision**: Use the `tar` npm package (already commonly available) or implement minimal tar header parsing. Since GitHub tarballs are standard POSIX tar format, use the lightweight [`tar-stream`](https://www.npmjs.com/package/tar-stream) package (7KB, zero deps) or `tar` package's `list`/`extract` stream API.
- **Alternative**: If avoiding new dependencies is paramount, implement a minimal tar parser (~80 lines) that reads 512-byte headers and extracts file content. GitHub tarballs use ustar format which is straightforward to parse.

### Phase 2: Inline CLI File Generation

**Goal**: Replace Handlebars-rendered shared templates with inline generation functions.

#### 2.1 Create CLI file generator module
- **New file**: `packages/generacy/src/cli/commands/init/file-generators.ts`
- Implements `generateCliFiles(options: InitOptions): Map<string, string>`
- Generates these files from `InitOptions` directly (no `TemplateContext`):

##### `.generacy/config.yaml`
- Use `js-yaml` (already a dependency of the CLI via `@generacy-ai/generacy`) or template literal
- Build a plain object from `InitOptions` fields:
  ```typescript
  const config = {
    project: { id: options.projectId, name: options.projectName },
    repos: { primary: toConfigUrl(options.primaryRepo), ... },
    defaults: { agent: options.agent, baseBranch: options.baseBranch },
    ...(options.devRepos.length > 0 && { orchestrator: { ... } }),
    cluster: { variant: options.variant },
  };
  ```
- Serialize with `yaml.dump()` with comment header prepended
- Helper: `toConfigUrl(shorthand: string)` → `"github.com/{owner}/{repo}"`

##### `.generacy/generacy.env.template`
- Template literal string with `options.projectId`, `options.baseBranch`, `options.agent` interpolated
- Conditional multi-repo section based on `options.devRepos.length > 0`

##### `.generacy/.gitignore`
- Static string constant (no variables needed)

##### `.vscode/extensions.json`
- Keep `GENERACY_EXTENSIONS` constant: `['generacy-ai.agency', 'generacy-ai.generacy']`
- Move merge logic from `renderExtensionsJson()` inline:
  - Accept optional `existingContent?: string`
  - Parse existing JSON, merge recommendations with Set dedup, serialize

#### 2.2 Update `collectExistingFiles()`
- **File**: `packages/generacy/src/cli/commands/init/writer.ts`
- No changes needed — `MERGEABLE_FILES` list remains `['.vscode/extensions.json']`

### Phase 3: Rewire Init Flow & Remove Templates Dependency

**Goal**: Connect the new modules into the init flow and remove all `@generacy-ai/templates` usage.

#### 3.1 Rewrite init orchestration
- **File**: `packages/generacy/src/cli/commands/init/index.ts`
- Remove imports from `@generacy-ai/templates`
- Replace steps 4-6 of the flow:

**Old steps 4-6:**
```
4. Build TemplateContext via buildSingleRepoContext/buildMultiRepoContext
5. Collect existing files
6. Render via renderProject(context, existingFiles)
```

**New steps 4-7:**
```
4. Fetch cluster templates via fetchClusterTemplates({ variant, ref, token, refreshCache })
5. Generate CLI files via generateCliFiles(options)
6. Merge extensions.json with existing (if present) via collectExistingFiles() + merge logic
7. Combine fetched + generated file maps
```

- The rest of the flow (conflict check, resolve, write, summary) remains the same
- `printSummary()` already accepts `FileResult[]` + `dryRun` + `variant` — no changes needed

#### 3.2 Update resolver for new flags
- **File**: `packages/generacy/src/cli/commands/init/resolver.ts`
- Thread `templateRef` and `refreshTemplates` through `InitOptions` or pass separately
- Read `GENERACY_TEMPLATE_REF` env var as fallback for `--template-ref`

#### 3.3 Remove post-render validation
- The `validateRenderedConfig` call in index.ts (step 11) validated Handlebars output
- Replace with a simpler check: load the generated config.yaml and verify it parses as valid YAML with expected fields
- This can use the existing `loadConfig()` call that's already there

#### 3.4 Update conflict detection
- **File**: `packages/generacy/src/cli/commands/init/conflicts.ts`
- The `.gitattributes` file from `cluster-templates` is a new file not in the old template set — add to known files
- No other changes needed; conflicts module works on `Map<path, content>` regardless of source

### Phase 4: Remove Templates Package

**Goal**: Delete the package and clean up all references.

#### 4.1 Remove package directory
- Delete `packages/templates/` entirely

#### 4.2 Clean up workspace references
- **File**: `packages/generacy/package.json`
  - Remove `"@generacy-ai/templates": "workspace:*"` from dependencies
  - Add `tar-stream` (or chosen tar library) if not using inline parser
- **File**: `pnpm-workspace.yaml` — no change needed (glob pattern `packages/*` auto-excludes deleted dir)

#### 4.3 Remove unused dependencies from CLI
- After removing templates, check if `handlebars` is still needed anywhere in the CLI package (it shouldn't be)
- `js-yaml` is likely still needed for config.yaml generation — verify
- `zod` is used elsewhere in the CLI — no removal needed

#### 4.4 Clean up tsconfig references
- Remove any `references` or `paths` entries pointing to `packages/templates`

### Phase 5: Update Tests

**Goal**: Update and add tests for the new modules.

#### 5.1 Fix pre-existing `summary.test.ts` bug
- **File**: `packages/generacy/src/cli/commands/init/__tests__/summary.test.ts`
- Add `'standard'` as the third argument to all `printSummary()` calls (11 call sites)

#### 5.2 Add template fetcher tests
- **New file**: `packages/generacy/src/cli/commands/init/__tests__/template-fetcher.test.ts`
- Mock `fetch()` to return sample tarball responses
- Test cache hit/miss behavior
- Test error handling (network failure, 404, 403)
- Test `--refresh-templates` bypasses cache
- Test auth header inclusion when token available

#### 5.3 Add file generator tests
- **New file**: `packages/generacy/src/cli/commands/init/__tests__/file-generators.test.ts`
- Test config.yaml generation for single-repo and multi-repo
- Test env template generation with conditional sections
- Test extensions.json merge logic (new file, merge with existing, deduplication)
- Test gitignore is static content

#### 5.4 Add tar extraction tests
- **New file**: `packages/generacy/src/cli/commands/init/__tests__/tar-utils.test.ts`
- Test extraction with sample `.tar.gz` buffers
- Test path filtering (only variant directory)
- Test path mapping (archive paths → target paths)

#### 5.5 Update integration tests
- Remove or update any tests that import from `@generacy-ai/templates`
- Ensure `generacy init --dry-run` produces expected file list with new source

#### 5.6 Remove old template tests
- Delete `packages/templates/tests/` (removed with package in Phase 4)

### Phase 6: Verify & Clean Up

#### 6.1 Run full test suite
- `pnpm test` at workspace root
- Verify no broken imports or missing modules

#### 6.2 Run build
- `pnpm build` at workspace root
- Verify clean TypeScript compilation with no errors

#### 6.3 Manual smoke test
- Run `generacy init --dry-run` in a test directory
- Verify output file list matches expected set
- Verify config.yaml content is correct
- Verify fetched devcontainer files match `cluster-templates` repo

#### 6.4 Clean up lockfile
- Run `pnpm install` to regenerate `pnpm-lock.yaml` without templates package deps

---

## Key Technical Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| **Fetch method** | GitHub tarball via `fetch()` | Single HTTP request, no recursive API calls, consistent with CLI's existing `fetch()` pattern |
| **Tar extraction** | `tar-stream` package or inline parser | Lightweight, no heavy deps; GitHub tarballs are standard POSIX format |
| **Template caching** | `~/.generacy/template-cache/{ref}/` with explicit refresh | Templates change infrequently; indefinite cache + `--refresh-templates` is simplest model |
| **Default ref** | `develop` branch | Matches `cluster-templates` repo's default branch |
| **Auth strategy** | Opportunistic (include token if available) | Public repo, 60 req/hr unauth is fine for single tarball request, but token improves rate limits |
| **CLI file generation** | Inline template literals + `js-yaml` | No Handlebars dependency; config.yaml needs proper YAML serialization, rest are simple strings |
| **ClusterVariant location** | `packages/generacy/src/cli/commands/init/types.ts` | Only consumer is the CLI init command; no need for shared types package |
| **Error handling** | Fail fast, no retry | Interactive CLI; user can re-run; clear error message with connectivity hints |
| **Extensions merge** | Inline in file-generators.ts | CLI concern, not cluster concern; preserves non-destructive merge behavior |
| **Test bug fix** | Explicit `'standard'` in each test call | Maintains type safety; tests should be explicit about variant |

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| `cluster-templates` repo unreachable on first run | Clear error message; suggest checking connectivity; document that first run requires network |
| Tarball format changes | Pin to `tar-stream` which handles edge cases; test with real GitHub tarballs |
| File set divergence between old and new | Phase 6 smoke test compares generated files; integration tests validate file list |
| `js-yaml` not available in CLI package | Verify it's a direct or transitive dependency; add explicitly if needed |
| Cache directory permissions | Use `os.homedir()` + standard `~/.generacy/` path; create with `{ recursive: true }` |
| Breaking changes in `cluster-templates` develop branch | `--template-ref` flag allows pinning to specific commit/tag if needed |

## Files Changed Summary

### New Files
| File | Purpose |
|------|---------|
| `packages/generacy/src/cli/commands/init/template-fetcher.ts` | GitHub tarball download + caching |
| `packages/generacy/src/cli/commands/init/tar-utils.ts` | Tar.gz extraction utility |
| `packages/generacy/src/cli/commands/init/file-generators.ts` | Inline generation of CLI-owned files |
| `packages/generacy/src/cli/commands/init/__tests__/template-fetcher.test.ts` | Fetcher tests |
| `packages/generacy/src/cli/commands/init/__tests__/file-generators.test.ts` | Generator tests |
| `packages/generacy/src/cli/commands/init/__tests__/tar-utils.test.ts` | Tar extraction tests |

### Modified Files
| File | Changes |
|------|---------|
| `packages/generacy/src/cli/commands/init/types.ts` | Add `ClusterVariant` type, add `templateRef`/`refreshTemplates` to `InitOptions` |
| `packages/generacy/src/cli/commands/init/index.ts` | Rewire init flow, remove `@generacy-ai/templates` imports, add new CLI flags |
| `packages/generacy/src/cli/commands/init/summary.ts` | Update `ClusterVariant` import to local |
| `packages/generacy/src/cli/commands/init/resolver.ts` | Thread new flags, read env var |
| `packages/generacy/src/cli/commands/init/conflicts.ts` | Handle `.gitattributes` from cluster-templates |
| `packages/generacy/src/cli/commands/init/__tests__/summary.test.ts` | Fix missing `variant` parameter bug |
| `packages/generacy/package.json` | Remove `@generacy-ai/templates` dep, add `tar-stream` if needed |

### Deleted Files
| File/Directory | Reason |
|----------------|--------|
| `packages/templates/` (entire directory) | Superseded by `cluster-templates` repo |

---

*Generated by Claude Code*
