/**
 * Generic pipeline runner — feature-agnostic. A `PipelineDefinition` is just an
 * ordered list of stages; this service owns everything that would otherwise be
 * duplicated per pipeline: mode-based stage filtering, bounded per-stage retry,
 * persisting each stage's status/timing/metrics to `AiGeneration.pipeline`,
 * progress emission (Socket.IO, best-effort) + BullMQ job progress, and
 * threading each stage's output forward to the next stage.
 *
 * A future non-PPT pipeline (e.g. "generate notes from a PDF") defines its own
 * `PipelineDefinition` — reusing DocumentProcessor/VisionClassifier/
 * KnowledgeExtractor implementations where applicable — and calls this same
 * `run()`, rather than re-implementing checkpointing/retry/metrics from
 * scratch.
 */
import AiGeneration, { type AiPipelineStage } from '../../models/AiGeneration';
import type { PipelineContext, PipelineDefinition, StageResult } from './interfaces';

export interface OrchestratorRunOptions {
  /** Per-stage retry budget on thrown exceptions (not on StageResult warnings). */
  maxStageRetries?: number;
  /** Called after every stage completes (success or exhausted failure), best-effort. */
  onProgress?: (stage: AiPipelineStage, ctx: PipelineContext) => void | Promise<void>;
}

const DEFAULT_MAX_STAGE_RETRIES = 1;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stageAppliesToMode(
  runsForModes: PipelineDefinition['stages'][number]['runsForModes'],
  mode: PipelineContext['mode'],
): boolean {
  return runsForModes === 'all' || runsForModes.includes(mode);
}

/** Upsert a stage row by name — replaces its entry if present, else appends. */
async function persistStage(generationId: string, stage: AiPipelineStage): Promise<void> {
  const updated = await AiGeneration.updateOne(
    { _id: generationId, 'pipeline.stages.name': stage.name },
    { $set: { 'pipeline.currentStage': stage.name, 'pipeline.stages.$': stage } },
  );
  if (updated.matchedCount === 0) {
    await AiGeneration.updateOne(
      { _id: generationId },
      {
        $push: { 'pipeline.stages': stage },
        $set: { 'pipeline.currentStage': stage.name },
      },
    );
  }
}

async function appendWarnings(generationId: string, warnings: string[]): Promise<void> {
  if (!warnings.length) return;
  await AiGeneration.updateOne(
    { _id: generationId },
    { $push: { 'pipeline.warnings': { $each: warnings } } },
  );
}

/** Cooperative cancel: the cancel endpoint marks the doc failed/"Cancelled by
 * user" out-of-band; we can't hard-kill an in-flight stage, but checking
 * between stages means a cancelled job stops within one stage's duration
 * instead of running to completion regardless. */
async function wasCancelled(generationId: string): Promise<boolean> {
  const doc = await AiGeneration.findById(generationId).select('status error').lean();
  return !!doc && doc.status === 'failed' && doc.error === 'Cancelled by user';
}

export const AiOrchestratorService = {
  /**
   * Run every stage in `definition` applicable to `ctx.mode`, in order.
   * Returns the last stage's output alongside the merged output map (every
   * stage's output, keyed by stage name) so the caller can pull whichever
   * stage's result it needs (e.g. the render stage's artifact).
   */
  async run(
    definition: PipelineDefinition,
    ctx: PipelineContext,
    options: OrchestratorRunOptions = {},
  ): Promise<{ outputs: Record<string, unknown>; lastOutput: unknown }> {
    const maxRetries = options.maxStageRetries ?? DEFAULT_MAX_STAGE_RETRIES;
    const priorOutputs: Record<string, unknown> = {};
    let lastOutput: unknown;

    const applicableStages = definition.stages.filter((s) =>
      stageAppliesToMode(s.runsForModes, ctx.mode),
    );

    for (const stageDef of applicableStages) {
      if (await wasCancelled(ctx.generationId)) {
        const cancelledError = new Error('Cancelled by user');
        (cancelledError as any).cancelled = true;
        throw cancelledError;
      }

      const stageRow: AiPipelineStage = {
        name: stageDef.name,
        status: 'running',
        startedAt: new Date(),
      };
      await persistStage(ctx.generationId, stageRow);

      let result: StageResult<unknown> | undefined;
      let lastError: unknown;

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          result = await stageDef.execute(ctx, priorOutputs);
          break;
        } catch (err) {
          lastError = err;
          if (attempt < maxRetries) {
            await sleep(500 * Math.pow(2, attempt));
          }
        }
      }

      if (!result) {
        const finishedStage: AiPipelineStage = {
          ...stageRow,
          status: 'failed',
          finishedAt: new Date(),
          error: lastError instanceof Error ? lastError.message : String(lastError),
        };
        await persistStage(ctx.generationId, finishedStage);
        await options.onProgress?.(finishedStage, ctx);
        throw lastError instanceof Error ? lastError : new Error(String(lastError));
      }

      priorOutputs[stageDef.name] = result.output;
      lastOutput = result.output;

      const finishedStage: AiPipelineStage = {
        ...stageRow,
        status: 'done',
        finishedAt: new Date(),
        metrics: result.metrics,
      };
      await persistStage(ctx.generationId, finishedStage);
      await appendWarnings(ctx.generationId, result.warnings);
      await options.onProgress?.(finishedStage, ctx);
    }

    return { outputs: priorOutputs, lastOutput };
  },
};
