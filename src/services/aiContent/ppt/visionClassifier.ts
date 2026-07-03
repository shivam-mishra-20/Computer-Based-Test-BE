/**
 * Stage 2 — Vision Analysis. The vision model ONLY classifies + verbatim-
 * transcribes; it never generates or rewrites content (enforced by prompt
 * discipline, mirroring the existing extractTextFromImage "do NOT paraphrase"
 * rule in aiService.ts). Runs on every RawPage that has an imageBuffer
 * (rasterized PDF pages, embedded PPTX/DOCX media) — skipped entirely for
 * prompt-only generation and for PPTX/DOCX text-only pages (documentProcessor
 * already gave those clean structured text, no noise to strip).
 */
import { ai, estimateCostUSD, pickModel, promptRegistry, runBatch, safeParse } from '../../../ai';
import { emptyMetrics } from '../../aiOrchestrator/interfaces';
import type {
  NoiseReason,
  PipelineContext,
  RawPage,
  RegionLabel,
  StageResult,
  VisionClassifier,
  VisionPageClassification,
  VisionRegion,
} from '../../aiOrchestrator/interfaces';

const REGION_LABELS: RegionLabel[] = ['KEEP', 'REMOVE', 'OPTIONAL'];
const NOISE_REASONS: NoiseReason[] = [
  'handwriting', 'marker_annotation', 'watermark', 'scanner_border', 'camera_shadow',
  'staple_fold_mark', 'source_logo', 'source_page_furniture', 'blank_margin', 'none',
];
const REGION_TYPES = ['text_block', 'diagram', 'table', 'photo', 'handwriting', 'logo', 'unclear'] as const;

promptRegistry.register({
  id: 'ppt.visionClassify',
  version: 'v1',
  task: 'vision',
  description: 'Segments a page/image into regions, classifies each KEEP/REMOVE/OPTIONAL, verbatim-transcribes KEEP/OPTIONAL text — never generates content.',
  render: () => [
    {
      role: 'user',
      content: `You are a REGION CLASSIFIER AND VERBATIM TRANSCRIBER for a classroom document — not a writer.

TASK: Segment this page/image into logical regions, then classify each region and (for text regions) transcribe it EXACTLY as written.

TAXONOMY:
- KEEP: genuine educational content — printed/typed text, real diagrams, tables, illustrations.
- REMOVE: pure visual noise — a person/teacher/hand/face/body, handwritten notes, marker/pen annotations, watermarks, scanner borders, camera shadows, staple/fold marks, the source document's own logo, page furniture (headers/footers/page numbers of the SOURCE document), blank margins.
- OPTIONAL: ambiguous items (an institution logo, a decorative divider) that could go either way.

STEPS (in order):
1. Segment the page into regions. For each region, note its type: text_block, diagram, table, photo, handwriting, logo, or unclear.
2. Classify each region KEEP / REMOVE / OPTIONAL per the taxonomy above. If REMOVE, give the specific noise reason.
3. For every KEEP or OPTIONAL region of type text_block, table, or diagram-with-labels: transcribe its text EXACTLY as it appears — verbatim, no paraphrasing, no summarizing, no correcting. Preserve numbers, symbols, and mathematical notation precisely.
4. For diagram/photo regions, do NOT describe or interpret their content — just classify them; the region will be cropped and embedded directly later.

Respond with ONLY this JSON object, nothing else:
{
  "regions": [
    {
      "regionType": "text_block"|"diagram"|"table"|"photo"|"handwriting"|"logo"|"unclear",
      "label": "KEEP"|"REMOVE"|"OPTIONAL",
      "noiseReason": "handwriting"|"marker_annotation"|"watermark"|"scanner_border"|"camera_shadow"|"staple_fold_mark"|"source_logo"|"source_page_furniture"|"blank_margin"|"none",
      "bbox": [x0, y0, x1, y1],
      "verbatimText": "string or omit if not a text region",
      "confidence": 0.0
    }
  ],
  "pageLevelNote": "string or omit"
}
bbox coordinates are normalized 0-1 (top-left origin). Omit "verbatimText" for diagram/photo/logo regions.`,
    },
  ],
});

