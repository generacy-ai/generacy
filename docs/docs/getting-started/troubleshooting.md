---
sidebar_position: 10
---

# Troubleshooting

This page covers common issues you may encounter while setting up and using Generacy. Each issue is documented with the **symptom** you'll see, the **cause**, and the **resolution**.

:::tip
Run `generacy doctor` at any time for an automated check of your entire setup. It detects most of the issues listed below and provides actionable suggestions. See [Verify Setup](./verify-setup.md) for details.
:::

---

## `generacy` Command Not Found

**Symptom**: Running `generacy` in the terminal returns `command not found` or `'generacy' is not recognized`.

**Cause**: The npm global `bin` directory is not in your system `PATH`, or the Generacy CLI was not installed globally.

**Resolution**:

1. Verify the CLI is installed:

   ```bash
   npm list -g @generacy-ai/generacy
   ```

2. If it's not installed, install it:

   ```bash
   npm install -g @generacy-ai/generacy
   ```

3. If it is installed but still not found, add the npm global `bin` directory to your `PATH`:

   ```bash
   export PATH="$PATH:$(npm config get prefix)/bin"
   ```

   To make this permanent, add the line to your shell profile (`~/.bashrc`, `~/.zshrc`, or `~/.profile`).

4. Verify the fix:

   ```bash
   generacy --version
   ```

---

## `generacy init` Fails — Not a Git Repository

**Symptom**: Running `generacy init` fails with an error about not being in a Git repository.

**Cause**: `generacy init` requires a Git repository to detect repository URLs and set up project configuration.

**Resolution**:

1. Make sure you're in a Git repository:

   ```bash
   git status
   ```

2. If the directory is not a Git repository, initialize one:

   ```bash
   git init
   git remote add origin https://github.com/your-org/your-repo.git
   ```

3. If you're in a subdirectory of a Git repository, navigate to the repository root:

   ```bash
   cd "$(git rev-parse --show-toplevel)"
   ```

4. Re-run `generacy init`:

   ```bash
   generacy init --yes
   ```

---

## Config Validation Errors

**Symptom**: `generacy validate` or `generacy doctor` reports configuration errors such as "Configuration is invalid" or "Config file fails schema validation".

**Cause**: The `.generacy/config.yaml` file has syntax errors, missing required fields, or invalid values.

**Resolution**:

Check the specific error message for which field is invalid. Common issues include:

| Error | Fix |
|-------|-----|
| Invalid YAML syntax | Check for incorrect indentation, missing colons, or unquoted special characters |
| `repos.primary` is invalid | Use a valid GitHub URL format: `github.com/{owner}/{repo}` |
| Missing required `project.id` | Add a project ID in the format `proj_yourproject123` |
| Duplicate repositories | Each repository can only appear once across primary, dev, and clone lists |
| Invalid `defaults.agent` | Use a supported agent name (e.g., `claude-code`) |

After fixing, re-validate:

```bash
generacy validate
```

If the config file is missing entirely, regenerate it:

```bash
generacy init --yes
```

---

## GitHub Token Invalid or Insufficient Scopes

**Symptom**: `generacy doctor` reports "Token is invalid or missing required scopes" for the GitHub Token check. Or, `generacy init` reports that a repository is not accessible or is read-only.

**Cause**: The `GITHUB_TOKEN` in `.generacy/generacy.env` is expired, revoked, or missing the required `repo` and `workflow` scopes.

**Resolution**:

