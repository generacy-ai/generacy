/**
 * Environment configuration command handler for Generacy VS Code extension.
 *
 * Implements the "Generacy: Configure Environment" command which guides users
 * through setting up `.generacy/generacy.env` with required tokens:
 *   - GITHUB_TOKEN (with `gh auth token` integration)
 *   - ANTHROPIC_API_KEY
 *   - GENERACY_API_KEY (optional)
 *
 * Validates tokens via API calls and writes the env file preserving comments.
 */
import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { ENV_FILE_PATH, ENV_TEMPLATE_NAME, ENV_REQUIRED_KEYS } from '../constants';
import { getLogger } from '../utils';

const execFileAsync = promisify(execFile);

// ============================================================================
// Types
// ============================================================================

type ValidationResult =
  | { status: 'valid'; message: string; detail?: string }
  | { status: 'invalid'; message: string; suggestion: string }
  | { status: 'network_error'; message: string }
  | { status: 'warning'; message: string; detail: string };

type RecoveryAction = 'reenter' | 'skip' | 'cancel';

// ============================================================================
// Embedded Default Template
// ============================================================================

const DEFAULT_ENV_TEMPLATE = `# .generacy/generacy.env
#
# Environment configuration for Generacy.
# This file contains secrets — DO NOT commit to version control.
#
# Required keys: GITHUB_TOKEN, ANTHROPIC_API_KEY
# Run "Generacy: Configure Environment" in VS Code to set values interactively.

# ============================================================================
# GitHub Integration
# ============================================================================

# GitHub Personal Access Token (PAT) with repo permissions
# Required for: Creating PRs, reading repositories, managing issues
# Get one at: https://github.com/settings/tokens/new
# Minimum scopes: repo, workflow
GITHUB_TOKEN=

# ============================================================================
# AI Agent Configuration
# ============================================================================

# Anthropic API key for Claude Code agent
# Required for: Running AI-powered development tasks
# Get one at: https://console.anthropic.com/settings/keys
ANTHROPIC_API_KEY=

# ============================================================================
# Project Configuration
# ============================================================================

# Your Generacy project ID (auto-populated from config.yaml)
PROJECT_ID=

# ============================================================================
# Local Development Configuration
# ============================================================================

# Redis URL for task queue
REDIS_URL=redis://redis:6379

# Logging level (debug, info, warn, error)
LOG_LEVEL=info

# ============================================================================
# Optional: Advanced Configuration
# ============================================================================

# Uncomment and configure these if you need custom behavior:

# Base branch for pull requests
# BASE_BRANCH=develop

# API endpoint for Generacy cloud service
# GENERACY_API_URL=https://api.generacy.ai

# Cloud features API key (optional)
# GENERACY_API_KEY=
`;

// ============================================================================
// Main Entry Point
// ============================================================================

/**
 * Handle the "Generacy: Configure Environment" command.
 * Guides the user through creating and populating `.generacy/generacy.env`.
 */
