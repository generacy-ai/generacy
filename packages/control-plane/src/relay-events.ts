export type PushEventFn = (channel: string, payload: unknown) => void;

let pushEventFn: PushEventFn | undefined;

/** Inject the relay pushEvent callback at server construction time. */
export function setRelayPushEvent(fn: PushEventFn): void {
  pushEventFn = fn;
}

export function getRelayPushEvent(): PushEventFn | undefined {
  return pushEventFn;
}
