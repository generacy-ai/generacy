/**
 * First-failure warner for the cockpit orchestrator client.
 *
 * Emits a single `cockpit: orchestrator unavailable: <reason>` line to the
 * provided sink on the first invocation, then becomes a no-op for the
 * remainder of the CLI invocation. Used so a long-running `cockpit watch`
 * doesn't spam stderr when the orchestrator is down for the whole run, while
 * still surfacing the failure once.
 */

export interface WarnSink {
  /** Typically `process.stderr.write.bind(process.stderr)`. */
  write(message: string): void;
}

export interface FirstFailureWarner {
  /** Call on each failure; emits to the sink exactly once total. */
  (reason: string): void;
  /** For tests: whether the warner has fired at least once. */
  hasFired(): boolean;
}

/**
 * Create a warner that writes a single `cockpit: orchestrator unavailable: <reason>\n`
 * line to `sink` on its first invocation and is silent on all subsequent
 * invocations.
 */
export function createFirstFailureWarner(sink: WarnSink): FirstFailureWarner {
  let fired = false;

  const warner = ((reason: string): void => {
    if (fired) {
      return;
    }
    fired = true;
    sink.write(`cockpit: orchestrator unavailable: ${reason}\n`);
  }) as FirstFailureWarner;

  warner.hasFired = (): boolean => fired;

  return warner;
}
