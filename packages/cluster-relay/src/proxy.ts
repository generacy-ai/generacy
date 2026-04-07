import type { ApiRequestMessage, ApiResponseMessage } from './messages.js';
import type { RelayConfig } from './config.js';

/**
 * Handle an API request from the cloud by proxying it to the local orchestrator.
 */
export async function handleApiRequest(
  request: ApiRequestMessage,
  config: RelayConfig,
): Promise<ApiResponseMessage> {
  const url = `${config.orchestratorUrl}${request.path}`;

  const headers: Record<string, string> = {
    ...request.headers,
  };

  if (config.orchestratorApiKey) {
    headers['X-API-Key'] = config.orchestratorApiKey;
  }

  try {
    const response = await fetch(url, {
      method: request.method,
      headers,
      body: request.body != null ? JSON.stringify(request.body) : undefined,
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    });

    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    let body: unknown;
    const contentType = response.headers.get('content-type');
    if (contentType?.includes('application/json')) {
      body = await response.json();
    } else {
      body = await response.text();
    }

    return {
      type: 'api_response',
      correlationId: request.correlationId,
      status: response.status,
      headers: responseHeaders,
      body,
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      return {
        type: 'api_response',
        correlationId: request.correlationId,
        status: 504,
        body: { error: 'Gateway Timeout', message: 'Request to orchestrator timed out' },
      };
    }

    return {
      type: 'api_response',
      correlationId: request.correlationId,
      status: 502,
      body: { error: 'Bad Gateway', message: `Failed to reach orchestrator: ${String(error)}` },
    };
  }
}
