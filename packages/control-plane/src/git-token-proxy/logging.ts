import type { UpstreamErrorCode } from './upstream-errors.js';

export function logProxyInit(args: { listenSocket: string; upstreamSocket: string }): void {
  console.log(
    JSON.stringify({
      event: 'git-token-proxy-init',
      listenSocket: args.listenSocket,
      upstreamSocket: args.upstreamSocket,
    }),
  );
}

export function logUpstreamError(args: { code: UpstreamErrorCode }): void {
  console.log(
    JSON.stringify({
      event: 'git-token-proxy-upstream-error',
      code: args.code,
    }),
  );
}
