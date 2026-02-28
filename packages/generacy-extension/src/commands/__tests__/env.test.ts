/**
 * Tests for the "Generacy: Configure Environment" command handler.
 *
 * Covers: workspace resolution, project detection, env file creation,
 * GitHub token prompting and validation, Anthropic key prompting and validation,
 * GENERACY_API_KEY flow, env file writing, and summary display.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const {
  mockShowQuickPick,
  mockShowInputBox,
  mockShowErrorMessage,
  mockShowWarningMessage,
  mockShowInformationMessage,
  mockStat,
  mockReadFile,
  mockWriteFile,
  mockCopy,
  mockCreateDirectory,
  mockWorkspaceFolders,
  mockCreateTerminal,
  mockExecFile,
} = vi.hoisted(() => ({
  mockShowQuickPick: vi.fn(),
  mockShowInputBox: vi.fn(),
  mockShowErrorMessage: vi.fn(() => Promise.resolve(undefined)),
  mockShowWarningMessage: vi.fn(() => Promise.resolve(undefined)),
  mockShowInformationMessage: vi.fn(() => Promise.resolve(undefined)),
  mockStat: vi.fn(),
  mockReadFile: vi.fn(),
  mockWriteFile: vi.fn(),
  mockCopy: vi.fn(),
  mockCreateDirectory: vi.fn(),
  mockWorkspaceFolders: [
    { name: 'my-project', uri: { fsPath: '/workspace/my-project', path: '/workspace/my-project', scheme: 'file' } },
  ] as unknown[],
  mockCreateTerminal: vi.fn(() => ({ show: vi.fn(), sendText: vi.fn() })),
  mockExecFile: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock vscode
// ---------------------------------------------------------------------------

vi.mock('vscode', () => ({
  window: {
    showQuickPick: mockShowQuickPick,
    showInputBox: mockShowInputBox,
    showErrorMessage: mockShowErrorMessage,
    showWarningMessage: mockShowWarningMessage,
    showInformationMessage: mockShowInformationMessage,
    createTerminal: mockCreateTerminal,
  },
  workspace: {
    get workspaceFolders() { return mockWorkspaceFolders; },
    fs: {
      stat: mockStat,
      readFile: mockReadFile,
      writeFile: mockWriteFile,
      copy: mockCopy,
      createDirectory: mockCreateDirectory,
    },
  },
  Uri: {
    file: (p: string) => ({ fsPath: p, scheme: 'file', path: p }),
    joinPath: (base: { path: string }, ...segments: string[]) => {
      const joined = [base.path, ...segments].join('/');
      return { fsPath: joined, scheme: 'file', path: joined };
    },
  },
  FileSystemError: class extends Error {
    code: string;
    constructor(message?: string) {
      super(message);
      this.code = 'Unknown';
    }
    static FileNotFound(_uri?: unknown): Error & { code: string } {
      const err = new Error('FileNotFound') as Error & { code: string };
      err.code = 'FileNotFound';
      return err;
    }
  },
}));

// ---------------------------------------------------------------------------
// Mock child_process
// ---------------------------------------------------------------------------

vi.mock('child_process', () => ({
  execFile: mockExecFile,
}));

// ---------------------------------------------------------------------------
// Mock util (promisify)
// ---------------------------------------------------------------------------

vi.mock('util', () => ({
  promisify: (fn: typeof mockExecFile) => {
    return (...args: unknown[]) => {
      return new Promise((resolve, reject) => {
        fn(...args, (error: Error | null, stdout: string, stderr: string) => {
          if (error) reject(error);
          else resolve({ stdout, stderr });
        });
      });
    };
  },
}));

// ---------------------------------------------------------------------------
// Mock utils (logger)
// ---------------------------------------------------------------------------

vi.mock('../../utils', () => ({
  getLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Mock global fetch
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { handleConfigureEnvironment } from '../env';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function encode(content: string): Uint8Array {
  return new TextEncoder().encode(content);
}

const ENV_FILE_CONTENT = `# test
GITHUB_TOKEN=
ANTHROPIC_API_KEY=
`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleConfigureEnvironment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset workspace folders to single folder
    mockWorkspaceFolders.length = 0;
    mockWorkspaceFolders.push({
      name: 'my-project',
      uri: { fsPath: '/workspace/my-project', path: '/workspace/my-project', scheme: 'file' },
    });
  });

  // ========================================================================
  // Workspace Resolution
  // ========================================================================

  describe('workspace resolution', () => {
    it('should use single workspace folder directly', async () => {
      // .generacy/ exists
      mockStat.mockResolvedValue({ type: 1 });
      // env file exists
      mockReadFile.mockResolvedValue(encode(ENV_FILE_CONTENT));
      // Skip GitHub token prompt
      mockShowQuickPick.mockResolvedValueOnce(undefined);

      await handleConfigureEnvironment();

      // Should NOT have shown a QuickPick for workspace selection
      // (first QuickPick call is for GitHub token method, not workspace)
      expect(mockShowQuickPick).toHaveBeenCalled();
    });

    it('should show QuickPick for multi-root workspace', async () => {
      mockWorkspaceFolders.push({
        name: 'second-project',
        uri: { fsPath: '/workspace/second-project', path: '/workspace/second-project', scheme: 'file' },
      });

      // User selects first folder
      mockShowQuickPick.mockResolvedValueOnce({
        label: 'my-project',
        description: '/workspace/my-project',
        folder: mockWorkspaceFolders[0],
      });
      mockStat.mockResolvedValue({ type: 1 });
      mockReadFile.mockResolvedValue(encode(ENV_FILE_CONTENT));
      // Skip GitHub token prompt
      mockShowQuickPick.mockResolvedValueOnce(undefined);

      await handleConfigureEnvironment();

      // First QuickPick should be workspace selection
      expect(mockShowQuickPick).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ label: 'my-project' }),
          expect.objectContaining({ label: 'second-project' }),
        ]),
        expect.any(Object),
      );
    });

    it('should show error when no workspace folders exist', async () => {
      mockWorkspaceFolders.length = 0;

      await handleConfigureEnvironment();

      expect(mockShowErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('No workspace folder'),
      );
    });

    it('should return when user cancels multi-root QuickPick', async () => {
      mockWorkspaceFolders.push({
        name: 'second-project',
        uri: { fsPath: '/workspace/second-project', path: '/workspace/second-project', scheme: 'file' },
      });

      mockShowQuickPick.mockResolvedValueOnce(undefined);

      await handleConfigureEnvironment();

      // Should not have tried to stat .generacy/
      expect(mockStat).not.toHaveBeenCalled();
    });
  });

  // ========================================================================
  // Project Detection
  // ========================================================================

  describe('project detection', () => {
    it('should proceed when .generacy/ directory exists', async () => {
      mockStat.mockResolvedValue({ type: 1 });
      mockReadFile.mockResolvedValue(encode(ENV_FILE_CONTENT));
      mockShowQuickPick.mockResolvedValueOnce(undefined); // skip token prompt

      await handleConfigureEnvironment();

      // Should have continued past project check (stat was called for .generacy/)
      expect(mockStat).toHaveBeenCalled();
    });

    it('should show error with "Run generacy init" button when .generacy/ is missing', async () => {
      mockStat.mockRejectedValue(new Error('Not found'));
      mockShowErrorMessage.mockResolvedValue(undefined);

      await handleConfigureEnvironment();

      expect(mockShowErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('No .generacy directory'),
        'Run generacy init',
      );
    });
  });

  // ========================================================================
  // Env File Creation
  // ========================================================================

  describe('env file creation', () => {
    it('should use existing env file without writing', async () => {
      // .generacy/ dir exists, env file exists
      mockStat.mockResolvedValue({ type: 1 });
      mockReadFile.mockResolvedValue(encode(ENV_FILE_CONTENT));
      mockShowQuickPick.mockResolvedValueOnce(undefined); // skip token prompt

      await handleConfigureEnvironment();

      // Should NOT have called copy or writeFile for initial file creation
      expect(mockCopy).not.toHaveBeenCalled();
    });

    it('should copy from workspace template when env file is missing but template exists', async () => {
      let statCallCount = 0;
      mockStat.mockImplementation(() => {
        statCallCount++;
        if (statCallCount === 1) {
          // .generacy/ dir exists
          return Promise.resolve({ type: 1 });
        }
        if (statCallCount === 2) {
          // env file doesn't exist
          return Promise.reject(new Error('Not found'));
        }
        // template exists
        return Promise.resolve({ type: 1 });
      });

      mockCopy.mockResolvedValue(undefined);
      mockReadFile.mockResolvedValue(encode(ENV_FILE_CONTENT));
      mockShowQuickPick.mockResolvedValueOnce(undefined); // skip token prompt

      await handleConfigureEnvironment();

      expect(mockCopy).toHaveBeenCalled();
    });

    it('should create from embedded default when both env file and template are missing', async () => {
      let statCallCount = 0;
      mockStat.mockImplementation(() => {
        statCallCount++;
        if (statCallCount === 1) {
          // .generacy/ dir exists
          return Promise.resolve({ type: 1 });
        }
        // env file and template don't exist
        return Promise.reject(new Error('Not found'));
      });

      mockCreateDirectory.mockResolvedValue(undefined);
      mockWriteFile.mockResolvedValue(undefined);
      mockReadFile.mockResolvedValue(encode(ENV_FILE_CONTENT));
      mockShowQuickPick.mockResolvedValueOnce(undefined); // skip token prompt

      await handleConfigureEnvironment();

      // Should have written the embedded default
      expect(mockWriteFile).toHaveBeenCalled();
    });
  });

  // ========================================================================
  // GitHub Token Flow
  // ========================================================================

  describe('GitHub token flow', () => {
    /** Set up so we reach the GitHub token prompt */
    function setupToTokenPrompt() {
      mockStat.mockResolvedValue({ type: 1 });
      mockReadFile.mockResolvedValue(encode(ENV_FILE_CONTENT));
    }

    it('should use token from gh auth token when user selects that option', async () => {
      setupToTokenPrompt();

      // User picks "gh auth token"
      mockShowQuickPick.mockResolvedValueOnce({
        label: '$(terminal) Use gh auth token',
      });

      // gh auth token succeeds
      mockExecFile.mockImplementation((...args: unknown[]) => {
        const cb = args[args.length - 1] as (err: null, stdout: string, stderr: string) => void;
        cb(null, 'ghp_test123\n', '');
      });

      // Validation succeeds
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: () => 'repo, workflow' },
      });

      // Dismiss validation success message
      mockShowInformationMessage.mockResolvedValueOnce(undefined);

      // Skip Anthropic key
      mockShowInputBox.mockResolvedValueOnce(undefined);
      // Skip Generacy key
      mockShowQuickPick.mockResolvedValueOnce({ label: 'Skip' });

      mockWriteFile.mockResolvedValue(undefined);

      await handleConfigureEnvironment();

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.github.com/user',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer ghp_test123',
          }),
        }),
      );
    });

    it('should fall back to manual entry when gh auth token fails', async () => {
      setupToTokenPrompt();

      // User picks "gh auth token"
      mockShowQuickPick.mockResolvedValueOnce({
        label: '$(terminal) Use gh auth token',
      });

      // gh auth token fails
      mockExecFile.mockImplementation((...args: unknown[]) => {
        const cb = args[args.length - 1] as (err: Error) => void;
        cb(new Error('gh not found'));
      });

      // Warning shown, then manual input box
      mockShowWarningMessage.mockResolvedValueOnce(undefined);
      mockShowInputBox.mockResolvedValueOnce('ghp_manual456');

      // Validation succeeds
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: () => 'repo, workflow' },
      });
      mockShowInformationMessage.mockResolvedValueOnce(undefined);

      // Skip Anthropic key
      mockShowInputBox.mockResolvedValueOnce(undefined);
      // Skip Generacy key
      mockShowQuickPick.mockResolvedValueOnce({ label: 'Skip' });

      mockWriteFile.mockResolvedValue(undefined);

      await handleConfigureEnvironment();

      expect(mockShowInputBox).toHaveBeenCalledWith(
        expect.objectContaining({ password: true }),
      );
    });

    it('should show re-enter/skip/cancel when token validation returns 401', async () => {
      setupToTokenPrompt();

      // User enters token manually
      mockShowQuickPick.mockResolvedValueOnce({
        label: '$(key) Enter token manually',
      });
      mockShowInputBox.mockResolvedValueOnce('ghp_bad');

      // Validation returns 401
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        headers: { get: () => null },
      });

      // Recovery: user chooses "Skip"
      mockShowQuickPick.mockResolvedValueOnce({ label: 'Skip' });

      // Skip Anthropic key
      mockShowInputBox.mockResolvedValueOnce(undefined);
      // Skip Generacy key
      mockShowQuickPick.mockResolvedValueOnce({ label: 'Skip' });

      await handleConfigureEnvironment();

      // Recovery QuickPick should have been shown
      expect(mockShowQuickPick).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ label: 'Re-enter' }),
          expect.objectContaining({ label: 'Skip' }),
          expect.objectContaining({ label: 'Cancel setup' }),
        ]),
        expect.any(Object),
      );
    });

    it('should save token without validation on network error', async () => {
      setupToTokenPrompt();

      mockShowQuickPick.mockResolvedValueOnce({
        label: '$(key) Enter token manually',
      });
      mockShowInputBox.mockResolvedValueOnce('ghp_offline');

      // Network error
      mockFetch.mockRejectedValueOnce(new Error('Network error'));
      mockShowWarningMessage.mockResolvedValueOnce(undefined);

      // Skip Anthropic key
      mockShowInputBox.mockResolvedValueOnce(undefined);
      // Skip Generacy key
      mockShowQuickPick.mockResolvedValueOnce({ label: 'Skip' });

      mockWriteFile.mockResolvedValue(undefined);

      await handleConfigureEnvironment();

      // Token should still be saved (write should include GITHUB_TOKEN)
      expect(mockWriteFile).toHaveBeenCalled();
    });

    it('should warn about missing scopes but accept the token', async () => {
      setupToTokenPrompt();

      mockShowQuickPick.mockResolvedValueOnce({
        label: '$(key) Enter token manually',
      });
      mockShowInputBox.mockResolvedValueOnce('ghp_noscopes');

      // Valid but missing scopes
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: (h: string) => h === 'x-oauth-scopes' ? 'read:user' : null },
      });
      mockShowWarningMessage.mockResolvedValueOnce(undefined);

      // Skip Anthropic key
      mockShowInputBox.mockResolvedValueOnce(undefined);
      // Skip Generacy key
      mockShowQuickPick.mockResolvedValueOnce({ label: 'Skip' });

      mockWriteFile.mockResolvedValue(undefined);

      await handleConfigureEnvironment();

      // Warning about missing scopes
      expect(mockShowWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('missing required scopes'),
      );
    });
  });

  // ========================================================================
  // Anthropic Key Flow
  // ========================================================================

  describe('Anthropic key flow', () => {
    function setupToAnthropicPrompt() {
      mockStat.mockResolvedValue({ type: 1 });
      mockReadFile.mockResolvedValue(encode(ENV_FILE_CONTENT));
      // Skip GitHub token
      mockShowQuickPick.mockResolvedValueOnce(undefined); // GitHub prompt cancelled → skip
    }

    it('should show InputBox with password:true for Anthropic key', async () => {
      setupToAnthropicPrompt();

      mockShowInputBox.mockResolvedValueOnce('sk-ant-test');

      // Validation succeeds
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
      });
      mockShowInformationMessage.mockResolvedValueOnce(undefined);

      // Skip Generacy key
      mockShowQuickPick.mockResolvedValueOnce({ label: 'Skip' });

      mockWriteFile.mockResolvedValue(undefined);

      await handleConfigureEnvironment();

      expect(mockShowInputBox).toHaveBeenCalledWith(
        expect.objectContaining({ password: true }),
      );
    });

    it('should show recovery options when Anthropic validation returns 401', async () => {
      setupToAnthropicPrompt();

      mockShowInputBox.mockResolvedValueOnce('sk-ant-bad');

      // Validation returns 401
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
      });

      // Recovery: cancel
      mockShowQuickPick.mockResolvedValueOnce({ label: 'Cancel setup' });

      await handleConfigureEnvironment();

      expect(mockShowQuickPick).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ label: 'Re-enter' }),
        ]),
        expect.any(Object),
      );
    });

    it('should save key without validation on network error', async () => {
      setupToAnthropicPrompt();

      mockShowInputBox.mockResolvedValueOnce('sk-ant-offline');

      // Network error
      mockFetch.mockRejectedValueOnce(new Error('Network error'));
      mockShowWarningMessage.mockResolvedValueOnce(undefined);

      // Skip Generacy key
      mockShowQuickPick.mockResolvedValueOnce({ label: 'Skip' });

      mockWriteFile.mockResolvedValue(undefined);

      await handleConfigureEnvironment();

      // Key should still be saved
      expect(mockWriteFile).toHaveBeenCalled();
      // Warning shown about skipped validation
      expect(mockShowWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('saved without validation'),
      );
    });
  });

  // ========================================================================
  // GENERACY_API_KEY Flow
  // ========================================================================

  describe('GENERACY_API_KEY flow', () => {
    function setupToGeneracyPrompt() {
      mockStat.mockResolvedValue({ type: 1 });
      mockReadFile.mockResolvedValue(encode(ENV_FILE_CONTENT));
      // Skip GitHub token
      mockShowQuickPick.mockResolvedValueOnce(undefined);
      // Skip Anthropic key
      mockShowInputBox.mockResolvedValueOnce(undefined);
    }

    it('should skip when user selects Skip', async () => {
      setupToGeneracyPrompt();

      mockShowQuickPick.mockResolvedValueOnce({ label: 'Skip' });

      await handleConfigureEnvironment();

      // No write since nothing was configured
      expect(mockWriteFile).not.toHaveBeenCalled();
    });

    it('should show InputBox when user opts in', async () => {
      setupToGeneracyPrompt();

      mockShowQuickPick.mockResolvedValueOnce({ label: 'Configure' });
      mockShowInputBox.mockResolvedValueOnce('gak_test123');

      mockWriteFile.mockResolvedValue(undefined);

      await handleConfigureEnvironment();

      // Should have written the key
      expect(mockWriteFile).toHaveBeenCalled();
    });
  });

  // ========================================================================
  // File Writing
  // ========================================================================

  describe('file writing', () => {
    it('should update existing keys in place preserving comments', async () => {
      const envContent = `# Header comment\nGITHUB_TOKEN=\n# Anthropic\nANTHROPIC_API_KEY=\n`;

      mockStat.mockResolvedValue({ type: 1 });
      mockReadFile.mockResolvedValue(encode(envContent));

      // Enter GitHub token manually
      mockShowQuickPick.mockResolvedValueOnce({
        label: '$(key) Enter token manually',
      });
      mockShowInputBox.mockResolvedValueOnce('ghp_new');

      // Validation succeeds
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: () => 'repo, workflow' },
      });
      mockShowInformationMessage.mockResolvedValueOnce(undefined);

      // Skip Anthropic
      mockShowInputBox.mockResolvedValueOnce(undefined);
      // Skip Generacy
      mockShowQuickPick.mockResolvedValueOnce({ label: 'Skip' });

      mockWriteFile.mockResolvedValue(undefined);

      await handleConfigureEnvironment();

      // Verify writeFile was called
      expect(mockWriteFile).toHaveBeenCalled();

      // Check the written content preserves comments
      const writtenContent = Buffer.from(
        mockWriteFile.mock.calls[0]![1] as Uint8Array,
      ).toString('utf-8');

      expect(writtenContent).toContain('# Header comment');
      expect(writtenContent).toContain('GITHUB_TOKEN=ghp_new');
      expect(writtenContent).toContain('# Anthropic');
    });

    it('should handle multiple key updates in a single write', async () => {
      const envContent = `# Config\nGITHUB_TOKEN=\nANTHROPIC_API_KEY=\n`;

      mockStat.mockResolvedValue({ type: 1 });
      mockReadFile.mockResolvedValue(encode(envContent));

      // Enter GitHub token manually
      mockShowQuickPick.mockResolvedValueOnce({
        label: '$(key) Enter token manually',
      });
      mockShowInputBox.mockResolvedValueOnce('ghp_multi');

      // GitHub validation succeeds
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: () => 'repo, workflow' },
      });
      mockShowInformationMessage.mockResolvedValueOnce(undefined);

      // Enter Anthropic key
      mockShowInputBox.mockResolvedValueOnce('sk-ant-multi');
      mockFetch.mockResolvedValueOnce({ ok: true, status: 200 });
      mockShowInformationMessage.mockResolvedValueOnce(undefined);

      // Skip Generacy key
      mockShowQuickPick.mockResolvedValueOnce({ label: 'Skip' });

      mockWriteFile.mockResolvedValue(undefined);

      await handleConfigureEnvironment();

      expect(mockWriteFile).toHaveBeenCalled();

      const writtenContent = Buffer.from(
        mockWriteFile.mock.calls[0]![1] as Uint8Array,
      ).toString('utf-8');

      // Both keys should be updated in a single write
      expect(writtenContent).toContain('GITHUB_TOKEN=ghp_multi');
      expect(writtenContent).toContain('ANTHROPIC_API_KEY=sk-ant-multi');
      // Comments preserved
      expect(writtenContent).toContain('# Config');
    });

    it('should append key if not found in file', async () => {
      const envContent = `GITHUB_TOKEN=existing\nANTHROPIC_API_KEY=existing\n`;

      mockStat.mockResolvedValue({ type: 1 });
      mockReadFile.mockResolvedValue(encode(envContent));

      // Keep GitHub token (skip prompt)
      mockShowQuickPick.mockResolvedValueOnce(undefined);
      // Skip Anthropic
      mockShowInputBox.mockResolvedValueOnce(undefined);
      // Configure Generacy key
      mockShowQuickPick.mockResolvedValueOnce({ label: 'Configure' });
      mockShowInputBox.mockResolvedValueOnce('gak_appended');

      mockWriteFile.mockResolvedValue(undefined);

      await handleConfigureEnvironment();

      expect(mockWriteFile).toHaveBeenCalled();

      const writtenContent = Buffer.from(
        mockWriteFile.mock.calls[0]![1] as Uint8Array,
      ).toString('utf-8');

      expect(writtenContent).toContain('GENERACY_API_KEY=gak_appended');
    });
  });

  // ========================================================================
  // Summary Display
  // ========================================================================

  describe('summary display', () => {
    it('should show success message with count of configured keys', async () => {
      mockStat.mockResolvedValue({ type: 1 });
      mockReadFile.mockResolvedValue(encode(ENV_FILE_CONTENT));

      // Enter GitHub token
      mockShowQuickPick.mockResolvedValueOnce({
        label: '$(key) Enter token manually',
      });
      mockShowInputBox.mockResolvedValueOnce('ghp_test');

      // Validation succeeds
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: () => 'repo, workflow' },
      });
      mockShowInformationMessage.mockResolvedValueOnce(undefined);

      // Enter Anthropic key
      mockShowInputBox.mockResolvedValueOnce('sk-ant-test');
      mockFetch.mockResolvedValueOnce({ ok: true, status: 200 });
      mockShowInformationMessage.mockResolvedValueOnce(undefined);

      // Skip Generacy key
      mockShowQuickPick.mockResolvedValueOnce({ label: 'Skip' });

      mockWriteFile.mockResolvedValue(undefined);

      await handleConfigureEnvironment();

      // Final summary message
      expect(mockShowInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining('Environment configured successfully'),
      );
    });

    it('should append validation skip notice when applicable', async () => {
      mockStat.mockResolvedValue({ type: 1 });
      mockReadFile.mockResolvedValue(encode(ENV_FILE_CONTENT));

      // Enter GitHub token
      mockShowQuickPick.mockResolvedValueOnce({
        label: '$(key) Enter token manually',
      });
      mockShowInputBox.mockResolvedValueOnce('ghp_test');

      // Network error on validation
      mockFetch.mockRejectedValueOnce(new Error('Network error'));
      mockShowWarningMessage.mockResolvedValueOnce(undefined);

      // Skip Anthropic
      mockShowInputBox.mockResolvedValueOnce(undefined);
      // Skip Generacy
      mockShowQuickPick.mockResolvedValueOnce({ label: 'Skip' });

      mockWriteFile.mockResolvedValue(undefined);

      await handleConfigureEnvironment();

      expect(mockShowInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining('Run again to validate skipped tokens'),
      );
    });
  });
});
