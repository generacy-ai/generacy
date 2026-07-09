import type { OutputChunk } from './types.js';
import { boundOutputTail } from './output-tail.js';

/**
 * Synthesize a bounded output tail for a CLI phase's PhaseResult from its
 * parsed OutputChunk[] transcript.
 *
 * Joins the `data.text` string of every chunk with `type === 'text'` in stored
 * order (Claude CLI emits these in write order via `processChunk`), separated
 * by newlines, then feeds through `boundOutputTail` for the 4 KiB cap.
 *
 * Non-text chunks (`init`, `tool_use`, `tool_result`, `complete`, `error`) are
 * skipped — their content is either structural or already-summarized event JSON,
 * which would clutter the tail without adding diagnostic value.
 */
export function synthesizeOutputTail(chunks: OutputChunk[]): string {
  const texts: string[] = [];
  for (const chunk of chunks) {
    if (chunk.type !== 'text') continue;
    const data = chunk.data as { text?: unknown } | null | undefined;
    if (data && typeof data.text === 'string') texts.push(data.text);
  }
  return boundOutputTail(texts.join('\n'));
}
