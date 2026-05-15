/** Status of a store after initialization */
export type StoreStatus = 'ok' | 'fallback' | 'disabled';

export interface StoreInitResult {
  status: StoreStatus;
  /** Filesystem path actually used (undefined when disabled) */
  path?: string;
  /** Human-readable reason when status is 'fallback' or 'disabled' */
  reason?: string;
}

export interface InitResult {
  stores: Record<string, StoreInitResult>;
  warnings: string[];
}

export class StoreDisabledError extends Error {
  readonly code: string;
  readonly reason: string;

  constructor(code: string, reason?: string) {
    super(reason ?? 'Store is disabled');
    this.code = code;
    this.reason = reason ?? 'Store is disabled';
  }
}
