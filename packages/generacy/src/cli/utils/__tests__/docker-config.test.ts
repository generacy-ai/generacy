import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  materializeScopedDockerConfig,
  cleanupScopedDockerConfig,
  extractImageHost,
  getScopedDockerConfigPath,
} from '../docker-config.js';

describe('docker-config utilities', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-config-test-'));
    // Create .generacy dir structure
    fs.mkdirSync(path.join(tmpDir, '.generacy'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('materializeScopedDockerConfig', () => {
    it('writes correct JSON with base64 auth', () => {
      materializeScopedDockerConfig({
        projectDir: tmpDir,
        host: 'ghcr.io',
        username: '_token',
        password: 'ghp_abc123',
      });

      const configPath = path.join(tmpDir, '.generacy', '.docker', 'config.json');
      expect(fs.existsSync(configPath)).toBe(true);

      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      expect(config.auths['ghcr.io']).toBeDefined();

      const decoded = Buffer.from(config.auths['ghcr.io'].auth, 'base64').toString();
      expect(decoded).toBe('_token:ghp_abc123');
    });

    it('creates directory structure if missing', () => {
      const freshDir = path.join(tmpDir, 'fresh-project');
      fs.mkdirSync(freshDir);

      materializeScopedDockerConfig({
        projectDir: freshDir,
        host: 'registry.example.com',
        username: 'user',
        password: 'pass',
      });

      const configPath = path.join(freshDir, '.generacy', '.docker', 'config.json');
      expect(fs.existsSync(configPath)).toBe(true);
    });
  });

  describe('cleanupScopedDockerConfig', () => {
    it('removes the .docker directory', () => {
      materializeScopedDockerConfig({
        projectDir: tmpDir,
        host: 'ghcr.io',
        username: 'u',
        password: 'p',
      });

      const configDir = getScopedDockerConfigPath(tmpDir);
      expect(fs.existsSync(configDir)).toBe(true);

      cleanupScopedDockerConfig(tmpDir);
      expect(fs.existsSync(configDir)).toBe(false);
    });

    it('does not throw if directory does not exist', () => {
      expect(() => cleanupScopedDockerConfig(tmpDir)).not.toThrow();
    });
  });

  describe('extractImageHost', () => {
    it('extracts host from ghcr.io image', () => {
      expect(extractImageHost('ghcr.io/org/image:tag')).toBe('ghcr.io');
    });

    it('extracts host from custom registry', () => {
      expect(extractImageHost('registry.example.com/image:latest')).toBe('registry.example.com');
    });

    it('extracts host from ECR image', () => {
      expect(extractImageHost('123456789.dkr.ecr.us-east-1.amazonaws.com/repo:v1')).toBe(
        '123456789.dkr.ecr.us-east-1.amazonaws.com',
      );
    });

    it('extracts host with port', () => {
      expect(extractImageHost('localhost:5000/myimage:latest')).toBe('localhost:5000');
    });

    it('returns undefined for Docker Hub library images', () => {
      expect(extractImageHost('ubuntu:22.04')).toBeUndefined();
      expect(extractImageHost('node:20')).toBeUndefined();
      expect(extractImageHost('alpine')).toBeUndefined();
    });

    it('returns undefined for Docker Hub user images', () => {
      expect(extractImageHost('myuser/myimage:latest')).toBeUndefined();
    });

    it('handles image with digest', () => {
      expect(extractImageHost('ghcr.io/org/image@sha256:abc123')).toBe('ghcr.io');
    });
  });
});
