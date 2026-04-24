---
sidebar_position: 0
---

# Requirements for Effective Use

To get reliable, high-quality results from Generacy (or any AI development agent), your project must meet several baseline requirements. These are not Generacy-specific optimizations — they are the same fundamentals a human developer needs: **access**, **tools**, and **understanding**.

:::tip Already using AI tooling?
If your project already uses Claude Code or another MCP-compatible agent, most of these requirements are likely satisfied. Skim the checklist at the bottom to confirm.
:::

## 1. Execution Access

**The agent must be able to run and test your software locally.**

This is the single most important requirement. Without it, the agent cannot verify its own work, debugging becomes guesswork, and output quality drops significantly.

Your project needs:

- A **working local development environment** (builds, dependencies resolved)
- A **clear command to start the application** (e.g., `npm run dev`, `docker compose up`)
- The ability to **execute code changes and observe results**

For **web applications**, browser automation (e.g., Playwright) is additionally required so the agent can interact with the UI.

## 2. Tool Access (MCP Servers)

**The agent must have access to the tools needed to interact with your project.**

These tools are provided via [MCP (Model Context Protocol)](https://modelcontextprotocol.io) servers. At minimum, the agent needs:

| Capability | Purpose |
|------------|---------|
| **File system access** | Read and write project files |
| **Terminal / CLI** | Run commands, build, test |
| **Browser automation** | Interact with web UIs (for web apps) |

**Requirement:** Relevant MCP servers must be installed, configured, and functional. The specific servers depend on your project type — a CLI tool needs terminal access, a web app additionally needs browser control.

Without working MCP servers, the agent cannot meaningfully interact with your environment.

## 3. Project Context

**The agent must be given structured context about your project.**

This is typically provided via a `CLAUDE.md` file (or equivalent context file) at the root of your repository. It should include:

- **Project purpose** — what the project does and why
- **Tech stack** — frameworks, languages, key dependencies
- **How to run locally** — commands to build, start, and test
- **Architecture overview** — key directories, services, and how they connect
- **Testing approach** — how to run tests, what testing tools are used

Without structured context, the agent must infer everything from the codebase alone. This degrades both accuracy and speed significantly.

:::info Creating a context file
If your project doesn't have a `CLAUDE.md` yet, start with the basics: what the project is, how to run it, and where the important code lives. You can iterate from there. See the [Project Setup guide](/docs/getting-started/project-setup) for more on initialization.
:::

## 4. Iterative Feedback Loop

**The environment must support a generate → run → test → fix cycle.**

The agent works best when it can:

1. Make a change
2. Run the application or tests
3. Observe the result
4. Fix any issues

This requires fast, reliable execution and the ability to run tests or validations programmatically. Without this feedback loop, the agent cannot improve its own outputs, and progress becomes manual and slow.

## 5. Onboarding New Projects

If your project has **not previously used AI tooling**, you will need to:

1. **Create a context file** (e.g., `CLAUDE.md`) with the information described above
2. **Set up MCP servers** appropriate for your project type
3. **Verify local execution** works reliably before engaging the agent

If the project **already uses AI tooling** (e.g., an existing Claude Code or Cursor setup), these requirements are likely already met.

## Summary Checklist

Use this checklist to verify your project is ready:

- [ ] Local execution works reliably (build, start, test)
- [ ] The agent can run and test code changes
- [ ] Playwright (or equivalent) is available for web applications
- [ ] MCP servers are installed and functional
- [ ] A `CLAUDE.md` (or equivalent) provides clear project context
- [ ] The feedback loop (generate → run → test → fix) is operational

**Bottom line:** Generacy requires the same fundamentals as a human developer — access, tools, and understanding. Without those, performance degrades quickly regardless of prompting.
