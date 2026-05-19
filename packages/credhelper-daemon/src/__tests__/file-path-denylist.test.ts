import { describe, it, expect } from 'vitest';
import { isPathDenied } from '../file-path-denylist.js';

describe('isPathDenied', () => {
  it('denies root itself', () => {
    expect(isPathDenied('/')).toBe(true);
  });

  it('denies system-critical prefixes', () => {
    expect(isPathDenied('/etc/passwd')).toBe(true);
    expect(isPathDenied('/usr/bin/node')).toBe(true);
    expect(isPathDenied('/bin/sh')).toBe(true);
    expect(isPathDenied('/sbin/init')).toBe(true);
    expect(isPathDenied('/lib/x86_64-linux-gnu/libc.so')).toBe(true);
    expect(isPathDenied('/lib64/ld-linux.so')).toBe(true);
    expect(isPathDenied('/proc/1/status')).toBe(true);
    expect(isPathDenied('/sys/class/net')).toBe(true);
    expect(isPathDenied('/dev/null')).toBe(true);
    expect(isPathDenied('/boot/vmlinuz')).toBe(true);
  });

  it('denies generacy-internal paths', () => {
    expect(isPathDenied('/run/generacy-credhelper/control.sock')).toBe(true);
    expect(isPathDenied('/var/lib/generacy-credhelper/data')).toBe(true);
    expect(isPathDenied('/run/generacy-control-plane/control.sock')).toBe(true);
  });

  it('denies the prefix directory itself (without trailing slash)', () => {
    expect(isPathDenied('/etc')).toBe(true);
    expect(isPathDenied('/usr')).toBe(true);
    expect(isPathDenied('/bin')).toBe(true);
  });

  it('allows legitimate application paths', () => {
    expect(isPathDenied('/home/node/.config/gcloud/secrets/sa.json')).toBe(false);
    expect(isPathDenied('/var/lib/generacy-app-config/files/sa.json')).toBe(false);
    expect(isPathDenied('/tmp/my-file.txt')).toBe(false);
    expect(isPathDenied('/workspaces/myproject/.env')).toBe(false);
    expect(isPathDenied('/home/node/app/config.json')).toBe(false);
  });

  it('handles .. traversal by resolving the path', () => {
    expect(isPathDenied('/home/node/../../etc/passwd')).toBe(true);
    expect(isPathDenied('/tmp/../etc/shadow')).toBe(true);
  });

  it('handles trailing slashes', () => {
    expect(isPathDenied('/etc/')).toBe(true);
    expect(isPathDenied('/home/node/')).toBe(false);
  });
});
