/**
 * The chat-stream accumulator — every shape a provider actually sends.
 *
 * ── The failure this locks down ─────────────────────────────────────────────
 * Schedule extraction failed twice in a row with:
 *
 *     streamChunks: 7500   length: 0   completionTokens: 0   finishReason: undefined
 *
 * Nothing in that report distinguishes a model that reasoned without answering,
 * a stream our own wall-clock cap aborted, a provider 500 delivered mid-stream,
 * and a model that genuinely returned nothing. The old consumer collected only
 * `delta.content`, discarded `delta.reasoning_content` entirely, swallowed
 * error events, and reported an abort as an ordinary empty result — so all four
 * arrived at the caller identically and the retry re-rolled blindly.
 *
 * ── Why fixtures ────────────────────────────────────────────────────────────
 * A provider CONTRACT is testable without a provider: these are async iterables
 * shaped exactly like the OpenAI streaming responses NVIDIA and Ollama emit.
 * That makes the malformed, error and abort paths reproducible, which they are
 * not against a live endpoint. The live behaviour is measured separately by
 * `nvidia-stream-probe.ts`.
 *
 *   npx ts-node --transpile-only scripts/safety/ai-stream-accumulator.test.ts
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  consumeChatStream,
  describeProviderError,
  describeStream,
} from '../../src/ai/streamAccumulator';
import { safeParse, stripReasoning } from '../../src/ai/json';

let failures = 0;
let checks = 0;

function check(label: string, ok: boolean, detail = '') {
  checks++;
  if (ok) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`);
  }
}

function eq<T>(label: string, actual: T, expected: T) {
  check(
    label,
    JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

/** A controller that records the abort instead of cancelling a real request. */
function fakeController() {
  const state = { aborted: false };
  return { state, abort: () => (state.aborted = true) };
}

/** An async iterable of chunks, optionally throwing at the end. */
async function* streamOf(chunks: any[], throwAtEnd?: unknown) {
  for (const c of chunks) yield c;
  if (throwAtEnd) throw throwAtEnd;
}

const delta = (d: any, finish?: string) => ({
  choices: [{ delta: d, finish_reason: finish ?? null }],
});
const usageChunk = (completion: number) => ({
  choices: [],
  usage: {
    prompt_tokens: 10,
    completion_tokens: completion,
    total_tokens: 10 + completion,
  },
});

const BOUNDS = { idleMs: 60_000 };