export async function handleConfigureEnvironment(): Promise<void> {
  const logger = getLogger();
  logger.info('Command: Configure Environment');

  // Step 1: Resolve workspace root
  const workspaceFolder = await resolveWorkspaceRoot();
  if (!workspaceFolder) {
    return;
  }

  // Step 2: Check that this is a Generacy project
  const isProject = await checkGeneracyProject(workspaceFolder.uri);
  if (!isProject) {
    return;
  }

  // Step 3: Ensure env file exists (copy from template or create default)
  const envUri = await ensureEnvFile(workspaceFolder.uri);

  // Step 4: Read current env file to detect existing values
  const currentEnv = await readEnvValues(envUri);

  // Step 5: Prompt for required tokens
  const updates: Record<string, string> = {};
  let skippedValidations = 0;

  // --- GITHUB_TOKEN ---
  const githubResult = await promptAndValidateGitHubToken(currentEnv['GITHUB_TOKEN']);
  if (githubResult === 'cancel') {
    logger.info('Environment configuration cancelled by user');
    return;
  }
  if (githubResult === 'skip') {
    skippedValidations++;
  } else if (githubResult) {
    updates['GITHUB_TOKEN'] = githubResult.token;
    if (githubResult.skippedValidation) {
      skippedValidations++;
    }
  }

  // --- ANTHROPIC_API_KEY ---
  const anthropicResult = await promptAndValidateAnthropicKey(currentEnv['ANTHROPIC_API_KEY']);
  if (anthropicResult === 'cancel') {
    logger.info('Environment configuration cancelled by user');
    return;
  }
  if (anthropicResult === 'skip') {
    skippedValidations++;
  } else if (anthropicResult) {
    updates['ANTHROPIC_API_KEY'] = anthropicResult.token;
    if (anthropicResult.skippedValidation) {
      skippedValidations++;
    }
  }

  // --- GENERACY_API_KEY (optional) ---
  const generacyKey = await promptGeneracyApiKey();
  if (generacyKey) {
    updates['GENERACY_API_KEY'] = generacyKey;
  }

  // Step 6: Write updates to env file
  if (Object.keys(updates).length > 0) {
    await writeEnvFile(envUri, updates);
    logger.info('Environment file updated', {
      keysUpdated: Object.keys(updates).length,
    });
  }

  // Step 7: Show summary
  const configuredCount = ENV_REQUIRED_KEYS.filter(
    (key) => updates[key] || currentEnv[key],
  ).length;

  let message = `Environment configured successfully. ${configuredCount} of ${ENV_REQUIRED_KEYS.length} required keys set.`;
  if (skippedValidations > 0) {
    message += ' Run again to validate skipped tokens.';
  }

  await vscode.window.showInformationMessage(message);
  logger.info('Environment configuration complete', {
    configuredCount,
    skippedValidations,
  });
}

// ============================================================================
// T005a: Workspace Resolution
// ============================================================================

async function resolveWorkspaceRoot(): Promise<vscode.WorkspaceFolder | undefined> {
  const folders = vscode.workspace.workspaceFolders;

  if (!folders || folders.length === 0) {
    await vscode.window.showErrorMessage(
      'No workspace folder open. Please open a folder to configure the environment.',
    );
    return undefined;
  }

  if (folders.length === 1) {
    return folders[0];
  }

  // Multi-root workspace — let the user pick
  const selected = await vscode.window.showQuickPick(
    folders.map((f) => ({ label: f.name, description: f.uri.fsPath, folder: f })),
    { placeHolder: 'Select workspace folder to configure' },
  );

  return selected?.folder;
}

// ============================================================================
// T005b: Project Detection
// ============================================================================

async function checkGeneracyProject(root: vscode.Uri): Promise<boolean> {
  const generacyDir = vscode.Uri.joinPath(root, '.generacy');

  try {
    await vscode.workspace.fs.stat(generacyDir);
    return true;
  } catch {
    const action = await vscode.window.showErrorMessage(
      'No .generacy directory found. This does not appear to be a Generacy project.',
      'Run generacy init',
    );

    if (action === 'Run generacy init') {
      await runGeneracyInit(root);
    }

    return false;
  }
}

async function runGeneracyInit(root: vscode.Uri): Promise<void> {
  const logger = getLogger();

  // Check if generacy CLI is available
  try {
    await execFileAsync('which', ['generacy'], { timeout: 5_000 });
  } catch {
    await vscode.window.showWarningMessage(
      'Generacy CLI not found. Install it first: npm install -g @generacy/cli',
    );
    return;
  }

  // Open terminal and run generacy init
  const terminal = vscode.window.createTerminal({
    name: 'Generacy Init',
    cwd: root,
  });
  terminal.show();
  terminal.sendText('generacy init');
  logger.info('Opened terminal for generacy init');
}

// ============================================================================
// T005c: Env File Creation
// ============================================================================

