---
sidebar_position: 1
---

# Quick Start

Get up and running with Generacy in under 5 minutes.

## Prerequisites

- Node.js 18 or later
- An AI coding assistant (Claude Code, Cursor, or similar)
- Git

## Installation

### 1. Install Agency

Agency is the foundation of Generacy. Install it globally:

```bash
npm install -g @generacy-ai/agency
```

### 2. Initialize Your Project

Navigate to your project directory and initialize Agency:

```bash
cd your-project
agency init
```

This creates a `.agency/` directory with your configuration.

### 3. Configure Your Agent

Agency works with most AI coding assistants. For Claude Code, add Agency tools to your configuration:

```json title=".claude/settings.json"
{
  "mcpServers": {
    "agency": {
      "command": "agency",
      "args": ["mcp"]
    }
  }
}
```

### 4. Start Using Agency

With Agency configured, your AI assistant now has access to enhanced tools. Try asking:

- "What tools are available from Agency?"
- "Show me the project structure"
- "Help me implement a new feature"

## Next Steps

Congratulations! You've completed the Quick Start. Here's where to go next:

- [Installation Guide](/docs/getting-started/installation) - Detailed installation options
- [Level 1: Agency Only](/docs/getting-started/level-1-agency-only) - Deep dive into Agency
- [Level 2: Agency + Humancy](/docs/getting-started/level-2-agency-humancy) - Add human oversight

## Troubleshooting

### Agency command not found

Make sure npm global binaries are in your PATH:

```bash
export PATH="$PATH:$(npm config get prefix)/bin"
```

### MCP connection issues

Verify Agency is running:

```bash
agency status
```

If you encounter issues, see the [detailed installation guide](/docs/getting-started/installation) or [open an issue](https://github.com/generacy-ai/generacy/issues).
