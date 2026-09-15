/**
 * Turning an OpenAI-compatible chat stream into text, and saying why it stopped.
 *
 * ── What this replaces, and why it had to move ──────────────────────────────
 * The NVIDIA provider consumed its stream inline, collected ONLY
 * `delta.content`, and returned `{ raw, usage, finishReason, streamChunks }`.
 * When a schedule extraction failed, that produced a report which is impossible
 * to act on:
 *
 *     streamChunks: 7500   length: 0   completionTokens: 0   finishReason: undefined
 *
 * Every distinct failure collapses into that one signature — a model that
 * reasoned without answering, a stream aborted by our own wall-clock cap, a
 * provider 500 mid-stream, and a model that genuinely returned nothing are
 * indistinguishable. The retry then re-rolled blindly and the caller waited
 * another two minutes to learn nothing.
 *
 * So this module keeps the same accumulation rules and adds the two things that
 * were missing: it records the OTHER textual channel a reasoning model uses,
 * and it reports the REASON the loop ended. Neither changes what text a healthy
 * call returns.
 *
 * ── `content` is still the only thing that becomes the answer ───────────────
 * `reasoning_content` is accumulated for diagnosis and is deliberately NOT
 * merged into the result text. On this endpoint it carries the model's
 * chain-of-thought, and feeding that to a JSON parser is how narration ends up
 * in structured output. Its LENGTH is what matters: a stream with 40k reasoning
 * characters and no content is a model that never finished thinking, which is a
 * completely different bug from a silent one — and until now they looked
 * identical.
 *
 * It is provider-agnostic on purpose: the shape it reads is the OpenAI
 * streaming contract, which is what both NVIDIA and Ollama speak.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface StreamBounds {
  /** Abort when no chunk at all arrives for this long. */
  idleMs: number;
  /** One-shot wall-clock cap, never reset. */
  maxDurationMs?: number;
  /** Cap on accumulated answer text. */
  maxOutputChars?: number;
  /** Cap on chunk count — a token proxy on providers that stream empty deltas. */
  maxStreamChunks?: number;
  /**
   * Abort when this many chunks have arrived carrying NEITHER answer text nor
   * reasoning text.
   *
   * This is the bound that distinguishes "working, slowly" from "emitting
   * nothing". It is deliberately not the same as the chunk cap: a model that is
   * visibly reasoning gets the full budget, while one producing empty frames
   * indefinitely is stopped early instead of being allowed to burn the caller's
   * entire deadline.
   */
  maxSilentChunks?: number;
  /**
   * Abort once this much chain-of-thought has streamed with NO answer yet.
   *
   * The bound that catches a reasoning runaway, measured rather than guessed
   * (2026-09-15, same image, nemotron-3-nano-omni):
   *
   *   thinking off, healthy      831 chunks,      0 reasoning chars, 1,907 content, 16s
   *   thinking on, answered    2,350 chunks,  6,645 reasoning chars, 6,645 content, 59s
   *   thinking on, runaway     7,324 chunks, 19,939 reasoning chars,     0 content, 120s+
   *
   * The third is the reported production failure. Note what separates it from
   * the second: not the volume of reasoning, but that NO answer had begun. So
   * the bound is conditional on content still being empty — a model that is
   * reasoning AND answering is never cut off, and a model that has produced
   * 20k characters of thought and not one character of answer is not about to.
   */
  maxReasoningCharsBeforeContent?: number;
}

export type StreamStop =
  /** The stream ended on its own. */
  | 'complete'
  /** No chunk arrived within `idleMs`. */
  | 'idle-timeout'
  /** `maxDurationMs` elapsed while chunks were still arriving. */
  | 'duration-cap'
  /** `maxStreamChunks` exceeded. */
  | 'chunk-cap'
  /** `maxOutputChars` exceeded. */
  | 'output-cap'
  /** `maxSilentChunks` chunks carried no text of any kind. */
  | 'silent-stream'
  /** The model streamed chain-of-thought past its budget without answering. */
  | 'reasoning-runaway'
  /** The provider sent an error event, or the request threw mid-stream. */
  | 'provider-error';

export interface StreamResult {
  /** The answer. `delta.content`, or `message.content` on a non-delta chunk. */
  content: string;
  /** The model's chain-of-thought, when it streams one. Never part of `content`. */
  reasoning: string;
  usage: any;
  finishReason?: string;
  streamChunks: number;
  /** Chunks that carried answer text. */
  contentChunks: number;
  /** Chunks that carried reasoning text. */
  reasoningChunks: number;
  /** Why the loop ended. */
  stop: StreamStop;
  /**
   * Provider failure, as a SHAPE — name, status, code. Never the message body:
   * these endpoints echo a (masked) credential back inside error text, and an
   * error string is the one place a secret reliably leaks into logs.
   */
  providerError?: string;
  /** True when a refusal or tool-call field appeared, which this caller cannot use. */
  sawToolCalls: boolean;
  sawRefusal: boolean;
}

/** Shape only — never the message text. See `providerError`. */
export function describeProviderError(err: any): string {
  const parts = [
    String(err?.name || 'Error'),
    err?.status !== undefined ? `status=${err.status}` : null,
    err?.code !== undefined ? `code=${err.code}` : null,
    err?.type !== undefined ? `type=${err.type}` : null,
  ].filter(Boolean);
  return parts.join(' ');
}