async function ensureEnvFile(root: vscode.Uri): Promise<vscode.Uri> {
  const envUri = vscode.Uri.joinPath(root, ENV_FILE_PATH);

  // Priority 1: file already exists
  try {
    await vscode.workspace.fs.stat(envUri);
    return envUri;
  } catch {
    // File doesn't exist, continue
  }

  // Priority 2: copy from workspace template
  const templateUri = vscode.Uri.joinPath(root, '.generacy', ENV_TEMPLATE_NAME);
  try {
    await vscode.workspace.fs.stat(templateUri);
    await vscode.workspace.fs.copy(templateUri, envUri);
    getLogger().info('Created env file from workspace template');
    return envUri;
  } catch {
    // Template doesn't exist, continue
  }

  // Priority 3: write embedded default template
  const encoder = new TextEncoder();
  // Ensure .generacy directory exists
  const generacyDir = vscode.Uri.joinPath(root, '.generacy');
  try {
    await vscode.workspace.fs.createDirectory(generacyDir);
  } catch {
    // Directory may already exist
  }
  await vscode.workspace.fs.writeFile(envUri, encoder.encode(DEFAULT_ENV_TEMPLATE));
  getLogger().info('Created env file from embedded default template');
  return envUri;
}

// ============================================================================
// T005d: GitHub Token Prompting
// ============================================================================

type TokenResult = { token: string; skippedValidation: boolean } | 'skip' | 'cancel';

async function promptGitHubToken(currentValue?: string): Promise<string | undefined> {
  const items: vscode.QuickPickItem[] = [
    {
      label: '$(terminal) Use gh auth token',
      description: 'Automatically get token from GitHub CLI',
    },
    {
      label: '$(key) Enter token manually',
      description: 'Paste a GitHub Personal Access Token',
    },
  ];

  if (currentValue) {
    items.unshift({
      label: '$(check) Keep current token',
      description: maskToken(currentValue),
    });
  }

  const choice = await vscode.window.showQuickPick(items, {
    placeHolder: 'How would you like to configure GITHUB_TOKEN?',
  });

  if (!choice) {
    return undefined;
  }

  if (choice.label.includes('Keep current')) {
    return currentValue;
  }

  if (choice.label.includes('gh auth token')) {
    const ghToken = await getGhAuthToken();
    if (ghToken) {
      return ghToken;
    }
    // Fall through to manual entry on failure
    await vscode.window.showWarningMessage(
      'Could not get token from GitHub CLI. Please enter it manually.',
    );
  }

  // Manual entry
  const prompt = currentValue
    ? `Enter GitHub token (current: ${maskToken(currentValue)})`
    : 'Enter GitHub Personal Access Token';

  return vscode.window.showInputBox({
    prompt,
    placeHolder: 'ghp_xxxxxxxxxxxxxxxxxxxx',
    password: true,
    ignoreFocusOut: true,
  });
}

