/**
 * AI engine barrel. Import the high-level facade from here:
 *
 *   import { ai } from '../ai';
 *   const questions = await ai.chatJSON([{ role: 'user', content: prompt }], { label: 'generate' });
 *   const text = await ai.visionText(prompt, [{ data: buffer, mimeType }], { label: 'ocr' });
 *
 * Provider selection, retries, NVIDIA→Ollama fallback, logging, and JSON repair
 * are all handled behind this facade. Future modules (PPT, notes, flashcards,
 * lesson plans, hints, adaptive generation) build on the same `ai` object without
 * touching provider code.
 */
export { ai } from './withFallback';
export { aiConfig, fallbackEnabled } from './config';
export {
  getProvider,
  getPrimaryProvider,
  getFallbackProvider,
} from './factory';
export { runBatch } from './batch';
export { pickModel } from './models';
export type { AiTask } from './models';
export { safeParse, parseArray, parseObject, stripReasoning, fixLatexBackslashes } from './json';
export { logAICall, estimateCostUSD } from './logging';
export { promptRegistry } from './promptRegistry';
export type { PromptTemplate, PromptTask } from './promptRegistry';
export type {
  AIProvider,
  ChatMessage,
  ChatOptions,
  ChatResult,
  ChatRole,
  HealthResult,
  Usage,
  VisionImage,
} from './types';
export type { ProviderName } from './config';
