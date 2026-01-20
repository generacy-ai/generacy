---
sidebar_position: 2
---

# Agency Plugins

Agency plugins add MCP tools to enhance AI coding assistant capabilities.

## Overview

Agency plugins provide:

- **Custom Tools** - Project-specific actions
- **Context Providers** - Additional project context
- **File Processors** - Custom file handling

## Quick Start

### 1. Create the Plugin

```bash
mkdir agency-plugin-example
cd agency-plugin-example
npm init -y
npm install @generacy-ai/agency --save-peer
npm install typescript --save-dev
```

### 2. Define the Manifest

```json title="manifest.json"
{
  "name": "example-agency-plugin",
  "version": "1.0.0",
  "type": "agency",
  "description": "Example Agency plugin with custom tools",
  "tools": [
    {
      "name": "get-todos",
      "description": "List TODO comments in the codebase",
      "schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "string",
            "description": "Directory path to search"
          },
          "includeFixed": {
            "type": "boolean",
            "default": false
          }
        }
      }
    }
  ],
  "contextProviders": [
    {
      "name": "project-conventions",
      "description": "Project coding conventions"
    }
  ]
}
```

### 3. Implement the Plugin

```typescript title="src/index.ts"
import {
  AgencyPlugin,
  Tool,
  ToolResult,
  ContextProvider,
} from '@generacy-ai/agency';
import * as fs from 'fs/promises';
import * as path from 'path';

interface TodoItem {
  file: string;
  line: number;
  text: string;
  type: 'TODO' | 'FIXME' | 'HACK';
}

export default class ExamplePlugin implements AgencyPlugin {
  name = 'example-agency-plugin';
  version = '1.0.0';

  private projectRoot: string;

  constructor(options: { projectRoot: string }) {
    this.projectRoot = options.projectRoot;
  }

  tools: Tool[] = [
    {
      name: 'get-todos',
      description: 'List TODO comments in the codebase',
      handler: this.getTodos.bind(this),
    },
  ];

  contextProviders: ContextProvider[] = [
    {
      name: 'project-conventions',
      description: 'Project coding conventions',
      provider: this.getConventions.bind(this),
    },
  ];

  async initialize(): Promise<void> {
    // Validate project root exists
    await fs.access(this.projectRoot);
  }

  async getTodos(params: {
    path?: string;
    includeFixed?: boolean;
  }): Promise<ToolResult> {
    const searchPath = params.path
      ? path.join(this.projectRoot, params.path)
      : this.projectRoot;

    const todos = await this.findTodos(searchPath);

    return {
      success: true,
      data: {
        count: todos.length,
        items: todos,
      },
    };
  }

  private async findTodos(dir: string): Promise<TodoItem[]> {
    const todos: TodoItem[] = [];
    const todoPattern = /\/\/\s*(TODO|FIXME|HACK):\s*(.+)/gi;

    const files = await this.getSourceFiles(dir);

    for (const file of files) {
      const content = await fs.readFile(file, 'utf-8');
      const lines = content.split('\n');

      lines.forEach((line, index) => {
        const match = todoPattern.exec(line);
        if (match) {
          todos.push({
            file: path.relative(this.projectRoot, file),
            line: index + 1,
            type: match[1].toUpperCase() as TodoItem['type'],
            text: match[2].trim(),
          });
        }
      });
    }

    return todos;
  }

  private async getSourceFiles(dir: string): Promise<string[]> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const files: string[] = [];

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        files.push(...(await this.getSourceFiles(fullPath)));
      } else if (entry.isFile() && this.isSourceFile(entry.name)) {
        files.push(fullPath);
      }
    }

    return files;
  }

  private isSourceFile(filename: string): boolean {
    const extensions = ['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs'];
    return extensions.some((ext) => filename.endsWith(ext));
  }

  async getConventions(): Promise<string> {
    const conventionsPath = path.join(
      this.projectRoot,
      '.agency',
      'conventions.md'
    );

    try {
      return await fs.readFile(conventionsPath, 'utf-8');
    } catch {
      return 'No conventions file found.';
    }
  }

  async shutdown(): Promise<void> {
    // Cleanup if needed
  }
}
```

