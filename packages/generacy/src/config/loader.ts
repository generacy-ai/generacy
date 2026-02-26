import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join, parse } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { ZodError } from 'zod';
import { type GeneracyConfig, validateConfig } from './schema.js';
import { validateSemantics, ConfigValidationError } from './validator.js';

/**
 * Environment variable for explicit config path override
 */
const CONFIG_PATH_ENV = 'GENERACY_CONFIG_PATH';

/**
 * Default config file name
 */
const CONFIG_FILE_NAME = 'config.yaml';

/**
 * Directory containing config file
 */
const CONFIG_DIR_NAME = '.generacy';

/**
 * Error thrown when config file cannot be found
 */
export class ConfigNotFoundError extends Error {
  constructor(
    public readonly startDir: string,
    public readonly searchPath: string[]
  ) {
    super(
      `Config file not found. Searched in:\n${searchPath.map(p => `  - ${p}`).join('\n')}\n\n` +
      `Create a config file at: ${join(startDir, CONFIG_DIR_NAME, CONFIG_FILE_NAME)}`
    );
    this.name = 'ConfigNotFoundError';
  }
}

/**
 * Error thrown when config file contains invalid YAML
 */
export class ConfigParseError extends Error {
  constructor(
    public readonly filePath: string,
    public readonly cause: Error
  ) {
    super(`Failed to parse config file: ${filePath}\n\n${cause.message}`);
    this.name = 'ConfigParseError';
  }
}

/**
 * Error thrown when config file fails schema validation
 */
export class ConfigSchemaError extends Error {
  constructor(
    public readonly filePath: string,
    public readonly errors: ZodError
  ) {
    const errorMessages = errors.errors
      .map(err => {
        const path = err.path.length > 0 ? err.path.join('.') : 'root';
        return `  - ${path}: ${err.message}`;
      })
      .join('\n');

    super(
      `Config validation failed: ${filePath}\n\n` +
      `Validation errors:\n${errorMessages}\n\n` +
      `See documentation for schema reference.`
    );
    this.name = 'ConfigSchemaError';
  }
}

/**
 * Find the config file by walking up the directory tree
 *
 * @param startDir - Directory to start searching from
 * @returns Absolute path to config file, or null if not found
 *
 * Discovery order:
 * 1. Check for .generacy/config.yaml in current directory
 * 2. Walk up parent directories until found
 * 3. Stop at repository root (detected via .git/ directory)
 * 4. Return null if not found
 */
export function findConfigFile(startDir: string = process.cwd()): string | null {
  let currentDir = resolve(startDir);
  const root = parse(currentDir).root;
  const searchPath: string[] = [];

  while (currentDir !== root) {
    const configPath = join(currentDir, CONFIG_DIR_NAME, CONFIG_FILE_NAME);
    searchPath.push(configPath);

    if (existsSync(configPath)) {
      return configPath;
    }

    // Stop at repository root
    if (existsSync(join(currentDir, '.git'))) {
      break;
    }

    currentDir = dirname(currentDir);
  }

  return null;
}

/**
 * Load configuration from a YAML file
 *
 * @param filePath - Path to the config file
 * @returns Parsed configuration object (unvalidated)
 * @throws ConfigParseError if YAML parsing fails
 */
function loadFromFile(filePath: string): unknown {
  const absolutePath = resolve(filePath);

  if (!existsSync(absolutePath)) {
    throw new Error(`Configuration file not found: ${absolutePath}`);
  }

  try {
    const content = readFileSync(absolutePath, 'utf-8');
    return parseYaml(content);
  } catch (error) {
    throw new ConfigParseError(
      absolutePath,
      error instanceof Error ? error : new Error(String(error))
    );
  }
}

/**
 * Parse and validate a YAML config string
 *
 * @param yamlContent - YAML content as string
 * @returns Validated configuration
 * @throws ConfigParseError if YAML parsing fails
 * @throws ConfigSchemaError if validation fails
 * @throws ConfigValidationError if semantic validation fails
 *
 * @example
 * ```typescript
 * const config = parseConfig(`
 *   project:
 *     id: "proj_abc123"
 *     name: "My Project"
 *   repos:
 *     primary: "github.com/acme/main"
 * `);
 * ```
 */
