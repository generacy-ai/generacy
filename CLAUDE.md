# Generacy

Frontend application for Generacy.

## Development

```bash
pnpm install
pnpm dev
```

## MCP Testing Tools

For browser automation and UI testing, see:
[/workspaces/triad-development/docs/MCP_TESTING_TOOLS.md](/workspaces/triad-development/docs/MCP_TESTING_TOOLS.md)

Use Playwright MCP to automate testing of the frontend:
1. Start the dev server
2. Use `browser_navigate` to open the app
3. Use `browser_snapshot` to inspect elements
4. Use `browser_click`, `browser_type`, etc. to interact

## Development Stack

For Firebase emulators (required for backend):
```bash
/workspaces/triad-development/scripts/stack start
source /workspaces/triad-development/scripts/stack-env.sh
```

See [/workspaces/triad-development/docs/DEVELOPMENT_STACK.md](/workspaces/triad-development/docs/DEVELOPMENT_STACK.md)
