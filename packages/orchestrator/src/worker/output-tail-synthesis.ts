import type { OutputChunk } from './types.js';
import { boundOutputTail } from './output-tail.js';

/**
 * Synthesize a bounded output tail for a CLI phase's PhaseResult from its
 * parsed OutputChunk[] transcript.
 *
 * The worker's `OutputCapture` stores every Claude CLI stdout line as a chunk
 * whose `data` is the RAW stream-json envelope: any top-level `type` it does not
 * recognize — including `assistant` and `result` — is mapped to the OutputChunk
 * `type: 'text'` while the full envelope is kept verbatim as `data`. The agent's
 * actual prose therefore lives at one of three shapes, NOT at a flat `data.text`:
 *
 *   1. `{ text: string }`
 *        — legacy / non-JSON / `SPECKIT_IMPLEMENT_PARTIAL` sentinel lines.
 *   2. `{ type: 'assistant', message: { content: [ { type: 'text', text } ] } }`
 *        — assistant turns (the model's messages, incl. its final "why I stopped"
 *          narrative — the single most useful line when a phase fails).
 *   3. `{ type: 'result', result: string }`
 *        — the CLI's final turn text (usually a duplicate of the last assistant
 *          text block).
 *
 * Reading only `data.text` (the pre-fix behavior) captured NONE of the real
 * assistant/result prose, so failure comments rendered an empty or one-line
 * tail even when the agent had explained itself at length. Extract text from all
 * three shapes so the diagnostic tail carries the agent's last message, then
 * feed through `boundOutputTail` for the 4 KiB / last-30-lines cap. Structural
 * chunks (`init`, `tool_use`, `tool_result`, `complete`, `error`) contribute
 * nothing.
 */
export function synthesizeOutputTail(chunks: OutputChunk[]): string {
  const texts: string[] = [];
  for (const chunk of chunks) {
    const data = chunk.data;
    if (data == null || typeof data !== 'object') continue;
    const d = data as Record<string, unknown>;

    // Shape 1 — flat text (legacy / non-JSON / sentinel lines).
    if (typeof d.text === 'string') {
      texts.push(d.text);
      continue;
    }

    // Shape 2 — assistant envelope: concatenate its `text` content blocks.
    if (d.type === 'assistant') {
      const message = d.message as { content?: unknown } | null | undefined;
      const content = message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (
            block != null &&
            typeof block === 'object' &&
            (block as Record<string, unknown>).type === 'text' &&
            typeof (block as Record<string, unknown>).text === 'string'
          ) {
            texts.push((block as Record<string, unknown>).text as string);
          }
        }
      }
      continue;
    }

    // Shape 3 — result envelope: include only when it adds something over the
    // last assistant text block it typically duplicates.
    if (d.type === 'result' && typeof d.result === 'string') {
      if (texts.length === 0 || texts[texts.length - 1] !== d.result) {
        texts.push(d.result);
      }
      continue;
    }
  }
  return boundOutputTail(texts.join('\n'));
}