export function parseConfig(yamlContent: string): GeneracyConfig {
  let parsed: unknown;

  try {
    parsed = parseYaml(yamlContent);
  } catch (error) {
    throw new ConfigParseError(
      '<string>',
      error instanceof Error ? error : new Error(String(error))
    );
  }

  // Structural validation (Zod schema)
  let config: GeneracyConfig;
  try {
    config = validateConfig(parsed);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new ConfigSchemaError('<string>', error);
    }
    throw error;
  }

  // Semantic validation (custom validators)
  validateSemantics(config);

  return config;
}

/**
 * Options for loading configuration
 */
export interface LoadConfigOptions {
  /**
   * Directory to start searching from
   * Default: process.cwd()
   */
  startDir?: string;

  /**
   * Explicit config file path (skips discovery)
   * Default: undefined (will search using findConfigFile)
   */
  configPath?: string;
}

/**
 * Load and validate configuration from filesystem
 *
 * Discovery process:
 * 1. If GENERACY_CONFIG_PATH env var is set, use that path
 * 2. If options.configPath is provided, use that path
 * 3. Otherwise, search for .generacy/config.yaml using findConfigFile
 *
 * @param options - Loading options
 * @returns Validated configuration
 * @throws ConfigNotFoundError if config file not found
 * @throws ConfigParseError if YAML parsing fails
 * @throws ConfigSchemaError if validation fails
 * @throws ConfigValidationError if semantic validation fails
 *
 * @example
 * ```typescript
 * // Auto-discover config
 * const config = loadConfig();
 *
 * // Explicit path
 * const config = loadConfig({ configPath: '/path/to/config.yaml' });
 *
 * // Start search from specific directory
 * const config = loadConfig({ startDir: '/workspace/project' });
 * ```
 */
export function loadConfig(options: LoadConfigOptions = {}): GeneracyConfig {
  const { startDir = process.cwd(), configPath } = options;

  // Priority 1: Environment variable
  const envConfigPath = process.env[CONFIG_PATH_ENV];
  if (envConfigPath) {
    const absolutePath = resolve(envConfigPath);
    if (!existsSync(absolutePath)) {
      throw new ConfigNotFoundError(startDir, [absolutePath]);
    }
    const rawConfig = loadFromFile(absolutePath);

    // Structural validation
    let config: GeneracyConfig;
    try {
      config = validateConfig(rawConfig);
    } catch (error) {
      if (error instanceof ZodError) {
        throw new ConfigSchemaError(absolutePath, error);
      }
      throw error;
    }

    // Semantic validation
    validateSemantics(config);

    return config;
  }

  // Priority 2: Explicit path from options
  if (configPath) {
    const absolutePath = resolve(configPath);
    if (!existsSync(absolutePath)) {
      throw new ConfigNotFoundError(startDir, [absolutePath]);
    }
    const rawConfig = loadFromFile(absolutePath);

    // Structural validation
    let config: GeneracyConfig;
    try {
      config = validateConfig(rawConfig);
    } catch (error) {
      if (error instanceof ZodError) {
        throw new ConfigSchemaError(absolutePath, error);
      }
      throw error;
    }

    // Semantic validation
    validateSemantics(config);

    return config;
  }

  // Priority 3: Auto-discover
  const discoveredPath = findConfigFile(startDir);
  if (!discoveredPath) {
    // Build search path for error message
    const searchPath: string[] = [];
    let currentDir = resolve(startDir);
    const root = parse(currentDir).root;

    while (currentDir !== root) {
      searchPath.push(join(currentDir, CONFIG_DIR_NAME, CONFIG_FILE_NAME));

      if (existsSync(join(currentDir, '.git'))) {
        break;
      }

      currentDir = dirname(currentDir);
    }

    throw new ConfigNotFoundError(startDir, searchPath);
  }

  const rawConfig = loadFromFile(discoveredPath);

  // Structural validation
  let config: GeneracyConfig;
  try {
    config = validateConfig(rawConfig);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new ConfigSchemaError(discoveredPath, error);
    }
    throw error;
  }

  // Semantic validation
  validateSemantics(config);

  return config;
}
