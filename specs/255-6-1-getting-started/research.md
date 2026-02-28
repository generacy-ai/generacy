# Research: Getting Started Guide — Technical Decisions

## 1. Docusaurus Redirect Strategy

### Options Evaluated

**A) `@docusaurus/plugin-client-redirects`**
- Official Docusaurus plugin for client-side redirects
- Requires adding the plugin to `docusaurus.config.ts`
- Creates HTML pages with `<meta http-equiv="refresh">` tags
- Pros: Clean, no leftover content at old URLs
- Cons: Adds a dependency; only works for client-side redirects (not server-side)

**B) Manual redirect pages**
- Replace old files with markdown containing a notice and link
- Content: "This page has moved. See [new location](...)."
- Hide from sidebar by removing from `sidebars.ts`
- Pros: No new dependencies; works immediately; old content is clearly replaced
- Cons: Old URLs still serve content (a redirect notice, not a true HTTP redirect)

### Decision: B — Manual redirect pages

Rationale: Adding a Docusaurus plugin is over-engineering for 3 redirects. Manual pages are simple, require no new dependencies, and clearly direct users to the new location. If the project later adds `plugin-client-redirects` for other reasons, these can be converted.

---

## 2. Sidebar Category Link Pattern

### Options Evaluated

**A) `generated-index` (current pattern)**
- Auto-generates an index page listing all items in the category
- Used by all other categories in the sidebar
- Pros: Consistent with existing pattern; auto-maintained
- Cons: Cannot customize the hub page content

**B) `doc` link to `index.md`**
- Points category link to a hand-authored `index.md`
- Pros: Full control over hub page content; can include navigation, overview table, recommended path
- Cons: Breaks consistency with other categories

### Decision: B — `doc` link to `index.md`

Rationale: The Getting Started guide needs a curated entry point, not an auto-generated index. The hub page must include a progressive adoption table, recommended path callout, and guided navigation. This is unique to Getting Started — other categories can keep `generated-index`.

---

## 3. File Naming Convention

The new files use kebab-case slugs matching Docusaurus conventions:
- `prerequisites.md` (not `01-prerequisites.md`) — Ordering controlled by `sidebars.ts`, not filename prefixes
- `project-setup.md` (not `generacy-init.md`) — User-facing terminology over internal command names
- `multi-repo.md` (not `appendix-multi-repo.md`) — Clean URLs; appendix status conveyed by sidebar position

---

## 4. Content Absorption Strategy

### quick-start.md → Multiple files

| Original Section | Absorbed Into | Notes |
|-------------------|---------------|-------|
| Prerequisites | `prerequisites.md` | Expanded with Docker, VS Code |
| Install Agency | `installation.md` | Updated to `generacy` CLI |
| Initialize project | `project-setup.md` | Expanded with `generacy init` details |
| Configure agent | `first-workflow.md` | MCP config section |
| Troubleshooting | `troubleshooting.md` | Expanded to 8+ issues |

### level-1-agency-only.md → adoption-levels.md

Full content preserved as Level 1 section. Mermaid diagram, tools table, configuration, and best practices all kept inline since Level 1 is the recommended starting point.

### level-2-agency-humancy.md → adoption-levels.md

Condensed to summary section with Mermaid diagram. Key capabilities listed but detailed setup instructions linked out rather than inlined. Full content from the original file (workflow YAML examples, commands table, GitHub integration config) is better suited for the existing Humancy guides.

### installation.md → prerequisites.md + installation.md

System requirements table moves to `prerequisites.md`. Installation methods (npm, pnpm, source) and component installation sections stay in `installation.md` but rewritten around the `generacy` CLI instead of `agency`.

---

## 5. Troubleshooting Issue Sources

Issues derived from actual codebase error handling:

| Issue | Source |
|-------|--------|
| Command not found | Common npm global install issue; mentioned in existing `quick-start.md` |
| Not in git repo | `init/index.ts` step 1: `detectGitRoot()` — exits if not in a git repo |
| Config validation | `config/` package: `ConfigSchemaError`, `ConfigValidationError` classes |
| GitHub token invalid | `init/github.ts`: advisory access check; `doctor.ts`: GitHub token check |
| Anthropic key missing | `doctor.ts`: Anthropic API key check |
| MCP connection | Existing `quick-start.md` troubleshooting; `doctor.ts`: Agency MCP check |
| Docker not running | `doctor.ts`: Docker check |
| Port conflicts | Common Docker Compose issue; Redis default port 6379 |

---

## 6. Credentials Table Design

Per Q8 answer, a unified credentials table is needed. Structure:

| Credential | Required For | How to Obtain | Level Required |
|------------|-------------|---------------|----------------|
| GitHub PAT | CLI, CI | github.com/settings/tokens → `repo` + `workflow` scopes | Level 1+ |
| Anthropic API Key | Agent operations | console.anthropic.com → API keys | Level 1+ |
| GitHub OAuth | Web UI, VS Code extension | Sign in at generacy.ai | Level 2+ |

The `GITHUB_TOKEN` (PAT) and `ANTHROPIC_API_KEY` are the only variables documented inline for Level 1 setup (per Q13 answer). OAuth and additional API keys are described but linked to their respective setup pages.
