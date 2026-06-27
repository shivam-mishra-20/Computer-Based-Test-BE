/**
 * Task → model selection. Feature code never hardcodes a model id; it asks for a
 * *task* and gets back the configured NVIDIA model for that responsibility:
 *
 *   generation — PPT/paper/notes/lesson writing & educational content
 *   vision     — reading PDFs/PPT/DOCX pages, images, diagrams, tables
 *   fast       — metadata, JSON formatting, grammar cleanup, validation, small rewrites
 *
 * The chosen id is passed to the `ai` facade via `ChatOptions.model`, which the
 * provider already honours per-call — so no provider code needs to change.
 */
import { aiConfig } from './config';

export type AiTask = 'generation' | 'vision' | 'fast';

export function pickModel(task: AiTask): string {
  switch (task) {
    case 'vision':
      return aiConfig.nvidia.modelVision;
    case 'fast':
      return aiConfig.nvidia.modelFast;
    case 'generation':
    default:
      return aiConfig.nvidia.modelGeneration;
  }
}
