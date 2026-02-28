---
sidebar_position: 8
---

# First Workflow

With your setup verified, it's time to connect an AI coding assistant to Generacy and run your first workflow. This page walks through configuring MCP (Model Context Protocol) so your agent can use Generacy tools, then shows you what to expect when everything is working.

## Step 1: Configure MCP for Your Agent

Generacy exposes its tools to AI coding assistants via an MCP server. You need to tell your agent where to find it.

### Claude Code

Add the Generacy MCP server to your project's Claude Code settings:

```json title=".claude/settings.json"
{
  "mcpServers": {
    "generacy": {
      "command": "generacy",
      "args": ["mcp"]
    }
  }
}
```

This tells Claude Code to launch `generacy mcp` as a local MCP server, giving the agent access to Generacy's tools.

### Cursor

For Cursor, add the same MCP configuration to your project's `.cursor/mcp.json`:

```json title=".cursor/mcp.json"
{
  "mcpServers": {
    "generacy": {
      "command": "generacy",
      "args": ["mcp"]
    }
  }
}
```

### Other MCP-Compatible Agents

Any agent that supports the Model Context Protocol can connect to Generacy. Point it at the `generacy mcp` command using your agent's MCP configuration format.

## Step 2: Restart Your Agent

After updating the MCP configuration, restart your AI coding assistant so it picks up the new server. In Claude Code, close and reopen the session. In Cursor, reload the window.

## Step 3: Ask the Agent to Use Generacy Tools

With MCP configured, your agent now has access to Generacy's tools. Try these example prompts to verify the connection is working:

### Discover available tools

```
What tools are available from Generacy?
```

The agent should list the Generacy tools it can access, such as project info, file search, and code analysis.

### Get project information

```
Use Generacy to show me the project structure.
```

The agent should use the `project-info` tool to return metadata about your project, including the project ID, name, and repository configuration from your `config.yaml`.

### Analyze code

```
Use Generacy to analyze the dependencies in this project.
```

The agent should use Generacy's code analysis tools to inspect your project's dependency graph.

## What Success Looks Like

When everything is working correctly:

1. **Agent starts without errors** — no MCP connection failures or "server not found" messages in the agent's output
2. **Tools are listed** — the agent can enumerate Generacy tools when asked
3. **Tool calls return results** — prompts that use Generacy tools return meaningful data about your project
4. **No authentication errors** — the agent can access your project without token or API key errors

If the agent reports that it can't connect to the MCP server or that no tools are available, see [Troubleshooting](./troubleshooting.md) for common MCP connection issues.

## Next Steps

You've completed the Getting Started guide. From here:

- **[Adoption Levels](./adoption-levels.md)** — learn about Levels 1–4 and what each provides, including custom tools, human oversight, and orchestration
- **[Troubleshooting](./troubleshooting.md)** — solutions for common issues you may encounter
- **[Multi-Repo Setup](./multi-repo.md)** — configure Generacy for projects that span multiple repositories
