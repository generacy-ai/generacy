---
sidebar_position: 0
---

# Getting Started with Generacy

Generacy is an agentic development platform that helps you build more with AI agents while keeping humans in the loop. It extends AI coding assistants like Claude Code, Cursor, and GitHub Copilot with project-aware tools, human oversight workflows, and multi-agent orchestration.

This guide walks you through setting up Generacy from scratch. By the end, you'll have a working development environment with AI-enhanced tooling.

## What You'll Set Up

- **Generacy CLI** — the command-line tool for initializing and managing projects
- **Project configuration** — `.generacy/config.yaml` and environment variables
- **Authentication** — GitHub, Anthropic, and OAuth credentials
- **AI agent integration** — MCP server connection to your coding assistant
- **Verification** — confirm everything works end-to-end

## Progressive Adoption Levels

You don't need to adopt everything at once. Generacy supports four levels of adoption — start where it makes sense for your team:

| Level | Components | What You Get | Complexity |
|-------|------------|-------------|------------|
| **Level 1** | Agency | Local agent enhancement — custom tools, context providers, local plugins | Low |
| **Level 2** | Agency + Humancy | Add human oversight — review gates, approval workflows, audit trail | Medium |
| **Level 3** | Full Local | Complete local stack — orchestration, job queues, multi-agent coordination | High |
| **Level 4** | Cloud | Team/enterprise deployment — cloud orchestration, shared dashboards, CI/CD integration | High |

:::tip Recommended Starting Point
**Start with Level 1 (Agency).** It requires the least setup, runs entirely locally, and gives you immediate value. You can add higher levels later without reworking your configuration.
:::

## Guide Sections

Follow these sections in order for a complete Level 1 setup (~15–30 minutes):

1. **[Prerequisites](./prerequisites.md)** — system requirements and accounts you'll need
2. **[Installation](./installation.md)** — install the Generacy CLI, Docker, and VS Code extension
3. **[Authentication](./authentication.md)** — set up GitHub, Anthropic, and OAuth credentials
4. **[Project Setup](./project-setup.md)** — initialize Generacy in your project with `generacy init`
5. **[Configuration](./configuration.md)** — understand and customize `config.yaml` and environment variables
6. **[Dev Environment](./dev-environment.md)** — set up the dev container for local development
7. **[Verify Setup](./verify-setup.md)** — run `generacy doctor` and validate your configuration
8. **[First Workflow](./first-workflow.md)** — connect your AI agent and run your first workflow

### Beyond Level 1

- **[Adoption Levels](./adoption-levels.md)** — detailed guide for Levels 1–4 with architecture diagrams
- **[Troubleshooting](./troubleshooting.md)** — solutions for common setup issues
- **[Multi-Repo Setup](./multi-repo.md)** — appendix for multi-repository configurations
