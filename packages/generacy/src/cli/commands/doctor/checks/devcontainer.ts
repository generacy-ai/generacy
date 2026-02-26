import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CheckDefinition } from '../types.js';

const GENERACY_FEATURE_PREFIX = 'ghcr.io/generacy-ai/generacy/generacy';

export const devcontainerCheck: CheckDefinition = {
  id: 'devcontainer',
  label: 'Dev Container',
  category: 'system',
  dependencies: [],
  priority: 'P2',

  async run(context) {
    // Resolve project root from context or fall back to CWD
    const root = context.projectRoot ?? process.cwd();
    const devcontainerPath = join(root, '.devcontainer', 'devcontainer.json');

    if (!existsSync(devcontainerPath)) {
      return {
        status: 'fail',
        message: '.devcontainer/devcontainer.json not found',
        suggestion:
          'Run `generacy init` to generate dev container configuration',
        detail: `Expected at ${devcontainerPath}`,
      };
    }

    // Read and parse JSON
    let config: Record<string, unknown>;
    try {
      const raw = readFileSync(devcontainerPath, 'utf-8');
      config = JSON.parse(raw) as Record<string, unknown>;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown parse error';
      return {
        status: 'fail',
        message: 'Failed to parse devcontainer.json',
        suggestion:
          'Fix JSON syntax errors in .devcontainer/devcontainer.json',
        detail: message,
      };
    }

    // Check for Generacy feature
    const features = config.features;
    if (features != null && typeof features === 'object') {
      const featureKeys = Object.keys(features as Record<string, unknown>);
      const hasGeneracyFeature = featureKeys.some((key) =>
        key.startsWith(GENERACY_FEATURE_PREFIX),
      );

      if (hasGeneracyFeature) {
        return {
          status: 'pass',
          message:
            '.devcontainer/devcontainer.json present with Generacy feature',
          detail: `File: ${devcontainerPath}`,
        };
      }
    }

    return {
      status: 'warn',
      message:
        '.devcontainer/devcontainer.json exists but missing Generacy feature',
      suggestion: `Add the Generacy dev container feature to .devcontainer/devcontainer.json: "features": { "${GENERACY_FEATURE_PREFIX}": {} }`,
      detail: `File: ${devcontainerPath}`,
    };
  },
};