## Tool Development

### Tool Schema

Define clear, typed schemas:

```json
{
  "name": "run-tests",
  "description": "Run test suite with optional filtering",
  "schema": {
    "type": "object",
    "properties": {
      "pattern": {
        "type": "string",
        "description": "Test file pattern (e.g., '*.test.ts')"
      },
      "watch": {
        "type": "boolean",
        "description": "Run in watch mode",
        "default": false
      },
      "coverage": {
        "type": "boolean",
        "description": "Generate coverage report",
        "default": false
      }
    }
  }
}
```

### Tool Handler

```typescript
async runTests(params: {
  pattern?: string;
  watch?: boolean;
  coverage?: boolean;
}): Promise<ToolResult> {
  const args = ['test'];

  if (params.pattern) {
    args.push('--testPathPattern', params.pattern);
  }
  if (params.watch) {
    args.push('--watch');
  }
  if (params.coverage) {
    args.push('--coverage');
  }

  try {
    const result = await this.runCommand('npm', args);
    return {
      success: result.exitCode === 0,
      data: {
        output: result.stdout,
        exitCode: result.exitCode,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: `Test run failed: ${error}`,
    };
  }
}
```

## Context Providers

Context providers give agents additional information:

```typescript
contextProviders: ContextProvider[] = [
  {
    name: 'recent-changes',
    description: 'Recent code changes',
    provider: async () => {
      const changes = await this.getRecentChanges();
      return formatChanges(changes);
    },
  },
  {
    name: 'test-coverage',
    description: 'Current test coverage',
    provider: async () => {
      const coverage = await this.getCoverage();
      return formatCoverage(coverage);
    },
  },
];
```

## File Processors

Process specific file types:

```typescript
fileProcessors: FileProcessor[] = [
  {
    pattern: '*.proto',
    processor: async (file) => {
      const content = await fs.readFile(file, 'utf-8');
      return {
        type: 'protobuf',
        messages: parseProto(content),
      };
    },
  },
];
```

## Testing Plugins

### Unit Tests

```typescript
import { describe, it, expect } from 'vitest';
import ExamplePlugin from './index';

describe('ExamplePlugin', () => {
  const plugin = new ExamplePlugin({ projectRoot: '/tmp/test-project' });

  it('should find TODO comments', async () => {
    const result = await plugin.getTodos({ path: 'src' });

    expect(result.success).toBe(true);
    expect(result.data.items).toBeInstanceOf(Array);
  });
});
```

### Integration Tests

```bash
# Test with Agency
agency plugin test ./dist

# Verify tools are registered
agency tools list
```

## Example Plugins

### Database Plugin

```typescript
export default class DatabasePlugin implements AgencyPlugin {
  tools = [
    {
      name: 'db-query',
      description: 'Execute read-only SQL query',
      handler: async (params: { query: string }) => {
        // Validate query is SELECT only
        if (!params.query.trim().toLowerCase().startsWith('select')) {
          return { success: false, error: 'Only SELECT queries allowed' };
        }

        const result = await this.db.query(params.query);
        return { success: true, data: result };
      },
    },
    {
      name: 'db-schema',
      description: 'Get database schema',
      handler: async () => {
        const schema = await this.db.getSchema();
        return { success: true, data: schema };
      },
    },
  ];
}
```

### Docker Plugin

```typescript
export default class DockerPlugin implements AgencyPlugin {
  tools = [
    {
      name: 'docker-ps',
      description: 'List running containers',
      handler: async () => {
        const containers = await docker.listContainers();
        return { success: true, data: containers };
      },
    },
    {
      name: 'docker-logs',
      description: 'Get container logs',
      handler: async (params: { container: string; lines?: number }) => {
        const logs = await docker.logs(params.container, {
          tail: params.lines || 100,
        });
        return { success: true, data: logs };
      },
    },
  ];
}
```

## Next Steps

- [Manifest Reference](/docs/plugins/manifest-reference) - Complete manifest documentation
- [Humancy Plugins](/docs/plugins/humancy-plugins) - Add human oversight
