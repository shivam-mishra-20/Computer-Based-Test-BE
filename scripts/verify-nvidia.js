/**
 * NVIDIA connectivity check. Verifies NVIDIA_API_KEY + endpoint + models respond.
 * Also probes the local Ollama fallback when available.
 *
 *   node scripts/verify-nvidia.js
 */
require('dotenv').config();

const BASE_URL = process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1';
const TEXT_MODEL = process.env.NVIDIA_MODEL_PRIMARY || 'nvidia/llama-3.3-nemotron-super-49b-v1.5';
const VISION_MODEL = process.env.NVIDIA_MODEL_VISION || 'meta/llama-3.2-90b-vision-instruct';
const REASONING = (process.env.NVIDIA_REASONING || 'off').toLowerCase() === 'on' ? 'on' : 'off';

async function checkNvidia() {
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) {
    console.error('✗ NVIDIA_API_KEY is not set');
    return false;
  }
  const OpenAI = require('openai');
  const client = new OpenAI({ apiKey, baseURL: BASE_URL });

  try {
    const started = Date.now();
    const completion = await client.chat.completions.create({
      model: TEXT_MODEL,
      messages: [
        { role: 'system', content: `detailed thinking ${REASONING}` },
        { role: 'user', content: 'Reply with exactly: ok' },
      ],
      max_tokens: 512,
      temperature: 0,
      stream: false,
    });
    const text = (completion.choices?.[0]?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    const u = completion.usage || {};
    console.log(`✓ NVIDIA text model OK  [${TEXT_MODEL}]  ${Date.now() - started}ms  reply="${text.slice(0, 40)}"  tokens=${u.prompt_tokens || 0}+${u.completion_tokens || 0}`);
    console.log(`ℹ Vision model configured: ${VISION_MODEL}`);
    return true;
  } catch (err) {
    console.error(`✗ NVIDIA error: ${err && err.message ? err.message : err}`);
    return false;
  }
}

async function checkOllama() {
  try {
    const { Ollama } = require('ollama');
    const host = process.env.OLLAMA_HOST || 'http://localhost:11434';
    const model = process.env.OLLAMA_MODEL || 'qwen3:8b';
    const ollama = new Ollama({ host });
    const list = await ollama.list();
    const base = model.split(':')[0];
    const has = list.models.some((m) => m.name.startsWith(base));
    console.log(has
      ? `✓ Ollama fallback OK     [${model}] at ${host}`
      : `⚠ Ollama reachable at ${host} but ${model} not pulled (ollama pull ${model})`);
  } catch {
    console.log('⚠ Ollama not reachable (fallback unavailable; cloud-only mode)');
  }
}

(async () => {
  console.log(`AI_PROVIDER=${process.env.AI_PROVIDER || 'nvidia'}  base=${BASE_URL}`);
  const ok = await checkNvidia();
  await checkOllama();
  process.exit(ok ? 0 : 1);
})();
