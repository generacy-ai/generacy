---
sidebar_position: 4
---

# Project Setup

With the CLI installed and your credentials ready, it's time to initialize Generacy in your project. The `generacy init` command scaffolds a `.generacy/` directory with configuration files, environment templates, and workflow definitions.

## Step 1: Navigate to Your Project

Open a terminal and change to the root of the Git repository you want to set up with Generacy:

```bash
cd your-project
```

:::caution
`generacy init` must be run from within a Git repository. If your project isn't a Git repo yet, initialize one first with `git init`.
:::

## Step 2: Run `generacy init`

For a quick setup with sensible defaults, run:

```bash
generacy init --yes
```

The `--yes` flag accepts defaults without prompting. It auto-derives your project name from the directory name and detects your primary repository from `git remote get-url origin`.

### Interactive Mode

To customize settings, run without `--yes`:

```bash
generacy init
```

You'll be prompted for:

1. **Project name** — defaults to your directory name
2. **Primary repository** — detected from your Git remote
3. **Development repositories** — optional, for multi-repo setups
4. **Clone-only repositories** — optional, only prompted if dev repos are set
5. **Default agent** — `claude-code` (default) or `cursor-agent`
6. **Default base branch** — defaults to `main`

## Step 3: Review the Output

After initialization, `generacy init` prints a summary of all file operations:

```
Created   .generacy/config.yaml (1.2 KB)
Created   .generacy/generacy.env.template (523 bytes)
Created   .generacy/workflows/pr.yml (890 bytes)
Merged    .vscode/extensions.json (654 bytes)

Done: 3 created, 1 merged
```

Each file shows its action and size:

| Action | Meaning |
|--------|---------|
| **Created** | New file written |
| **Overwritten** | Existing file replaced |
| **Merged** | Smart merge with existing content (e.g., VS Code extensions) |
| **Skipped** | Existing file kept as-is |

## Step 4: Understand What Was Created

The `.generacy/` directory contains everything Generacy needs to manage your project:

```
.generacy/
├── config.yaml              # Project configuration (repos, defaults, settings)
├── generacy.env.template    # Environment variable template (copy to generacy.env)
└── workflows/
    └── pr.yml               # GitHub workflow for PR automation
```

Additionally, `.vscode/extensions.json` is updated (or created) with recommended VS Code extensions for Generacy.

### Key files

- **`config.yaml`** — Defines your project ID, repositories, default agent, base branch, and orchestrator settings. You'll customize this in the next step. See [Configuration](./configuration.md) for details.

- **`generacy.env.template`** — A template for your environment variables. Copy it to `generacy.env` and fill in your `GITHUB_TOKEN` and `ANTHROPIC_API_KEY` (covered in [Authentication](./authentication.md)).

- **`workflows/pr.yml`** — A GitHub Actions workflow for Generacy's PR automation. Commit this to your repository to enable automated workflows.

## Step 5: Set Up Your Environment File

If you haven't already configured credentials during the [Authentication](./authentication.md) step, do so now:

```bash
cp .generacy/generacy.env.template .generacy/generacy.env
```

Edit `.generacy/generacy.env` and fill in your tokens:

```bash
GITHUB_TOKEN=ghp_your_token_here
ANTHROPIC_API_KEY=sk-ant-your_key_here
```

:::danger Never commit credentials
The `.generacy/generacy.env` file is automatically gitignored. **Do not** commit it to version control.
:::

## Step 6: Commit the Generated Files

Commit the generated configuration to your repository:

```bash
git add .generacy/config.yaml .generacy/generacy.env.template .generacy/workflows/
git commit -m "chore: initialize generacy project"
```

Do **not** add `.generacy/generacy.env` — it contains secrets and is gitignored by default.

## Onboarding PR and Cluster Setup

When you create a project through the Generacy web app or GitHub App, an **onboarding PR** is automatically created on your repository. This PR uses a **merge commit** to bring in the cluster base repo — it's not a file copy, but a real Git merge that establishes an upstream relationship with the base repo.

The onboarding PR includes:
- **Cluster base files** — dev container configuration, orchestrator scripts, and workflows merged from the appropriate base repo (`cluster-base` or `cluster-microservices`)
- **Project-specific configuration** — `.devcontainer/.env` with your project's `REPO_URL`, `MONITORED_REPOS`, and `WORKER_COUNT`; `.generacy/config.yaml` with your project and org IDs
- **Tracking file** — `.generacy/cluster-base.json`, which records which base repo version was merged and when (used by the Generacy UI to detect available updates)

Because this is a merge commit (not a flat copy), you can later pull updates from the base repo with a standard `git fetch` + `git merge`. See [Cluster Setup](./cluster-setup.md) for full details on the update workflow and troubleshooting.

## Re-running `generacy init`

You can safely re-run `generacy init` on an existing project. The command detects existing files and prompts you to overwrite, skip, or view a diff for each conflict. Mergeable files like `.vscode/extensions.json` are smart-merged automatically.

Use `--force` to overwrite all existing files without prompting, or `--dry-run` to preview what would change without writing anything:

```bash
generacy init --dry-run
```

## CLI Reference

`generacy init` supports additional flags for automation and advanced setups:

| Flag | Description |
|------|-------------|
| `-y, --yes` | Accept defaults without prompting |
| `--project-id <id>` | Link to an existing project (`proj_xxx` format) |
| `--project-name <name>` | Set the project display name |
| `--primary-repo <repo>` | Set the primary repository |
| `--dev-repo <repo>` | Add a development repository (repeatable) |
| `--clone-repo <repo>` | Add a clone-only repository (repeatable) |
| `--agent <agent>` | Set the default agent (`claude-code` or `cursor-agent`) |
| `--base-branch <branch>` | Set the default base branch |
| `--force` | Overwrite existing files without prompting |
| `--dry-run` | Preview files without writing |
| `--skip-github-check` | Skip GitHub access validation |

Repository URLs can be specified in multiple formats: `owner/repo`, `github.com/owner/repo`, `https://github.com/owner/repo.git`, or `git@github.com:owner/repo.git`.

## Next Steps

With your project initialized, proceed to [Configuration](./configuration.md) to understand and customize your `config.yaml` and environment variables.
