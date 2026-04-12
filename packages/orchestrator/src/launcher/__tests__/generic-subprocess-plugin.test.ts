import { describe, it, expect } from 'vitest';
import { GenericSubprocessPlugin } from '../generic-subprocess-plugin.js';
import type { GenericSubprocessIntent, ShellIntent } from '../types.js';

describe('GenericSubprocessPlugin', () => {
  const plugin = new GenericSubprocessPlugin();

  describe('identity', () => {
    it('has pluginId "generic-subprocess"', () => {
      expect(plugin.pluginId).toBe('generic-subprocess');
    });

    it('supports "generic-subprocess" and "shell" kinds', () => {
      expect(plugin.supportedKinds).toEqual(['generic-subprocess', 'shell']);
    });
  });

  describe('buildLaunch', () => {
    it('passes through generic-subprocess intent', () => {
      const intent: GenericSubprocessIntent = {
        kind: 'generic-subprocess',
        command: 'node',
        args: ['--version'],
        env: { NODE_ENV: 'test' },
      };

      expect(plugin.buildLaunch(intent)).toMatchInlineSnapshot(`
        {
          "args": [
            "--version",
          ],
          "command": "node",
          "env": {
            "NODE_ENV": "test",
          },
          "stdioProfile": "default",
        }
      `);
    });

    it('wraps shell intent in sh -c', () => {
      const intent: ShellIntent = {
        kind: 'shell',
        command: 'echo "hello world" | wc -w',
        env: { SHELL_VAR: 'val' },
      };

      expect(plugin.buildLaunch(intent)).toMatchInlineSnapshot(`
        {
          "args": [
            "-c",
            "echo "hello world" | wc -w",
          ],
          "command": "sh",
          "env": {
            "SHELL_VAR": "val",
          },
          "stdioProfile": "default",
        }
      `);
    });

    it('passes through stdioProfile from generic-subprocess intent', () => {
      const intent: GenericSubprocessIntent = {
        kind: 'generic-subprocess',
        command: 'node',
        args: ['server.js'],
        stdioProfile: 'interactive',
      };

      const spec = plugin.buildLaunch(intent);
      expect(spec.stdioProfile).toBe('interactive');
    });

    it('defaults stdioProfile to "default" when omitted', () => {
      const intent: GenericSubprocessIntent = {
        kind: 'generic-subprocess',
        command: 'node',
        args: ['--version'],
      };

      const spec = plugin.buildLaunch(intent);
      expect(spec.stdioProfile).toBe('default');
    });

    it('handles generic-subprocess intent without optional env', () => {
      const intent: GenericSubprocessIntent = {
        kind: 'generic-subprocess',
        command: 'ls',
        args: ['-la'],
      };

      const spec = plugin.buildLaunch(intent);
      expect(spec.command).toBe('ls');
      expect(spec.args).toEqual(['-la']);
      expect(spec.env).toBeUndefined();
      expect(spec.stdioProfile).toBe('default');
    });

    it('handles shell intent without optional env', () => {
      const intent: ShellIntent = {
        kind: 'shell',
        command: 'pwd',
      };

      const spec = plugin.buildLaunch(intent);
      expect(spec.command).toBe('sh');
      expect(spec.args).toEqual(['-c', 'pwd']);
      expect(spec.env).toBeUndefined();
      expect(spec.stdioProfile).toBe('default');
    });
  });

  describe('createOutputParser', () => {
    it('returns a functional no-op parser', () => {
      const parser = plugin.createOutputParser();

      // Should not throw
      parser.processChunk('stdout', 'some output');
      parser.processChunk('stderr', 'some error');
      parser.flush();

      // Verify the methods exist and are callable
      expect(typeof parser.processChunk).toBe('function');
      expect(typeof parser.flush).toBe('function');
    });
  });
});