1. Generate a new personal access token at [github.com/settings/tokens/new](https://github.com/settings/tokens/new) with the following scopes:
   - `repo` (full control of private repositories)
   - `workflow` (update GitHub Actions workflows)

2. Update the token in `.generacy/generacy.env`:

   ```bash
   GITHUB_TOKEN=ghp_your_new_token_here
   ```

3. Verify the fix:

   ```bash
   generacy doctor --check github-token
   ```

:::caution
Never commit `.generacy/generacy.env` to version control. It is gitignored by default — keep it that way.
:::

---

## Anthropic API Key Not Set or Invalid

**Symptom**: `generacy doctor` reports "ANTHROPIC_API_KEY is not set" or "Anthropic API key is invalid".

**Cause**: The API key is missing from `.generacy/generacy.env`, or the key is expired/revoked.

**Resolution**:

1. Generate a new API key at [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys)

2. Add or update the key in `.generacy/generacy.env`:

   ```bash
   ANTHROPIC_API_KEY=sk-ant-your_key_here
   ```

3. Verify the fix:

   ```bash
   generacy doctor --check anthropic-key
   ```

If you get "API request timed out" or "Failed to connect to Anthropic API", check your network connection. If you're behind a corporate proxy, ensure `HTTPS_PROXY` is set in your environment.

---

## MCP Connection Issues

**Symptom**: Your AI agent can't connect to the Generacy MCP server, tools don't appear in the agent's tool list, or MCP commands fail with connection errors.

**Cause**: The MCP server is not configured correctly, the `generacy` CLI is not installed or not in PATH, or your agent needs to be restarted.

**Resolution**:

1. **Verify the `generacy` CLI is available**:

   ```bash
   generacy --version
   ```

   If this fails, see [generacy command not found](#generacy-command-not-found) above.

2. **Verify your MCP configuration** — ensure the agent's MCP settings point to the correct command. For Claude Code, your `.claude/settings.json` should contain:

   ```json
   {
     "mcpServers": {
       "generacy": {
         "command": "generacy",
         "args": ["mcp"]
       }
     }
   }
   ```

3. **Restart your AI assistant** — some agents cache the MCP tool list at startup. Close and reopen the session to re-discover tools.

4. **Run `generacy doctor`** to check overall health:

   ```bash
   generacy doctor
   ```

5. **If tools still don't appear**, verify that `generacy mcp` starts without errors by running it directly in your terminal (press Ctrl+C to stop it after confirming it starts).

---

## Docker Not Running or Container Issues

**Symptom**: `generacy doctor` reports "Docker daemon is not running" or "Docker is not installed". Docker Compose commands fail.

**Cause**: Docker Desktop is not installed, is not running, or your user doesn't have permission to access Docker.

**Resolution**:

| Issue | Fix |
|-------|-----|
| Docker not installed | Install Docker Desktop from [docker.com](https://www.docker.com/products/docker-desktop/) |
| Docker daemon not running | Start Docker Desktop — look for the Docker icon in your system tray/menu bar |
| Permission denied on Linux | Add your user to the `docker` group: `sudo usermod -aG docker $USER`, then log out and back in |
| Container won't start | Run `docker info` to verify Docker is working, then check container logs with `docker compose logs` |

After fixing, verify:

```bash
generacy doctor --check docker
```

:::note
Docker is **optional for Level 1** (Agency Only). If you're only using Level 1, you can skip Docker checks:

```bash
generacy doctor --skip docker dev-container
```
:::

---

## Port Conflicts

**Symptom**: Services fail to start with errors like "address already in use" or "port is already allocated". Common ports affected include Redis (6379) and the dev server.

**Cause**: Another process is already using the port that Generacy or its services need.

**Resolution**:

1. **Find what's using the port**:

   ```bash
   # Linux/macOS
   lsof -i :6379

   # Windows (PowerShell)
   netstat -ano | findstr :6379
   ```

2. **Stop the conflicting process**, or configure Generacy to use a different port.

3. If it's a stale container using the port, stop and remove it:

   ```bash
   docker compose down
   docker compose up -d
   ```

---

## Environment File Missing or Incomplete

**Symptom**: `generacy doctor` reports "`.generacy/generacy.env` not found" or "Env file is missing required keys".

**Cause**: The environment file was not created during `generacy init`, was accidentally deleted, or is missing required variables.

**Resolution**:

1. If the file is missing, create it from the template:

   ```bash
   cp .generacy/generacy.env.template .generacy/generacy.env
   ```

   Or re-run `generacy init` to regenerate it.

2. Open `.generacy/generacy.env` and set the required values:

   ```bash
   GITHUB_TOKEN=ghp_your_token_here
   ANTHROPIC_API_KEY=sk-ant-your_key_here
   ```

3. Verify:

   ```bash
   generacy doctor --check env-file
   ```

---

## Review Gates Not Triggering (Level 2+)

**Symptom**: Workflows complete without triggering expected human review gates.

**Cause**: The workflow YAML is missing review gate configuration, or trigger conditions are not being met.

**Resolution**:

1. Check workflow YAML syntax for correct review gate definitions
2. Verify trigger conditions match the workflow state
3. Check that the Humancy component is properly installed and configured — see the [Humancy Guide](/docs/guides/humancy/overview) for setup details

---

## Still Stuck?

If none of the above solutions resolve your issue:

1. **Run a full diagnostic** and save the output:

   ```bash
   generacy doctor --json > doctor-report.json
   ```

2. **Search existing issues** on GitHub: [github.com/generacy-ai/generacy/issues](https://github.com/generacy-ai/generacy/issues)

3. **Open a new issue** with your `doctor-report.json` attached: [github.com/generacy-ai/generacy/issues/new](https://github.com/generacy-ai/generacy/issues/new)
