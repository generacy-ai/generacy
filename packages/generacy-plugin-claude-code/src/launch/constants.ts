import type { PhaseIntent } from './types.js';

/**
 * Map each CLI-backed phase to its Claude CLI slash command.
 * Copied from orchestrator worker/types.ts — Wave 3 deletes the orchestrator copy.
 */
export const PHASE_TO_COMMAND: Record<PhaseIntent['phase'], string> = {
  specify: '/specify',
  clarify: '/clarify',
  plan: '/plan',
  tasks: '/tasks',
  implement: '/implement',
};

/**
 * Python PTY wrapper using pty.spawn for proper session/terminal setup.
 *
 * Claude Code is a native binary that uses full stdout buffering when
 * writing to a pipe. pty.spawn creates a proper PTY with correct
 * session and controlling terminal setup, forcing line-buffered output.
 *
 * Copied from orchestrator conversation/conversation-spawner.ts — Wave 3 deletes the orchestrator copy.
 */
export const PTY_WRAPPER = [
  'import pty, os, sys',
  '# Prevent PTY line wrapping by setting huge terminal width',
  'os.environ["COLUMNS"] = "50000"',
  'def read(fd):',
  '    data = os.read(fd, 65536)',
  '    # Strip CRLF that PTY adds, return cleaned data',
  '    # (pty._copy writes our return value to stdout)',
  '    return data.replace(b"\\r\\n", b"\\n")',
  'pty.spawn(sys.argv[1:], read)',
].join('\n');
