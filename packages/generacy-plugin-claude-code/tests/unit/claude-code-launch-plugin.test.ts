import { describe, it, expect } from 'vitest';
import { ClaudeCodeLaunchPlugin } from '../../src/launch/claude-code-launch-plugin.js';
import type { PhaseIntent, PrFeedbackIntent, ConversationTurnIntent } from '../../src/launch/types.js';

describe('ClaudeCodeLaunchPlugin', () => {
  const plugin = new ClaudeCodeLaunchPlugin();

  // ---- T010: Unit tests ----

  describe('identity', () => {
    it('has pluginId "claude-code"', () => {
      expect(plugin.pluginId).toBe('claude-code');
    });

    it('supports phase, pr-feedback, and conversation-turn kinds', () => {
      expect(plugin.supportedKinds).toEqual(['phase', 'pr-feedback', 'conversation-turn']);
    });
  });

  describe('createOutputParser', () => {
    it('returns a valid OutputParser for phase intent', () => {
      const intent: PhaseIntent = { kind: 'phase', phase: 'specify', prompt: 'test' };
      const parser = plugin.createOutputParser(intent);
      expect(typeof parser.processChunk).toBe('function');
      expect(typeof parser.flush).toBe('function');
      parser.processChunk('stdout', 'data');
      parser.processChunk('stderr', 'err');
      parser.flush();
    });

    it('returns a valid OutputParser for pr-feedback intent', () => {
      const intent: PrFeedbackIntent = { kind: 'pr-feedback', prNumber: 42, prompt: 'fix it' };
      const parser = plugin.createOutputParser(intent);
      expect(typeof parser.processChunk).toBe('function');
      expect(typeof parser.flush).toBe('function');
    });

    it('returns a valid OutputParser for conversation-turn intent', () => {
      const intent: ConversationTurnIntent = {
        kind: 'conversation-turn',
        message: 'hello',
        skipPermissions: true,
      };
      const parser = plugin.createOutputParser(intent);
      expect(typeof parser.processChunk).toBe('function');
      expect(typeof parser.flush).toBe('function');
    });
  });

  describe('unsupported intent', () => {
    it('throws on unsupported intent kind', () => {
      const intent = { kind: 'unknown' } as any;
      expect(() => plugin.buildLaunch(intent)).toThrow('Unsupported intent kind: unknown');
    });
  });

  // ---- T009: Snapshot tests ----

  describe('buildLaunch snapshots', () => {
    describe('phase intent', () => {
      const phases = ['specify', 'clarify', 'plan', 'tasks', 'implement'] as const;

      for (const phase of phases) {
        it(`snapshot for phase "${phase}"`, () => {
          const intent: PhaseIntent = {
            kind: 'phase',
            phase,
            prompt: 'https://github.com/org/repo/issues/123',
          };
          expect(plugin.buildLaunch(intent)).toMatchSnapshot();
        });
      }

      it('snapshot for phase with sessionId (resume path)', () => {
        const intent: PhaseIntent = {
          kind: 'phase',
          phase: 'implement',
          prompt: 'https://github.com/org/repo/issues/123',
          sessionId: 'abc-123-session',
        };
        expect(plugin.buildLaunch(intent)).toMatchSnapshot();
      });
    });

    describe('pr-feedback intent', () => {
      it('snapshot for pr-feedback', () => {
        const intent: PrFeedbackIntent = {
          kind: 'pr-feedback',
          prNumber: 42,
          prompt: 'Please address the review feedback on PR #42.',
        };
        expect(plugin.buildLaunch(intent)).toMatchSnapshot();
      });
    });

    describe('conversation-turn intent', () => {
      it('snapshot: basic turn (skipPermissions=false, no session, no model)', () => {
        const intent: ConversationTurnIntent = {
          kind: 'conversation-turn',
          message: 'Hello Claude',
          skipPermissions: false,
        };
        expect(plugin.buildLaunch(intent)).toMatchSnapshot();
      });

      it('snapshot: skipPermissions=true', () => {
        const intent: ConversationTurnIntent = {
          kind: 'conversation-turn',
          message: 'Hello Claude',
          skipPermissions: true,
        };
        expect(plugin.buildLaunch(intent)).toMatchSnapshot();
      });

      it('snapshot: with sessionId (resume)', () => {
        const intent: ConversationTurnIntent = {
          kind: 'conversation-turn',
          message: 'Hello Claude',
          sessionId: 'session-xyz',
          skipPermissions: false,
        };
        expect(plugin.buildLaunch(intent)).toMatchSnapshot();
      });

      it('snapshot: with model override', () => {
        const intent: ConversationTurnIntent = {
          kind: 'conversation-turn',
          message: 'Hello Claude',
          model: 'claude-opus-4-6',
          skipPermissions: false,
        };
        expect(plugin.buildLaunch(intent)).toMatchSnapshot();
      });

      it('snapshot: all flags (sessionId + skipPermissions + model)', () => {
        const intent: ConversationTurnIntent = {
          kind: 'conversation-turn',
          message: 'Hello Claude',
          sessionId: 'session-xyz',
          model: 'claude-opus-4-6',
          skipPermissions: true,
        };
        expect(plugin.buildLaunch(intent)).toMatchSnapshot();
      });
    });
  });
});
