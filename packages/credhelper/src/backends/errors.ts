export type StorageErrorCode =
  | 'SECRET_NOT_FOUND'
  | 'STORE_CORRUPT'
  | 'STORE_MIGRATION_NEEDED'
  | 'KEY_UNAVAILABLE';

export class StorageError extends Error {
  readonly code: StorageErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: StorageErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'StorageError';
    this.code = code;
    this.details = details;
  }
}
