/**
 * Network connectivity detection and monitoring utilities
 */
import * as vscode from 'vscode';

/**
 * Network connectivity state
 */
export interface NetworkState {
  /** Whether device has network connectivity */
  isOnline: boolean;

  /** Last successful connection timestamp */
  lastOnlineAt?: number;

  /** Whether API is reachable */
  apiReachable: boolean;

  /** Last API health check timestamp */
  lastHealthCheck?: number;
}

/**
 * Network state change event
 */
export interface NetworkStateChange {
  /** Previous state */
  previous: NetworkState;

  /** Current state */
  current: NetworkState;

  /** Timestamp of change */
  timestamp: number;
}

/**
 * Network state change event emitter
 */
type NetworkStateChangeListener = (change: NetworkStateChange) => void;

/**
 * Network connectivity manager
 */
class NetworkManager {
  private currentState: NetworkState = {
    isOnline: typeof navigator !== 'undefined' ? navigator.onLine : true,
    apiReachable: false,
  };

  private listeners: NetworkStateChangeListener[] = [];
  private healthCheckInterval?: NodeJS.Timeout;
  private readonly healthCheckIntervalMs = 60000; // 1 minute
  private readonly apiHealthEndpoint = 'https://api.generacy.ai/health';
  private readonly healthCheckTimeout = 5000; // 5 seconds

  /**
   * Start monitoring network state
   */
  public start(): vscode.Disposable {
    // Initial health check
    void this.checkConnectivity();

    // Set up periodic health checks
    this.healthCheckInterval = setInterval(() => {
      void this.checkConnectivity();
    }, this.healthCheckIntervalMs);

    // Listen to browser online/offline events if available
    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.handleOnline);
      window.addEventListener('offline', this.handleOffline);
    }

    // Return disposable to stop monitoring
    return new vscode.Disposable(() => {
      if (this.healthCheckInterval) {
        clearInterval(this.healthCheckInterval);
      }
      if (typeof window !== 'undefined') {
        window.removeEventListener('online', this.handleOnline);
        window.removeEventListener('offline', this.handleOffline);
      }
    });
  }

  /**
   * Get current network state
   */
  public getState(): NetworkState {
    return { ...this.currentState };
  }

  /**
   * Check connectivity to the API
   */
  public async checkConnectivity(): Promise<boolean> {
    // First check navigator.onLine
    const browserOnline =
      typeof navigator !== 'undefined' ? navigator.onLine : true;

    if (!browserOnline) {
      this.updateState({
        isOnline: false,
        apiReachable: false,
        lastHealthCheck: Date.now(),
      });
      return false;
    }

    // Test actual API connectivity
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(
        () => controller.abort(),
        this.healthCheckTimeout
      );

      const response = await fetch(this.apiHealthEndpoint, {
        method: 'HEAD',
        cache: 'no-cache',
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const apiReachable = response.ok;
      this.updateState({
        isOnline: true,
        apiReachable,
        lastOnlineAt: apiReachable ? Date.now() : this.currentState.lastOnlineAt,
        lastHealthCheck: Date.now(),
      });

      return apiReachable;
    } catch (error) {
      this.updateState({
        isOnline: false,
        apiReachable: false,
        lastHealthCheck: Date.now(),
      });
      return false;
    }
  }

  /**
   * Add a listener for network state changes
   */
  public onStateChange(listener: NetworkStateChangeListener): vscode.Disposable {
    this.listeners.push(listener);
    return new vscode.Disposable(() => {
      const index = this.listeners.indexOf(listener);
      if (index !== -1) {
        this.listeners.splice(index, 1);
      }
    });
  }

  /**
   * Update network state and notify listeners
   */
  private updateState(newState: Partial<NetworkState>): void {
    const previous = { ...this.currentState };
    this.currentState = { ...this.currentState, ...newState };

    // Notify listeners if state changed
    if (
      previous.isOnline !== this.currentState.isOnline ||
      previous.apiReachable !== this.currentState.apiReachable
    ) {
      const change: NetworkStateChange = {
        previous,
        current: { ...this.currentState },
        timestamp: Date.now(),
      };

      for (const listener of this.listeners) {
        try {
          listener(change);
        } catch (error) {
          console.error('Error in network state change listener:', error);
        }
      }
    }
  }

  /**
   * Handle browser online event
   */
  private handleOnline = (): void => {
    void this.checkConnectivity();
  };

  /**
   * Handle browser offline event
   */
  private handleOffline = (): void => {
    this.updateState({
      isOnline: false,
      apiReachable: false,
    });
  };
}

// Singleton instance
let networkManager: NetworkManager | undefined;

/**
 * Get the network manager instance
 */
export function getNetworkManager(): NetworkManager {
  if (!networkManager) {
    networkManager = new NetworkManager();
  }
  return networkManager;
}

/**
 * Check if currently online
 */
export function isOnline(): boolean {
  return getNetworkManager().getState().isOnline;
}

/**
 * Check if API is reachable
 */
export function isApiReachable(): boolean {
  return getNetworkManager().getState().apiReachable;
}
