/**
 * Exit-code carrier for the cockpit verbs. The Commander action handler
 * catches `CockpitExit` and translates it to `process.exit(code)` after
 * writing the message to stderr. Tests intercept by catching the thrown
 * error directly — no `process.exit` needed.
 */
export class CockpitExit extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
    this.name = 'CockpitExit';
  }
}

export function isCockpitExit(err: unknown): err is CockpitExit {
  return err instanceof Error && err.name === 'CockpitExit';
}
