# Generacy

Message routing system connecting Agency instances with Humancy.

## Overview

Generacy is a message routing and coordination system that enables communication between Agency AI instances and Humancy (human oversight). It provides the infrastructure for distributed AI agent coordination, message queuing, and human-in-the-loop workflows.

## Quick Start

### Prerequisites

- Node.js >= 20.0.0
- pnpm (recommended) or npm

### Installation

```bash
pnpm install
```

### Development

```bash
# Start development server
pnpm dev

# Build project
pnpm build

# Run tests
pnpm test

# Watch mode for tests
pnpm test:watch

# Lint code
pnpm lint

# Fix linting issues
pnpm lint:fix
```

## Project Structure

```
generacy/
├── packages/          # Monorepo packages
├── src/              # Core source code
├── tests/            # Test files
├── docs/             # Documentation site (Docusaurus)
├── docker/           # Docker configurations
├── scripts/          # Build and utility scripts
└── specs/            # Feature specifications
```

## Development Stack

For Firebase emulators and backend services, use the development stack:

```bash
# Start the stack
/workspaces/tetrad-development/scripts/stack start

# Load environment variables
source /workspaces/tetrad-development/scripts/stack-env.sh
```

See [Development Stack Documentation](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/DEVELOPMENT_STACK.md) for details.

## Testing

### MCP Testing Tools

For browser automation and UI testing with Playwright:

See [MCP Testing Tools](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/MCP_TESTING_TOOLS.md)

### Running Tests

```bash
# Run all tests
pnpm test

# Watch mode
pnpm test:watch
```

## Publishing

### VS Code Extensions

This repository includes VS Code extension development and publishing infrastructure.

**Publisher Details**:
- Publisher ID: `generacy-ai`
- Marketplace: [https://marketplace.visualstudio.com/publishers/generacy-ai](https://marketplace.visualstudio.com/publishers/generacy-ai)

**Documentation**:
- [VS Code Marketplace Setup Guide](/docs/publishing/vscode-marketplace-setup.md) - Complete guide for publisher account, PAT management, and CI/CD publishing

## Documentation

- **API Documentation**: See `/docs/api/`
- **Development Stack**: [tetrad-development/docs/DEVELOPMENT_STACK.md](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/DEVELOPMENT_STACK.md)
- **MCP Testing Tools**: [tetrad-development/docs/MCP_TESTING_TOOLS.md](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/MCP_TESTING_TOOLS.md)
- **Publishing Guide**: [/docs/publishing/vscode-marketplace-setup.md](/docs/publishing/vscode-marketplace-setup.md)

## Architecture

Generacy is built as a monorepo with multiple packages:

- **Message Router**: Core routing engine for Agency-Humancy communication
- **Redis Integration**: Queue management using ioredis
- **Express API**: REST endpoints for message submission and retrieval
- **TypeScript**: Full type safety across the codebase

## Contributing

This is a private repository for Generacy AI development. For team members:

1. Create feature branches from `develop`
2. Follow existing code style and linting rules
3. Write tests for new functionality
4. Submit PRs for review before merging

## Environment Variables

Copy `.env.example` to `.env` and configure:

```bash
cp .env.example .env
```

See `.env.example` for required configuration options.

## License

MIT

## Contact

- **GitHub Organization**: [generacy-ai](https://github.com/generacy-ai)
- **Support**: See individual package documentation
