---
sidebar_position: 2
---

# Installation Guide

This guide covers detailed installation options for the Generacy ecosystem.

## System Requirements

| Requirement | Minimum | Recommended |
|-------------|---------|-------------|
| Node.js | 18.x | 20.x LTS |
| npm | 9.x | 10.x |
| Memory | 4GB | 8GB |
| Disk | 500MB | 1GB |

## Installation Methods

### npm (Recommended)

Install Agency globally using npm:

```bash
npm install -g @generacy-ai/agency
```

### pnpm

```bash
pnpm add -g @generacy-ai/agency
```

### From Source

For development or customization:

```bash
git clone https://github.com/generacy-ai/generacy.git
cd generacy/packages/agency
npm install
npm link
```

## Component Installation

### Agency Only (Level 1)

For basic agent enhancement:

```bash
npm install -g @generacy-ai/agency
```

### Agency + Humancy (Level 2)

Add human oversight capabilities:

```bash
npm install -g @generacy-ai/agency @generacy-ai/humancy
```

### Full Local Stack (Level 3)

Install all components:

```bash
npm install -g @generacy-ai/agency @generacy-ai/humancy @generacy-ai/generacy
```

## Configuration

### Project Initialization

After installation, initialize your project:

```bash
cd your-project
agency init
```

This creates the following structure:

```
your-project/
├── .agency/
│   ├── config.json       # Agency configuration
│   └── plugins/          # Local plugins directory
└── ...
```

### Agent Configuration

Configure your AI assistant to use Agency. See the [Agency Configuration](/docs/guides/agency/configuration) guide for detailed instructions on setting up:

- Claude Code
- Cursor
- Continue
- Other MCP-compatible assistants

## Verification

Verify your installation:

```bash
# Check Agency version
agency --version

# Check status
agency status

# List available tools
agency tools list
```

## Updating

Update to the latest version:

```bash
npm update -g @generacy-ai/agency
```

## Uninstallation

To remove Generacy components:

```bash
npm uninstall -g @generacy-ai/agency @generacy-ai/humancy @generacy-ai/generacy
```

Remove project configuration:

```bash
rm -rf .agency .humancy
```

## Next Steps

- [Level 1: Agency Only](/docs/getting-started/level-1-agency-only) - Start with Agency
- [Agency Configuration](/docs/guides/agency/configuration) - Advanced configuration