function coerceRegion(raw: any, index: number, pageIndex: number): VisionRegion | null {
  const label: RegionLabel = REGION_LABELS.includes(raw?.label) ? raw.label : 'OPTIONAL';
  const noiseReason: NoiseReason = NOISE_REASONS.includes(raw?.noiseReason) ? raw.noiseReason : 'none';
  const regionType = (REGION_TYPES as readonly string[]).includes(raw?.regionType)
    ? raw.regionType
    : 'unclear';
  const bboxRaw = Array.isArray(raw?.bbox) ? raw.bbox.map(Number) : [];
  const bbox: [number, number, number, number] =
    bboxRaw.length === 4 && bboxRaw.every((n: number) => Number.isFinite(n))
      ? (bboxRaw as [number, number, number, number])
      : [0, 0, 1, 1];

  return {
    regionId: `p${pageIndex}-r${index}`,
    bbox,
    label,
    noiseReason,
    regionType: regionType as VisionRegion['regionType'],
    verbatimText: typeof raw?.verbatimText === 'string' ? raw.verbatimText : undefined,
    diagramPlaceholder:
      regionType === 'diagram' || regionType === 'photo' ? `[${regionType.toUpperCase()}]` : undefined,
    confidence: Number.isFinite(Number(raw?.confidence)) ? Number(raw.confidence) : 0.5,
  };
}

/** Resolve OPTIONAL regions per the v1 auto-resolve rule (§7): KEEP if it
 * carries parseable text, else REMOVE. No teacher approve/reject step yet. */
function resolveOptional(region: VisionRegion): VisionRegion {
  if (region.label !== 'OPTIONAL') return region;
  const hasText = !!region.verbatimText && region.verbatimText.trim().length > 0;
  return { ...region, label: hasText ? 'KEEP' : 'REMOVE' };
}

async function classifyPage(page: RawPage): Promise<{
  classification: VisionPageClassification;
  usage: { promptTokens: number; completionTokens: number };
  provider: string;
  costUsd: number;
}> {
  const prompt = promptRegistry.get('ppt.visionClassify');
  const messages = prompt.render({});
  const promptText = messages[messages.length - 1].content;

  const res = await ai.vision(
    promptText,
    [{ data: page.imageBuffer!, mimeType: page.imageMimeType || 'image/png' }],
    { label: `${prompt.id}@${prompt.version}`, model: pickModel(prompt.task), maxTokens: 4096 },
  );

  const parsed = safeParse<any>(res.text);
  const regionsRaw = Array.isArray(parsed?.regions) ? parsed.regions : [];
  const regions = regionsRaw
    .map((r: any, i: number) => coerceRegion(r, i, page.pageIndex))
    .filter((r: VisionRegion | null): r is VisionRegion => !!r)
    .map(resolveOptional);

  return {
    classification: {
      pageIndex: page.pageIndex,
      regions,
      pageLevelNote: typeof parsed?.pageLevelNote === 'string' ? parsed.pageLevelNote : undefined,
    },
    usage: { promptTokens: res.usage.promptTokens, completionTokens: res.usage.completionTokens },
    provider: res.provider,
    costUsd: estimateCostUSD(res.provider, res.usage),
  };
}

export const visionClassifier: VisionClassifier = {
  async classify(
    pages: RawPage[],
    _ctx: PipelineContext,
  ): Promise<StageResult<VisionPageClassification[]>> {
    const rasterPages = pages.filter((p) => !!p.imageBuffer);
    if (!rasterPages.length) {
      return { output: [], metrics: emptyMetrics(), warnings: [] };
    }

    const { results, failures } = await runBatch(rasterPages, (page) => classifyPage(page));

    const classifications: VisionPageClassification[] = [];
    let tokensIn = 0;
    let tokensOut = 0;
    let costUsd = 0;
    for (const r of results) {
      if (!r) continue;
      classifications.push(r.classification);
      tokensIn += r.usage.promptTokens;
      tokensOut += r.usage.completionTokens;
      costUsd += r.costUsd;
    }
    classifications.sort((a, b) => a.pageIndex - b.pageIndex);

    const warnings = failures.map(
      (f) => `Vision classification failed for page ${rasterPages[f.index].pageIndex}: ${f.error.message}`,
    );

    return {
      output: classifications,
      metrics: {
        llmCalls: results.filter(Boolean).length,
        tokensIn,
        tokensOut,
        costUsd,
        retries: failures.length, // runBatch already retried internally; count failures as a proxy
      },
      warnings,
    };
  },
};