async function getGhAuthToken(): Promise<string | undefined> {
  const logger = getLogger();
  try {
    const { stdout } = await execFileAsync('gh', ['auth', 'token'], {
      timeout: 5_000,
    });
    const token = stdout.trim();
    if (token) {
      logger.info('Retrieved GitHub token via gh auth token');
      return token;
    }
  } catch (error) {
    logger.warn('Failed to get token from gh CLI', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return undefined;
}

// ============================================================================
// T005e: GitHub Token Validation
// ============================================================================

// Adapted from packages/generacy/src/cli/commands/doctor/checks/github-token.ts
async function validateGitHubToken(token: string): Promise<ValidationResult> {
  try {
    const response = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json',
      },
      signal: AbortSignal.timeout(5_000),
    });

    if (response.status === 401 || response.status === 403) {
      return {
        status: 'invalid',
        message: 'GitHub token is invalid or expired.',
        suggestion: 'Generate a new token at https://github.com/settings/tokens/new',
      };
    }

    if (!response.ok) {
      return {
        status: 'network_error',
        message: `GitHub API returned unexpected status: ${response.status}`,
      };
    }

    // Check scopes (classic tokens expose X-OAuth-Scopes)
    const scopes = response.headers.get('x-oauth-scopes');
    if (scopes !== null) {
      const scopeList = scopes.split(',').map((s) => s.trim());
      const requiredScopes = ['repo', 'workflow'];
      const missingScopes = requiredScopes.filter((s) => !scopeList.includes(s));

      if (missingScopes.length > 0) {
        return {
          status: 'warning',
          message: 'GitHub token is valid but may be missing required scopes.',
          detail: `Missing scopes: ${missingScopes.join(', ')}. Fine-grained tokens may not report scopes — this can be ignored if using a fine-grained token.`,
        };
      }
    }

    return {
      status: 'valid',
      message: 'GitHub token is valid.',
    };
  } catch (error) {
    return {
      status: 'network_error',
      message: `Could not validate GitHub token: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// ============================================================================
// T005f: Anthropic Key Prompting
// ============================================================================

async function promptAnthropicKey(currentValue?: string): Promise<string | undefined> {
  const prompt = currentValue
    ? `Enter Anthropic API key (current: ${maskToken(currentValue)})`
    : 'Enter Anthropic API key';

  return vscode.window.showInputBox({
    prompt,
    placeHolder: 'sk-ant-xxxxxxxxxxxxxxxxxxxx',
    password: true,
    ignoreFocusOut: true,
  });
}

// ============================================================================
// T005g: Anthropic Key Validation
// ============================================================================

// Adapted from packages/generacy/src/cli/commands/doctor/checks/anthropic-key.ts
async function validateAnthropicKey(key: string): Promise<ValidationResult> {
  try {
    const response = await fetch('https://api.anthropic.com/v1/models', {
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      signal: AbortSignal.timeout(5_000),
    });

    if (response.status === 401 || response.status === 403) {
      return {
        status: 'invalid',
        message: 'Anthropic API key is invalid or expired.',
        suggestion: 'Generate a new key at https://console.anthropic.com/settings/keys',
      };
    }

    if (!response.ok) {
      return {
        status: 'network_error',
        message: `Anthropic API returned unexpected status: ${response.status}`,
      };
    }

    return {
      status: 'valid',
      message: 'Anthropic API key is valid.',
    };
  } catch (error) {
    return {
      status: 'network_error',
      message: `Could not validate Anthropic API key: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// ============================================================================
// T005h: Generacy API Key Prompting (Optional)
// ============================================================================

async function promptGeneracyApiKey(): Promise<string | undefined> {
  const choice = await vscode.window.showQuickPick(
    [
      { label: 'Skip', description: 'Not needed for local development' },
      { label: 'Configure', description: 'Enter a GENERACY_API_KEY for cloud features' },
    ],
    { placeHolder: 'Would you like to configure optional cloud features (GENERACY_API_KEY)?' },
  );

  if (!choice || choice.label === 'Skip') {
    return undefined;
  }

  return vscode.window.showInputBox({
    prompt: 'Enter Generacy API key (optional — for cloud features)',
    password: true,
    ignoreFocusOut: true,
  });
}

// ============================================================================
// T005i: Validation Failure Recovery
// ============================================================================

async function handleValidationFailure(
  keyName: string,
  result: ValidationResult,
): Promise<RecoveryAction> {
  const detail =
    result.status === 'invalid'
      ? `${result.message}\n${result.suggestion}`
      : result.message;

  const choice = await vscode.window.showQuickPick(
    [
      { label: 'Re-enter', description: `Enter a different ${keyName}` },
      { label: 'Skip', description: 'Continue without setting this key' },
      { label: 'Cancel setup', description: 'Stop environment configuration' },
    ],
    {
      placeHolder: `${keyName} validation failed: ${detail}`,
    },
  );

  if (!choice || choice.label === 'Cancel setup') {
    return 'cancel';
  }
  return choice.label === 'Re-enter' ? 'reenter' : 'skip';
}

// ============================================================================
// Combined Prompt + Validate Flows
// ============================================================================

async function promptAndValidateGitHubToken(
  currentValue?: string,
): Promise<TokenResult> {
  const logger = getLogger();

  for (;;) {
    const token = await promptGitHubToken(currentValue);
    if (token === undefined) {
      return 'skip';
    }

    // If user chose to keep current token, skip validation
    if (token === currentValue && currentValue) {
      return { token, skippedValidation: false };
    }

    logger.info('Validating GitHub token...');
    const result = await validateGitHubToken(token);

    switch (result.status) {
      case 'valid':
        await vscode.window.showInformationMessage(result.message);
        return { token, skippedValidation: false };

      case 'warning':
        await vscode.window.showWarningMessage(`${result.message} ${result.detail}`);
        return { token, skippedValidation: false };

      case 'network_error':
        await vscode.window.showWarningMessage(
          `${result.message} Token saved without validation.`,
        );
        return { token, skippedValidation: true };

      case 'invalid': {
        const action = await handleValidationFailure('GITHUB_TOKEN', result);
        if (action === 'cancel') return 'cancel';
        if (action === 'skip') return 'skip';
        // action === 'reenter' → loop again
        currentValue = undefined;
        break;
      }
    }
  }
}

async function promptAndValidateAnthropicKey(
  currentValue?: string,
): Promise<TokenResult> {
  const logger = getLogger();

  for (;;) {
    const key = await promptAnthropicKey(currentValue);
    if (key === undefined) {
      return 'skip';
    }

    logger.info('Validating Anthropic API key...');
    const result = await validateAnthropicKey(key);

    switch (result.status) {
      case 'valid':
        await vscode.window.showInformationMessage(result.message);
        return { token: key, skippedValidation: false };

      case 'warning':
        await vscode.window.showWarningMessage(`${result.message} ${result.detail}`);
        return { token: key, skippedValidation: false };

      case 'network_error':
        await vscode.window.showWarningMessage(
          `${result.message} Key saved without validation.`,
        );
        return { token: key, skippedValidation: true };

      case 'invalid': {
        const action = await handleValidationFailure('ANTHROPIC_API_KEY', result);
        if (action === 'cancel') return 'cancel';
        if (action === 'skip') return 'skip';
        // action === 'reenter' → loop again
        currentValue = undefined;
        break;
      }
    }
  }
}

// ============================================================================
// T005j: Env File Writing
// ============================================================================

async function writeEnvFile(
  envUri: vscode.Uri,
  updates: Record<string, string>,
): Promise<void> {
  const raw = await vscode.workspace.fs.readFile(envUri);
  let content = Buffer.from(raw).toString('utf-8');

  for (const [key, value] of Object.entries(updates)) {
    const pattern = new RegExp(`^(${key})\\s*=.*$`, 'm');
    if (pattern.test(content)) {
      // Replace existing key in place
      content = content.replace(pattern, `${key}=${value}`);
    } else {
      // Append key at end of file
      if (!content.endsWith('\n')) {
        content += '\n';
      }
      content += `${key}=${value}\n`;
    }
  }

  const encoder = new TextEncoder();
  await vscode.workspace.fs.writeFile(envUri, encoder.encode(content));
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Read current env values from the file using simple regex scanning.
 */
async function readEnvValues(envUri: vscode.Uri): Promise<Record<string, string>> {
  const values: Record<string, string> = {};

  try {
    const raw = await vscode.workspace.fs.readFile(envUri);
    const text = Buffer.from(raw).toString('utf-8');

    for (const line of text.split('\n')) {
      const match = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
      if (match) {
        const value = match[2]!.trim();
        if (value) {
          values[match[1]!] = value;
        }
      }
    }
  } catch {
    // File may not exist yet; return empty
  }

  return values;
}

/**
 * Mask a token for display, showing only the last 4 characters.
 * Example: "ghp_abc123def456" → "ghp_****f456"
 */
function maskToken(token: string): string {
  if (token.length <= 4) {
    return '****';
  }

  // Preserve known prefix patterns
  const prefixes = ['ghp_', 'gho_', 'ghs_', 'ghr_', 'github_pat_', 'sk-ant-'];
  for (const prefix of prefixes) {
    if (token.startsWith(prefix)) {
      return `${prefix}****${token.slice(-4)}`;
    }
  }

  return `****${token.slice(-4)}`;
}
