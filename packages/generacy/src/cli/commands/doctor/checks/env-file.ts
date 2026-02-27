import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse as parseDotenv } from 'dotenv';
import type { CheckDefinition } from '../types.js';

const REQUIRED_KEYS = ['GITHUB_TOKEN', 'ANTHROPIC_API_KEY'] as const;

export const envFileCheck: CheckDefinition = {
  id: 'env-file',
  label: 'Env File',
  category: 'config',
  dependencies: ['config'],
  priority: 'P1',

  async run(context) {
    if (!context.configPath) {
      return {
        status: 'skip',
        message: 'Skipped — config path not available',
      };
    }

    const envPath = join(dirname(context.configPath), 'generacy.env');

    if (!existsSync(envPath)) {
      return {
        status: 'fail',
        message: `Env file not found (${envPath})`,
        suggestion:
          'Run `generacy init` to generate the env file, or create `.generacy/generacy.env` manually with required keys: GITHUB_TOKEN, ANTHROPIC_API_KEY',
      };
    }

    const raw = readFileSync(envPath, 'utf-8');
    const envVars = parseDotenv(Buffer.from(raw));

    const missingKeys = REQUIRED_KEYS.filter((key) => !(key in envVars));

    if (missingKeys.length > 0) {
      return {
        status: 'fail',
        message: `Env file is missing required keys: ${missingKeys.join(', ')}`,
        suggestion:
          'Run `generacy init` to generate the env file, or create `.generacy/generacy.env` manually with required keys: GITHUB_TOKEN, ANTHROPIC_API_KEY',
        detail: `File: ${envPath}`,
        data: { envVars },
      };
    }

    const emptyKeys = REQUIRED_KEYS.filter(
      (key) => key in envVars && envVars[key]!.trim() === '',
    );

    if (emptyKeys.length > 0) {
      return {
        status: 'warn',
        message: `Env file has empty values for: ${emptyKeys.join(', ')}`,
        suggestion: `Set values for ${emptyKeys.join(', ')} in ${envPath}`,
        detail: `File: ${envPath}`,
        data: { envVars },
      };
    }

    return {
      status: 'pass',
      message: `.generacy/generacy.env present with required keys`,
      detail: `File: ${envPath}`,
      data: { envVars },
    };
  },
};
