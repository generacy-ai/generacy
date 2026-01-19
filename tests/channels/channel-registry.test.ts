import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ChannelRegistry } from '../../src/channels/channel-registry.js';
import {
  InvalidChannelNameError,
  ChannelExistsError,
  ChannelNotFoundError,
} from '../../src/types/channels.js';
import type { ChannelHandler } from '../../src/types/channels.js';

describe('ChannelRegistry', () => {
  let registry: ChannelRegistry;
  const mockHandler: ChannelHandler = vi.fn();

  beforeEach(() => {
    registry = new ChannelRegistry();
    vi.clearAllMocks();
  });

  describe('register', () => {
    it('registers a channel', () => {
      registry.register('notifications', mockHandler, 'plugin-1');

      expect(registry.has('notifications')).toBe(true);
      expect(registry.size).toBe(1);
    });

    it('stores channel metadata', () => {
      const before = Date.now();
      registry.register('notifications', mockHandler, 'plugin-1');
      const after = Date.now();

      const channel = registry.get('notifications');
      expect(channel).toBeDefined();
      expect(channel?.name).toBe('notifications');
      expect(channel?.handler).toBe(mockHandler);
      expect(channel?.registeredBy).toBe('plugin-1');
      expect(channel?.registeredAt).toBeGreaterThanOrEqual(before);
      expect(channel?.registeredAt).toBeLessThanOrEqual(after);
    });

    it('emits channel:registered event', () => {
      const registeredHandler = vi.fn();
      registry.on('channel:registered', registeredHandler);

      registry.register('notifications', mockHandler, 'plugin-1');

      expect(registeredHandler).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'notifications' })
      );
    });

    it('throws on invalid channel name - empty', () => {
      expect(() => registry.register('', mockHandler, 'plugin-1')).toThrow(
        InvalidChannelNameError
      );
    });

    it('throws on invalid channel name - too long', () => {
      const longName = 'a'.repeat(65);
      expect(() => registry.register(longName, mockHandler, 'plugin-1')).toThrow(
        InvalidChannelNameError
      );
    });

    it('throws on invalid channel name - special characters', () => {
      expect(() => registry.register('my-channel', mockHandler, 'plugin-1')).toThrow(
        InvalidChannelNameError
      );
      expect(() => registry.register('my.channel', mockHandler, 'plugin-1')).toThrow(
        InvalidChannelNameError
      );
    });

    it('throws on reserved channel names', () => {
      expect(() => registry.register('system', mockHandler, 'plugin-1')).toThrow(
        InvalidChannelNameError
      );
      expect(() => registry.register('internal', mockHandler, 'plugin-1')).toThrow(
        InvalidChannelNameError
      );
      expect(() => registry.register('router', mockHandler, 'plugin-1')).toThrow(
        InvalidChannelNameError
      );
    });

    it('throws on duplicate channel name', () => {
      registry.register('notifications', mockHandler, 'plugin-1');

      expect(() => registry.register('notifications', mockHandler, 'plugin-2')).toThrow(
        ChannelExistsError
      );
    });

    it('accepts valid channel names', () => {
      expect(() => registry.register('a', mockHandler, 'p')).not.toThrow();
      expect(() => registry.register('my_channel', mockHandler, 'p')).not.toThrow();
      expect(() => registry.register('Channel123', mockHandler, 'p')).not.toThrow();
      expect(() => registry.register('a'.repeat(64), mockHandler, 'p')).not.toThrow();
    });
  });

  describe('unregister', () => {
    it('unregisters a channel', () => {
      registry.register('notifications', mockHandler, 'plugin-1');
      registry.unregister('notifications');

      expect(registry.has('notifications')).toBe(false);
      expect(registry.size).toBe(0);
    });

    it('emits channel:unregistered event', () => {
      registry.register('notifications', mockHandler, 'plugin-1');

      const unregisteredHandler = vi.fn();
      registry.on('channel:unregistered', unregisteredHandler);

      registry.unregister('notifications');

      expect(unregisteredHandler).toHaveBeenCalledWith('notifications');
    });

    it('throws on non-existent channel', () => {
      expect(() => registry.unregister('non_existent')).toThrow(ChannelNotFoundError);
    });
  });

  describe('get', () => {
    it('returns channel if exists', () => {
      registry.register('notifications', mockHandler, 'plugin-1');

      const channel = registry.get('notifications');
      expect(channel).toBeDefined();
      expect(channel?.name).toBe('notifications');
    });

    it('returns undefined if not exists', () => {
      const channel = registry.get('non_existent');
      expect(channel).toBeUndefined();
    });
  });

  describe('findChannel', () => {
    it('is an alias for get', () => {
      registry.register('notifications', mockHandler, 'plugin-1');

      const found = registry.findChannel('notifications');
      expect(found).toBeDefined();
      expect(found?.name).toBe('notifications');
    });
  });

  describe('has', () => {
    it('returns true if channel exists', () => {
      registry.register('notifications', mockHandler, 'plugin-1');
      expect(registry.has('notifications')).toBe(true);
    });

    it('returns false if channel does not exist', () => {
      expect(registry.has('non_existent')).toBe(false);
    });
  });

  describe('getAll', () => {
    it('returns all registered channels', () => {
      registry.register('channel1', mockHandler, 'plugin-1');
      registry.register('channel2', mockHandler, 'plugin-2');

      const all = registry.getAll();
      expect(all).toHaveLength(2);
      expect(all.map(c => c.name)).toContain('channel1');
      expect(all.map(c => c.name)).toContain('channel2');
    });

    it('returns empty array when no channels', () => {
      const all = registry.getAll();
      expect(all).toHaveLength(0);
    });
  });

  describe('getByRegistrant', () => {
    it('returns channels by registrant', () => {
      registry.register('channel1', mockHandler, 'plugin-1');
      registry.register('channel2', mockHandler, 'plugin-1');
      registry.register('channel3', mockHandler, 'plugin-2');

      const plugin1Channels = registry.getByRegistrant('plugin-1');
      expect(plugin1Channels).toHaveLength(2);

      const plugin2Channels = registry.getByRegistrant('plugin-2');
      expect(plugin2Channels).toHaveLength(1);
    });

    it('returns empty array for unknown registrant', () => {
      const channels = registry.getByRegistrant('unknown');
      expect(channels).toHaveLength(0);
    });
  });

  describe('getNames', () => {
    it('returns all channel names', () => {
      registry.register('channel1', mockHandler, 'plugin-1');
      registry.register('channel2', mockHandler, 'plugin-2');

      const names = registry.getNames();
      expect(names).toContain('channel1');
      expect(names).toContain('channel2');
    });
  });

  describe('size', () => {
    it('returns the number of channels', () => {
      expect(registry.size).toBe(0);

      registry.register('channel1', mockHandler, 'plugin-1');
      expect(registry.size).toBe(1);

      registry.register('channel2', mockHandler, 'plugin-2');
      expect(registry.size).toBe(2);

      registry.unregister('channel1');
      expect(registry.size).toBe(1);
    });
  });

  describe('clear', () => {
    it('removes all channels', () => {
      registry.register('channel1', mockHandler, 'plugin-1');
      registry.register('channel2', mockHandler, 'plugin-2');

      registry.clear();

      expect(registry.size).toBe(0);
      expect(registry.has('channel1')).toBe(false);
      expect(registry.has('channel2')).toBe(false);
    });

    it('emits channel:unregistered for each channel', () => {
      registry.register('channel1', mockHandler, 'plugin-1');
      registry.register('channel2', mockHandler, 'plugin-2');

      const unregisteredHandler = vi.fn();
      registry.on('channel:unregistered', unregisteredHandler);

      registry.clear();

      expect(unregisteredHandler).toHaveBeenCalledTimes(2);
    });
  });

  describe('event listeners', () => {
    it('removes listeners with off()', () => {
      const registeredHandler = vi.fn();
      registry.on('channel:registered', registeredHandler);
      registry.off('channel:registered', registeredHandler);

      registry.register('notifications', mockHandler, 'plugin-1');

      expect(registeredHandler).not.toHaveBeenCalled();
    });
  });
});
