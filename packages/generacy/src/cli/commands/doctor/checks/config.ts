import { dirname } from 'node:path';
import {
  findConfigFile,
  loadConfig,
  ConfigNotFoundError,
  ConfigParseError,
  ConfigSchemaError,
  ConfigValidationError,
} from '../../../../config/index.js';
import type { CheckDefinition } from '../types.js';

export const configCheck: CheckDefinition = {
  id: 'config',
  label: 'Config File',
  category: 'config',
  dependencies: [],
  priority: 'P1',

  async run() {
    // Locate the config file
    const configPath = findConfigFile();

    if (!configPath) {
      return {
        status: 'fail',
        message: 'Config file not found',
        suggestion:
          'Create .generacy/config.yaml in your project root, or run `generacy init` to generate one',
      };
    }

    // Load and validate the config
    try {
      const config = loadConfig({ configPath });

      // .generacy/config.yaml → .generacy/ → project root
      const projectRoot = dirname(dirname(configPath));

      return {
        status: 'pass',
        message: `Config file is valid (${configPath})`,
        detail: `Project: ${config.project.name} (${config.project.id})`,
        data: {
          configPath,
          projectRoot,
          config,
        },
      };
    } catch (error) {
      if (error instanceof ConfigNotFoundError) {
        return {
          status: 'fail',
          message: 'Config file not found',
          suggestion:
            'Create .generacy/config.yaml in your project root, or run `generacy init` to generate one',
          detail: error.message,
        };
      }

      if (error instanceof ConfigParseError) {
        return {
          status: 'fail',
          message: `Config file has invalid YAML syntax (${configPath})`,
          suggestion:
            'Fix the YAML syntax errors in .generacy/config.yaml — check for incorrect indentation or missing colons',
          detail: error.message,
        };
      }

      if (error instanceof ConfigSchemaError) {
        const fieldErrors = error.errors.errors
          .map((e) => {
            const path = e.path.length > 0 ? e.path.join('.') : 'root';
            return `${path}: ${e.message}`;
          })
          .join('; ');

        return {
          status: 'fail',
          message: `Config file fails schema validation (${configPath})`,
          suggestion: `Fix validation errors: ${fieldErrors}`,
          detail: error.message,
        };
      }

      if (error instanceof ConfigValidationError) {
        return {
          status: 'fail',
          message: `Config file has semantic errors (${configPath})`,
          suggestion: error.message,
          detail: error.conflictingRepos
            ? `Conflicting repos: ${error.conflictingRepos.join(', ')}`
            : undefined,
        };
      }

      // Unexpected error
      throw error;
    }
  },
};