async function main() {
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\ncontent deltas — the ordinary case');
  // ══════════════════════════════════════════════════════════════════════════

  let r = await consumeChatStream(
    streamOf([
      delta({ content: '{"a"' }),
      delta({ content: ':1}' }),
      delta({}, 'stop'),
      usageChunk(12),
    ]),
    fakeController(),
    BOUNDS,
  );
  eq('text is accumulated in order', r.content, '{"a":1}');
  eq('stop is complete', r.stop, 'complete');
  eq('finish_reason is kept', r.finishReason, 'stop');
  eq('usage is kept', r.usage?.completion_tokens, 12);
  eq('chunk count includes the usage frame', r.streamChunks, 4);
  eq('content chunks counted', r.contentChunks, 2);
  eq('no reasoning seen', r.reasoning, '');

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\nreasoning + content — a reasoning model answering properly');
  // ══════════════════════════════════════════════════════════════════════════

  r = await consumeChatStream(
    streamOf([
      delta({ reasoning_content: 'Let me look at the grid. ' }),
      delta({ reasoning_content: 'Row 1 says 9th JEE. ' }),
      delta({ content: '{"scheduleDate":"2026-09-14"}' }),
      delta({}, 'stop'),
    ]),
    fakeController(),
    BOUNDS,
  );
  eq('the ANSWER is content only', r.content, '{"scheduleDate":"2026-09-14"}');
  check(
    'chain-of-thought never leaks into the answer',
    !r.content.includes('Let me look'),
    r.content,
  );
  eq(
    'reasoning is measured separately',
    r.reasoning.length,
    'Let me look at the grid. Row 1 says 9th JEE. '.length,
  );
  eq('reasoning chunks counted', r.reasoningChunks, 2);
  check('and the answer still parses', safeParse(r.content) !== undefined);

  // The `reasoning` spelling some gateways use.
  r = await consumeChatStream(
    streamOf([
      delta({ reasoning: 'thinking' }),
      delta({ content: 'ok' }, 'stop'),
    ]),
    fakeController(),
    BOUNDS,
  );
  eq('the `reasoning` spelling is also captured', r.reasoning, 'thinking');
  eq('without polluting content', r.content, 'ok');

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\nreasoning ONLY — the failure that looked like silence');
  // ══════════════════════════════════════════════════════════════════════════

  r = await consumeChatStream(
    streamOf([
      delta({ reasoning_content: 'x'.repeat(5000) }),
      delta({ reasoning_content: 'y'.repeat(5000) }),
    ]),
    fakeController(),
    BOUNDS,
  );
  eq('no answer', r.content, '');
  eq('but 10,000 characters of reasoning', r.reasoning.length, 10000);
  check(
    'and the description says exactly that',
    /reasoned without answering/.test(describeStream(r)),
    describeStream(r),
  );

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\nnon-delta shape — a provider that sends whole messages');
  // ══════════════════════════════════════════════════════════════════════════

  r = await consumeChatStream(
    streamOf([
      {
        choices: [
          { message: { content: '{"ok":true}' }, finish_reason: 'stop' },
        ],
      },
    ]),
    fakeController(),
    BOUNDS,
  );
  eq('message.content is read like delta.content', r.content, '{"ok":true}');
  eq('and its finish_reason is kept', r.finishReason, 'stop');

  r = await consumeChatStream(
    streamOf([
      { choices: [{ message: { reasoning_content: 'hm', content: 'A' } }] },
    ]),
    fakeController(),
    BOUNDS,
  );
  eq('message.reasoning_content is separated too', r.reasoning, 'hm');
  eq('leaving the answer clean', r.content, 'A');

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\nempty and malformed streams');
  // ══════════════════════════════════════════════════════════════════════════

  r = await consumeChatStream(streamOf([]), fakeController(), BOUNDS);
  eq('an empty stream yields nothing', r.content, '');
  eq('with zero chunks', r.streamChunks, 0);
  eq('and completes rather than erroring', r.stop, 'complete');

  r = await consumeChatStream(
    streamOf([
      null,
      undefined,
      {},
      { choices: [] },
      { choices: [{}] },
      { choices: [{ delta: null }] },
      { choices: [{ delta: { content: 123 } }] }, // wrong type
      { choices: [{ delta: { content: 'good' } }] },
    ]),
    fakeController(),
    BOUNDS,
  );
  eq('malformed chunks are skipped, not fatal', r.content, 'good');
  eq('every frame is still counted', r.streamChunks, 8);
  eq('and the stream completes', r.stop, 'complete');

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\nprovider errors are surfaced, not swallowed');
  // ══════════════════════════════════════════════════════════════════════════

  const ctl = fakeController();
  r = await consumeChatStream(
    streamOf([
      delta({ content: 'partial' }),
      {
        error: {
          message: 'internal',
          code: 500,
          type: 'internal_server_error',
        },
      },
      delta({ content: 'never reached' }),
    ]),
    ctl,
    BOUNDS,
  );
  eq('an in-stream error event stops the loop', r.stop, 'provider-error');
  eq('and nothing after it is read', r.content, 'partial');
  check('the request is aborted', ctl.state.aborted);
  check(
    'the error is described',
    Boolean(r.providerError),
    String(r.providerError),
  );

  // A throw mid-stream (the SDK's usual shape for an HTTP failure).
  const thrown: any = new Error('Incorrect API key provided: nvapi-rT****rh-j');
  thrown.name = 'APIError';
  thrown.status = 500;
  thrown.code = 'internal_server_error';
  r = await consumeChatStream(
    streamOf([delta({ content: 'a' })], thrown),
    fakeController(),
    BOUNDS,
  );
  eq('a thrown provider failure is reported as one', r.stop, 'provider-error');
  check(
    'with its shape',
    /status=500/.test(r.providerError || ''),
    r.providerError,
  );
  check(
    'and NEVER its message body — that is where a masked key leaks',
    !/nvapi|API key/i.test(r.providerError || ''),
    r.providerError,
  );
  check(
    'the same holds for the shared describer',
    !/nvapi|API key/i.test(describeProviderError(thrown)),
    describeProviderError(thrown),
  );

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\nmissing finish_reason is not an error');
  // ══════════════════════════════════════════════════════════════════════════

  r = await consumeChatStream(
    streamOf([delta({ content: '{"a":1}' })]),
    fakeController(),
    BOUNDS,
  );
  eq('the text still arrives', r.content, '{"a":1}');
  eq('finishReason is simply absent', r.finishReason, undefined);
  eq('and our own account is present instead', r.stop, 'complete');
  check(
    'which is what makes the outcome legible',
    /ok \(/.test(describeStream(r)),
    describeStream(r),
  );

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\nbounds — and which one fired');
  // ══════════════════════════════════════════════════════════════════════════

  const many = (n: number, d: any) => Array.from({ length: n }, () => delta(d));

  r = await consumeChatStream(streamOf(many(50, {})), fakeController(), {
    idleMs: 60_000,
    maxSilentChunks: 10,
  });
  eq('a stream emitting nothing is cut early', r.stop, 'silent-stream');
  check(
    'long before the whole stream is drained',
    r.streamChunks < 20,
    String(r.streamChunks),
  );
  check(
    'and says so',
    /produced nothing/.test(describeStream(r)),
    describeStream(r),
  );

  // A model that IS reasoning keeps its budget — the silent bound must not fire.
  r = await consumeChatStream(
    streamOf(many(50, { reasoning_content: '.' })),
    fakeController(),
    { idleMs: 60_000, maxSilentChunks: 10 },
  );
  eq('visible reasoning resets the silence counter', r.stop, 'complete');
  eq('so all 50 chunks are consumed', r.streamChunks, 50);

  // ── The reported production failure, reproduced ────────────────────────────
  // Measured live on nemotron-3-nano-omni with the thinking switch not in
  // effect: 7,324 chunks, 19,939 reasoning characters, ZERO content, no
  // finish_reason, cut only by the wall clock at 120s. Neither the idle
  // watchdog (tokens kept arriving), nor the content cap (no content), nor the
  // silent bound (reasoning is not silence) can see that.
  r = await consumeChatStream(
    streamOf(many(400, { reasoning_content: 'x'.repeat(100) })),
    fakeController(),
    {
      idleMs: 60_000,
      maxSilentChunks: 3000,
      maxReasoningCharsBeforeContent: 8000,
    },
  );
  eq(
    'a reasoning runaway is cut on the reasoning budget',
    r.stop,
    'reasoning-runaway',
  );
  check(
    'long before the stream drains',
    r.streamChunks < 120,
    String(r.streamChunks),
  );
  eq('with no answer to show for it', r.content, '');
  check(
    'and the diagnosis names the cause',
    /thinking is not actually off/.test(describeStream(r)),
    describeStream(r),
  );

  // A model that reasons AND answers must never be cut — measured at 6,645
  // reasoning characters alongside a real 6,645-character answer.
  r = await consumeChatStream(
    streamOf([
      delta({ content: '{' }),
      ...many(400, { reasoning_content: 'y'.repeat(100) }),
      delta({ content: '}' }, 'stop'),
    ]),
    fakeController(),
    { idleMs: 60_000, maxReasoningCharsBeforeContent: 8000 },
  );
  eq('an answering model keeps its full budget', r.stop, 'complete');
  eq('and its answer survives intact', r.content, '{}');
  check(
    'however much it reasons',
    r.reasoning.length > 8000,
    String(r.reasoning.length),
  );

  r = await consumeChatStream(
    streamOf(many(50, { content: 'xxxx' })),
    fakeController(),
    {
      idleMs: 60_000,
      maxOutputChars: 20,
    },
  );
  eq('the output cap fires', r.stop, 'output-cap');
  eq('and reports truncation', r.finishReason, 'length');

  r = await consumeChatStream(
    streamOf(many(50, { content: 'x' })),
    fakeController(),
    {
      idleMs: 60_000,
      maxStreamChunks: 10,
    },
  );
  eq('the chunk cap fires', r.stop, 'chunk-cap');
  eq('and reports truncation', r.finishReason, 'length');

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\nJSON: accumulated across chunks, and rejected when invalid');
  // ══════════════════════════════════════════════════════════════════════════

  r = await consumeChatStream(
    streamOf([
      delta({ content: '{"scheduleDate":"2026-09-14",' }),
      delta({ content: '"sections":[{"columns":["9-10AM"],' }),
      delta({ content: '"rows":["11th"],"cells":[]}],' }),
      delta({ content: '"warnings":[]}' }),
      delta({}, 'stop'),
    ]),
    fakeController(),
    BOUNDS,
  );
  const parsed: any = safeParse(stripReasoning(r.content));
  check('JSON split across five chunks parses', parsed !== undefined);
  eq('with its fields intact', parsed?.sections?.[0]?.columns, ['9-10AM']);

  r = await consumeChatStream(
    streamOf([
      delta(
        { content: 'Here is the schedule you asked for. Not JSON.' },
        'stop',
      ),
    ]),
    fakeController(),
    BOUNDS,
  );
  eq('a healthy model returning prose still completes', r.stop, 'complete');
  check('and the text is present', r.content.length > 0);
  eq('but it does not parse', safeParse(r.content), undefined);
  check(
    'so the failure is attributable to the ANSWER, not the provider',
    r.stop === 'complete' && r.providerError === undefined,
  );

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\ntool calls and refusals are noticed, not silently dropped');
  // ══════════════════════════════════════════════════════════════════════════

  r = await consumeChatStream(
    streamOf([
      delta({ tool_calls: [{ id: 't1' }] }),
      delta({ refusal: 'no' }, 'stop'),
    ]),
    fakeController(),
    BOUNDS,
  );
  check('tool calls flagged', r.sawToolCalls);
  check('refusal flagged', r.sawRefusal);
  eq('and no answer text is invented', r.content, '');

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\nthe caller retries re-rolls, not provider failures');
  // ══════════════════════════════════════════════════════════════════════════

  const routeSrc = readFileSync(
    join(process.cwd(), 'src', 'routes', 'api', 'scheduleRoutes.ts'),
    'utf8',
  );
  const retryBlock = routeSrc.slice(
    routeSrc.indexOf('const RETRYABLE'),
    routeSrc.indexOf('MIN_USEFUL_RETRY_MS'),
  );
  check('a re-rollable empty response is retried', /'empty',/.test(retryBlock));
  check('so is a cut-off stream', /'cut-off',/.test(retryBlock));
  check(
    'so is a reasoning-only response',
    /'reasoned-without-answering',/.test(retryBlock),
  );
  check(
    'the schedule call sets a reasoning budget',
    routeSrc.includes('const maxReasoningCharsBeforeContent = 8000;'),
  );
  // The silent-chunk bound is deliberately NOT used on this provider: measured
  // 2026-09-15, a healthy run delivered 549 chunks of which 548 were empty
  // because the whole answer arrives in the final chunk. Any threshold low
  // enough to catch a dead stream there would truncate a real extraction.
  check(
    'the schedule call sets NO silent-chunk bound',
    !/maxSilentChunks,/.test(routeSrc),
  );
  check(
    'and says why',
    routeSrc.includes('Why there is NO silent-chunk bound here'),
  );
  check(
    'the attempt budget is bounded from measured healthy runs',
    routeSrc.includes('const attemptMaxDurationMs = 90000;'),
  );
  check(
    'and the two-attempt worst case is 180s, not 260s',
    routeSrc.includes('const totalBudgetMs = 180000;'),
  );
  check(
    'a silent provider is still NOT retried when a caller does set that bound',
    !/'provider-silent'/.test(retryBlock),
    retryBlock,
  );
  check(
    'and a non-retryable reason fails immediately',
    routeSrc.includes('not retryable'),
  );
  check(
    'the provider throws on an error stream rather than returning empty text',
    readFileSync(
      join(process.cwd(), 'src', 'ai', 'providers', 'nvidiaProvider.ts'),
      'utf8',
    ).includes("if (streamed.stop === 'provider-error') {"),
  );

  console.log(
    `\n${failures ? '✗ FAILED' : '✓ PASSED'} — ${checks - failures}/${checks} checks\n`,
  );
  if (failures) process.exit(1);
}

main().catch((err) => {
  console.error('\nharness error:', err);
  process.exit(1);
});
