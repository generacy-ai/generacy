export type ActivationErrorCode =
  | 'CLOUD_UNREACHABLE'
  | 'DEVICE_CODE_EXPIRED'
  | 'INVALID_RESPONSE';

export class ActivationError extends Error {
  constructor(
    message: string,
    public readonly code: ActivationErrorCode,
  ) {
    super(message);
    this.name = 'ActivationError';
  }
}
