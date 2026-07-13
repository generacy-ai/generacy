import { describe, it, expect } from 'vitest';
import { ClaudeCodeLaunchPlugin } from '../../src/launch/claude-code-launch-plugin.js';
import type { PhaseIntent, PrFeedbackIntent, ConversationTurnIntent, InvokeIntent } from '../../src/launch/types.js';

describe('ClaudeCodeLaunchPlugin', () => {
  const plugin = new ClaudeCodeLaunchPlugin();

  // ---- T010: Unit tests ----

  describe('identity', () => {
    it('has pluginId "claude-code"', () => {
      expect(plugin.pluginId).toBe('claude-code');
    });

    it('supports phase, pr-feedback, validate-fix, merge-conflict, conversation-turn, and invoke kinds', () => {
      expect(plugin.supportedKinds).toEqual(['phase', 'pr-feedback', 'validate-fix', 'merge-conflict', 'conversation-turn', 'invoke']);
    });
  });

  describe('invoke intent', () => {
    it('produces correct argv for invoke intent', () => {
      const intent: InvokeIntent = { kind: 'invoke', command: '/speckit:specify https://github.com/org/repo/issues/1' };
      const spec = plugin.buildLaunch(intent);
      expect(spec.command).toBe('claude');
      expect(spec.args).toEqual(['--print', '--dangerously-skip-permissions', '/speckit:specify https://github.com/org/repo/issues/1']);
    });

    it('uses default stdioProfile for invoke intent', () => {
      const intent: InvokeIntent = { kind: 'invoke', command: 'test command' };
      const spec = plugin.buildLaunch(intent);
      expect(spec.stdioProfile).toBe('default');
    });

    it('returns no-op output parser for invoke intent', () => {
      const intent: InvokeIntent = { kind: 'invoke', command: 'test' };
      const parser = plugin.createOutputParser(intent);
      expect(typeof parser.processChunk).toBe('function');
      expect(typeof parser.flush).toBe('function');
      // Should not throw
      parser.processChunk('stdout', 'data');
      parser.processChunk('stderr', 'err');
      parser.flush();
    });

    it('does not include env in launch spec', () => {
      const intent: InvokeIntent = { kind: 'invoke', command: 'test' };
      const spec = plugin.buildLaunch(intent);
      expect(spec.env).toBeUndefined();
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

      // T021 / #814: `--model` argv position — immediately after `--verbose`,
      // before `--resume <sessionId>` and the prompt payload.
      it('snapshot for phase with model set', () => {
        const intent: PhaseIntent = {
          kind: 'phase',
          phase: 'implement',
          prompt: 'https://github.com/org/repo/issues/123',
          model: 'sonnet-4-6',
        };
        const spec = plugin.buildLaunch(intent);
        expect(spec).toMatchSnapshot();
        // Explicit position assertion. Order: -p, --output-format, stream-json,
        // --dangerously-skip-permissions, --verbose, --model, <model>, /implement <prompt>
        const modelIdx = spec.args.indexOf('--model');
        expect(modelIdx).toBe(spec.args.indexOf('--verbose') + 1);
        expect(spec.args[modelIdx + 1]).toBe('sonnet-4-6');
      });

      it('snapshot for phase with model AND sessionId — --model precedes --resume', () => {
        const intent: PhaseIntent = {
          kind: 'phase',
          phase: 'plan',
          prompt: 'https://github.com/org/repo/issues/123',
          model: 'opus-4-7',
          sessionId: 'abc-123-session',
        };
        const spec = plugin.buildLaunch(intent);
        expect(spec).toMatchSnapshot();
        expect(spec.args.indexOf('--model')).toBeLessThan(spec.args.indexOf('--resume'));
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

      // T021 + T022 / #814: `--model` argv position for pr-feedback — after
      // `--verbose`, before the prompt payload. Fixture uses opus-4-7 to
      // stand in for the plan.md Acceptance Gate #6 pr-feedback picks up
      // `phases.implement.model` scenario.
      it('snapshot for pr-feedback with model set (Q1→B: pr-feedback binds to implement)', () => {
        const intent: PrFeedbackIntent = {
          kind: 'pr-feedback',
          prNumber: 42,
          prompt: 'Please address the review feedback on PR #42.',
          model: 'opus-4-7',
        };
        const spec = plugin.buildLaunch(intent);
        expect(spec).toMatchSnapshot();
        // Position assertion: --model is right after --verbose, and the last
        // arg is the prompt.
        const modelIdx = spec.args.indexOf('--model');
        expect(modelIdx).toBe(spec.args.indexOf('--verbose') + 1);
        expect(spec.args[modelIdx + 1]).toBe('opus-4-7');
        expect(spec.args[spec.args.length - 1]).toBe(intent.prompt);
      });
    });

    describe('invoke intent', () => {
      it('snapshot for invoke', () => {
        const intent: InvokeIntent = {
          kind: 'invoke',
          command: '/speckit:specify https://github.com/org/repo/issues/42',
        };
        expect(plugin.buildLaunch(intent)).toMatchSnapshot();
      });

      it('snapshot for invoke with streaming', () => {
        const intent: InvokeIntent = {
          kind: 'invoke',
          command: '/speckit:plan https://github.com/org/repo/issues/42',
          streaming: true,
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