function isAbortError(err: any): boolean {
  const name = String(err?.name || '');
  return /abort/i.test(name) || err?.code === 'ABORT_ERR';
}

/**
 * Consume an OpenAI-compatible chat stream.
 *
 * `controller` is aborted on every bound, which is the documented way to stop
 * these SDK streams early. An abort raised by OUR OWN cap is not reported as a
 * provider error — the reason recorded when the cap fired is kept.
 */
export async function consumeChatStream(
  stream: AsyncIterable<any>,
  controller: { abort: () => void },
  bounds: StreamBounds,
): Promise<StreamResult> {
  let content = '';
  let reasoning = '';
  let usage: any;
  let finishReason: string | undefined;
  let streamChunks = 0;
  let contentChunks = 0;
  let reasoningChunks = 0;
  let silentRun = 0;
  let stop: StreamStop = 'complete';
  let providerError: string | undefined;
  let sawToolCalls = false;
  let sawRefusal = false;
  let stoppedByBound = false;

  let watchdog: NodeJS.Timeout | undefined;
  const arm = () => {
    if (watchdog) clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      stop = 'idle-timeout';
      stoppedByBound = true;
      controller.abort();
    }, bounds.idleMs);
  };
  const hardCap = bounds.maxDurationMs
    ? setTimeout(() => {
        stop = 'duration-cap';
        stoppedByBound = true;
        controller.abort();
      }, bounds.maxDurationMs)
    : undefined;

  try {
    arm();
    for await (const chunk of stream) {
      arm();
      streamChunks++;

      // A provider may surface a mid-stream failure as an event rather than by
      // throwing. Swallowing it is what turned a 500 into "empty response".
      if (chunk?.error) {
        stop = 'provider-error';
        providerError = describeProviderError(chunk.error);
        stoppedByBound = true;
        controller.abort();
        break;
      }

      const choice = chunk?.choices?.[0];
      // `delta` while streaming; `message` when a provider sends a whole
      // choice in one frame. Reading both keeps non-streaming shapes working.
      const part = choice?.delta ?? choice?.message ?? {};

      let sawText = false;
      if (typeof part.content === 'string' && part.content) {
        content += part.content;
        contentChunks++;
        sawText = true;
      }
      // Both spellings are in the wild: NVIDIA and DeepSeek-style endpoints use
      // `reasoning_content`, some gateways use `reasoning`.
      const reasoningPart =
        typeof part.reasoning_content === 'string'
          ? part.reasoning_content
          : typeof part.reasoning === 'string'
            ? part.reasoning
            : '';
      if (reasoningPart) {
        reasoning += reasoningPart;
        reasoningChunks++;
        sawText = true;
      }
      if (part.tool_calls) sawToolCalls = true;
      if (part.refusal) sawRefusal = true;

      silentRun = sawText ? 0 : silentRun + 1;

      if (choice?.finish_reason) finishReason = choice.finish_reason;
      if (chunk?.usage) usage = chunk.usage;

      if (bounds.maxOutputChars && content.length > bounds.maxOutputChars) {
        stop = 'output-cap';
        finishReason = 'length';
        stoppedByBound = true;
        break;
      }
      if (bounds.maxStreamChunks && streamChunks > bounds.maxStreamChunks) {
        stop = 'chunk-cap';
        finishReason = 'length';
        stoppedByBound = true;
        break;
      }
      if (bounds.maxSilentChunks && silentRun > bounds.maxSilentChunks) {
        stop = 'silent-stream';
        stoppedByBound = true;
        break;
      }
      if (
        bounds.maxReasoningCharsBeforeContent &&
        !content &&
        reasoning.length > bounds.maxReasoningCharsBeforeContent
      ) {
        stop = 'reasoning-runaway';
        stoppedByBound = true;
        break;
      }
    }
  } catch (err) {
    // An abort we asked for is not a provider failure — the bound that fired
    // already recorded the real reason.
    if (isAbortError(err) && stoppedByBound) {
      // keep `stop` as set by the bound
    } else if (isAbortError(err)) {
      stop = 'idle-timeout';
    } else {
      stop = 'provider-error';
      providerError = describeProviderError(err);
    }
  } finally {
    if (watchdog) clearTimeout(watchdog);
    if (hardCap) clearTimeout(hardCap);
  }

  return {
    content,
    reasoning,
    usage,
    finishReason,
    streamChunks,
    contentChunks,
    reasoningChunks,
    stop,
    providerError,
    sawToolCalls,
    sawRefusal,
  };
}

/**
 * One line that says what actually happened, for logs.
 *
 * Exists because the old diagnostics could not tell these apart, and every
 * future report of "extraction returned nothing" starts by needing to.
 */
export function describeStream(r: StreamResult): string {
  if (r.stop === 'provider-error') return `provider error (${r.providerError})`;
  if (r.content.length > 0) return `ok (${r.content.length} chars, ${r.stop})`;
  if (r.reasoning.length > 0) {
    const runaway =
      r.stop === 'reasoning-runaway' ? ' — thinking is not actually off' : '';
    return `reasoned without answering (${r.reasoning.length} reasoning chars, no content, ${r.stop})${runaway}`;
  }
  if (r.stop === 'silent-stream')
    return `stream produced nothing (${r.streamChunks} empty chunks)`;
  return `no output (${r.stop}, ${r.streamChunks} chunks)`;
}
