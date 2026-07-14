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

export interface StageProgressMeta {
  /** 1-based position of this stage among the applicable stages. */
  index: number;
  /** Total applicable stages for this run (mode-filtered). */
  total: number;
  /** 0-100 overall completion (stages done / total). */
  percent: number;
}

export interface OrchestratorRunOptions {
  /** Per-stage retry budget on thrown exceptions (not on StageResult warnings). */
  maxStageRetries?: number;
  /** Called when a stage starts and when it completes (success/failure),
   * best-effort. `meta` carries overall progress for live percentage UIs. */
  onProgress?: (
    stage: AiPipelineStage,
    ctx: PipelineContext,
    meta: StageProgressMeta,
  ) => void | Promise<void>;
}

const DEFAULT_MAX_STAGE_RETRIES = 1;

/** "knowledge_extraction" -> "Knowledge Extraction" for teacher-facing errors. */
function humanStageName(name: string): string {
  return name
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** Node fetch/undici bury the real network reason in err.cause — a bare
 * "fetch failed" is useless in a log or a teacher-facing error. */
function describeError(err: unknown): string {
  const e = err as any;
  const parts: string[] = [e?.message || String(err)];
  const cause = e?.cause;
  if (cause && (cause.code || cause.message)) {
    parts.push(`(${[cause.code, cause.message].filter(Boolean).join(': ')})`);
  }
  return parts.join(' ');
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stageAppliesToMode(
  runsForModes: PipelineDefinition['stages'][number]['runsForModes'],
  mode: PipelineContext['mode'],
): boolean {
  return runsForModes === 'all' || runsForModes.includes(mode);
}

/** Upsert a stage row by name — replaces its entry if present, else appends.
 * Also stores overall `progressPercentage` so a lightweight History poll can
 * read completion without recomputing from the stage array. */
async function persistStage(
  generationId: string,
  stage: AiPipelineStage,
  progressPercentage?: number,
): Promise<void> {
  const common: Record<string, unknown> = { 'pipeline.currentStage': stage.name };
  if (progressPercentage != null) common['pipeline.progressPercentage'] = progressPercentage;

  const updated = await AiGeneration.updateOne(
    { _id: generationId, 'pipeline.stages.name': stage.name },
    { $set: { ...common, 'pipeline.stages.$': stage } },
  );
  if (updated.matchedCount === 0) {
    await AiGeneration.updateOne(
      { _id: generationId },
      { $push: { 'pipeline.stages': stage }, $set: common },
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
    const total = applicableStages.length;

    for (let stageIdx = 0; stageIdx < applicableStages.length; stageIdx++) {
      const stageDef = applicableStages[stageIdx];
      // Overall %: stages fully done before this one. A stage starting reports
      // the floor; its completion reports the next step up.
      const startMeta: StageProgressMeta = {
        index: stageIdx + 1,
        total,
        percent: Math.round((stageIdx / total) * 100),
      };
      const doneMeta: StageProgressMeta = {
        index: stageIdx + 1,
        total,
        percent: Math.round(((stageIdx + 1) / total) * 100),
      };

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
      await persistStage(ctx.generationId, stageRow, startMeta.percent);
      await options.onProgress?.(stageRow, ctx, startMeta);

      let result: StageResult<unknown> | undefined;
      let lastError: unknown;

      console.log(`[pptPipeline][${ctx.generationId}] ▶ ${stageDef.name} started`);
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          result = await stageDef.execute(ctx, priorOutputs);
          break;
        } catch (err) {
          lastError = err;
          console.warn(
            `[pptPipeline][${ctx.generationId}] ✗ ${stageDef.name} attempt ${attempt + 1}/${maxRetries + 1} failed: ${describeError(err)}`,
          );
          if (attempt < maxRetries) {
            await sleep(500 * Math.pow(2, attempt));
          }
        }
      }

      if (!result) {
        const detail = describeError(lastError);
        const finishedStage: AiPipelineStage = {
          ...stageRow,
          status: 'failed',
          finishedAt: new Date(),
          error: detail,
        };
        await persistStage(ctx.generationId, finishedStage, startMeta.percent);
        await options.onProgress?.(finishedStage, ctx, startMeta);
        // Teacher-facing + log-facing: always say WHICH stage died and WHY —
        // never a bare "Generation failed".
        const wrapped: any = new Error(`${humanStageName(stageDef.name)} failed: ${detail}`);
        wrapped.stage = stageDef.name;
        wrapped.cause = lastError;
        throw wrapped;
      }

      priorOutputs[stageDef.name] = result.output;
      lastOutput = result.output;

      const durMs = Date.now() - stageRow.startedAt!.getTime();
      const m = result.metrics;
      console.log(
        `[pptPipeline][${ctx.generationId}] ✓ ${stageDef.name} done in ${(durMs / 1000).toFixed(1)}s` +
          (m.llmCalls ? ` (llm=${m.llmCalls} tokens=${m.tokensIn}/${m.tokensOut} cost=$${m.costUsd.toFixed(4)} retries=${m.retries})` : '') +
          (result.warnings.length ? ` warnings=${result.warnings.length}` : ''),
      );
      for (const w of result.warnings) {
        console.warn(`[pptPipeline][${ctx.generationId}]   ⚠ ${stageDef.name}: ${w}`);
      }

      const finishedStage: AiPipelineStage = {
        ...stageRow,
        status: 'done',
        finishedAt: new Date(),
        metrics: result.metrics,
      };
      await persistStage(ctx.generationId, finishedStage, doneMeta.percent);
      await appendWarnings(ctx.generationId, result.warnings);
      await options.onProgress?.(finishedStage, ctx, doneMeta);
    }

    return { outputs: priorOutputs, lastOutput };
  },
};
