/**
 * Capability checker for graceful degradation.
 *
 * Detects whether orchestrator API endpoints are available and sets VS Code
 * context keys (`generacy.capability.<feature>`) so that UI elements can be
 * conditionally shown/hidden via `when` clauses.
 *
 * Detection works two ways:
 * 1. **Proactive probing** — `isAvailable(endpoint)` sends a lightweight GET
 *    with `limit=0` and caches the result for 5 minutes.
 * 2. **Lazy detection** — `onFirstCallResult(endpoint, statusCode)` updates
 *    the cache from actual API responses, avoiding extra probes.
 */
import * as vscode from 'vscode';
import { ApiClient } from '../api/client';
import { getLogger } from './logger';

// ============================================================================
// Constants
// ============================================================================

/** Cache time-to-live in milliseconds (5 minutes) */
const CACHE_TTL_MS = 5 * 60 * 1000;

/** Timeout for probe requests in milliseconds */
const PROBE_TIMEOUT_MS = 5000;

/** Prefix for VS Code context keys */
const CONTEXT_KEY_PREFIX = 'generacy.capability.';

// ============================================================================
// Types
// ============================================================================

interface CacheEntry {
  available: boolean;
  discoveredAt: number;
}

// ============================================================================
// Capability Checker
// ============================================================================

/**
 * Singleton that tracks which orchestrator endpoints are available and
 * exposes the results as VS Code context keys for `when`-clause bindings.
 */
export class CapabilityChecker implements vscode.Disposable {
  private static instance: CapabilityChecker | undefined;

  private readonly capabilities = new Map<string, CacheEntry>();
  private readonly pendingProbes = new Map<string, Promise<boolean>>();
  private disposed = false;

  private constructor() {}

  /**
   * Get or create the singleton instance.
   */
  public static getInstance(): CapabilityChecker {
    if (!CapabilityChecker.instance) {
      CapabilityChecker.instance = new CapabilityChecker();
    }
    return CapabilityChecker.instance;
  }

  /**
   * Reset the singleton (for testing).
   */
  public static resetInstance(): void {
    CapabilityChecker.instance?.dispose();
    CapabilityChecker.instance = undefined;
  }

  public dispose(): void {
    this.disposed = true;
    this.capabilities.clear();
    this.pendingProbes.clear();
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  /**
   * Check whether an endpoint is available.
   *
   * Returns a cached result when fresh (< TTL), otherwise issues a lightweight
   * probe request and caches the outcome.
   *
   * @param endpoint  API path such as `/agents` or `/activity`
   * @returns `true` if the endpoint responded with 2xx, `false` otherwise
   */
  public async isAvailable(endpoint: string): Promise<boolean> {
    const key = this.normalizeKey(endpoint);

    // Return cached result if still fresh
    const cached = this.capabilities.get(key);
    if (cached && !this.isExpired(cached)) {
      return cached.available;
    }

    // Deduplicate concurrent probes for the same endpoint
    const existing = this.pendingProbes.get(key);
    if (existing) {
      return existing;
    }

    const probe = this.probeEndpoint(endpoint, key);
    this.pendingProbes.set(key, probe);

    try {
      return await probe;
    } finally {
      this.pendingProbes.delete(key);
    }
  }

  /**
   * Update capability cache from the result of an actual API call.
   *
   * Call this from API endpoint modules after receiving a response so that the
   * capability map stays in sync without dedicated probes.
   *
   * @param endpoint    API path such as `/agents`
   * @param statusCode  HTTP status code from the response
   */
  public onFirstCallResult(endpoint: string, statusCode: number): void {
    if (this.disposed) {
      return;
    }

    const key = this.normalizeKey(endpoint);
    const available = statusCode >= 200 && statusCode < 500 && statusCode !== 404;

    this.setCapability(key, available);
  }

  /**
   * Get the cached availability for an endpoint without triggering a probe.
   * Returns `undefined` if the endpoint has not been checked yet.
   */
  public getCached(endpoint: string): boolean | undefined {
    const key = this.normalizeKey(endpoint);
    const cached = this.capabilities.get(key);

    if (!cached) {
      return undefined;
    }

    if (this.isExpired(cached)) {
      return undefined;
    }

    return cached.available;
  }

  /**
   * Clear all cached capabilities and their context keys.
   */
  public clearCache(): void {
    for (const key of this.capabilities.keys()) {
      void vscode.commands.executeCommand('setContext', `${CONTEXT_KEY_PREFIX}${key}`, undefined);
    }
    this.capabilities.clear();
  }

  // ==========================================================================
  // Private
  // ==========================================================================

  /**
   * Probe an endpoint with a lightweight GET request (limit=0, no retries).
   */
  private async probeEndpoint(endpoint: string, key: string): Promise<boolean> {
    if (this.disposed) {
      return false;
    }

    const logger = getLogger();
    const client = ApiClient.getInstance();

    try {
      const response = await client.get<unknown>(endpoint, {
        params: { limit: 0 },
        timeout: PROBE_TIMEOUT_MS,
        retries: 0,
      });

      const available = response.status >= 200 && response.status < 300;
      this.setCapability(key, available);
      return available;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.debug(`Capability probe failed for ${endpoint}`, { error: msg });
      this.setCapability(key, false);
      return false;
    }
  }

  /**
   * Store a capability result and update the VS Code context key.
   */
  private setCapability(key: string, available: boolean): void {
    this.capabilities.set(key, {
      available,
      discoveredAt: Date.now(),
    });

    void vscode.commands.executeCommand(
      'setContext',
      `${CONTEXT_KEY_PREFIX}${key}`,
      available,
    );
  }

  private isExpired(entry: CacheEntry): boolean {
    return Date.now() - entry.discoveredAt > CACHE_TTL_MS;
  }

  /**
   * Normalize an endpoint path into a short context-key-friendly name.
   * `/agents` → `agents`, `/agents/stats` → `agentStats`, etc.
   */
  private normalizeKey(endpoint: string): string {
    // Strip leading slashes and split into segments
    const segments = endpoint.replace(/^\/+/, '').split('/').filter(Boolean);

    if (segments.length === 0) {
      return 'root';
    }

    if (segments.length === 1) {
      return segments[0]!;
    }

    // Convert multi-segment paths to camelCase
    // e.g. ['agents', 'stats'] → 'agentStats'
    // Skip path-parameter-style segments like ':id'
    const meaningful = segments.filter((s) => !s.startsWith(':'));

    if (meaningful.length <= 1) {
      return meaningful[0] ?? segments[0]!;
    }

    // Singularize first segment if it ends in 's' and combine
    const first = meaningful[0]!.replace(/s$/, '');
    const rest = meaningful
      .slice(1)
      .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
      .join('');

    return first + rest;
  }
}

// ============================================================================
// Singleton Export
// ============================================================================

/**
 * Get the singleton CapabilityChecker instance.
 */
export function getCapabilityChecker(): CapabilityChecker {
  return CapabilityChecker.getInstance();
}
