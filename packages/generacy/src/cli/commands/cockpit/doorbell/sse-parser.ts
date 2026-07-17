/**
 * `parseSseEventBlock` — parses one SSE frame block from smee.io.
 *
 * Matches the inline parser in
 * `packages/orchestrator/src/services/smee-receiver.ts`. Extracts the
 * `x-github-event` and `body.action` discriminators plus the full body object,
 * dropping `ready`/`ping` heartbeat frames silently. Malformed JSON → null.
 */

export interface NormalizedPayload {
  githubEvent: string;
  action: string;
  body: Record<string, unknown>;
}

export function parseSseEventBlock(text: string): NormalizedPayload | null {
  let eventType = '';
  const dataLines: string[] = [];

  for (const line of text.split('\n')) {
    if (line.startsWith('event:')) {
      eventType = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trim());
    }
  }

  if (eventType !== 'message' && eventType !== '') {
    return null;
  }

  const dataStr = dataLines.join('\n');
  if (!dataStr) return null;

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(dataStr) as Record<string, unknown>;
  } catch {
    return null;
  }

  const githubEvent = data['x-github-event'];
  if (typeof githubEvent !== 'string' || githubEvent === '') return null;

  const rawBody = data['body'];
  if (rawBody == null || typeof rawBody !== 'object') return null;
  const body = rawBody as Record<string, unknown>;

  const action = typeof body['action'] === 'string' ? (body['action'] as string) : '';

  return { githubEvent, action, body };
}
