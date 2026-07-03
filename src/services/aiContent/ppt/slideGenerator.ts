/**
 * Stage 10 — Slide Generator. ONE `ai.chatJSON`-equivalent call per slide
 * (never the whole deck), grounded strictly in the slide's own
 * `knowledgeNodeIds` — never the full graph. `priorSlideTitle`/
 * `nextSlideTitle` are for natural transition phrasing in speaker notes
 * only, never a license to add content. On a retry round (fed back by the
 * Reviewer via `feedback`), the prompt asks for a targeted fix rather than a
 * full rewrite, mirroring paperGenerator.ts's existing top-up pattern.
 */
import { ai, estimateCostUSD, pickModel, promptRegistry, safeParse } from '../../../ai';
import type {
  GeneratedSlide,
  KnowledgeNode,
  PipelineContext,
  SlideBrief,
  SlideGenerationFeedback,
  SlideGenerator,
  StageResult,
} from '../../aiOrchestrator/interfaces';

const SYSTEM = `You are an expert slide author writing ONE slide at a time for a classroom lecture deck, following a teacher-approved lecture plan exactly.
When grounding content is provided, it is the ONLY source of truth — you may rephrase and condense for a clear, concise slide, but you NEVER invent facts, numbers, examples, or questions beyond it.
When the prompt explicitly says no grounding is attached, the teacher's approved plan is asking you to write that material yourself — stay strictly within the stated syllabus scope and class level.
You ALWAYS respond with a single valid JSON object and nothing else.`;

const SLIDE_SCHEMA = `{
  "title": string,
  "subtitle": string,
  "bullets": string[],
  "definitionCard": [{ "term": string, "definition": string }],
  "formulaBox": [{ "expression": string, "description": string }],
  "exampleBox": [{ "text": string }],
  "solvedExample": { "problem": string, "solution": string },
  "mcq": [{ "question": string, "options": string[], "answerIndex": number }],
  "table": { "headers": string[], "rows": [string[]] },
  "speakerNotes": string
}`;

function nodeToGroundingText(node: KnowledgeNode): string {
  const parts: string[] = [`[${node.contentType}] ${node.title || node.topic}`];
  if (node.learningObjectives?.length) parts.push(...node.learningObjectives.map((o) => `- ${o}`));
  if (node.definitions?.length) parts.push(...node.definitions.map((d) => `${d.term}: ${d.definition}`));
  if (node.explanations?.length) parts.push(...node.explanations);
  if (node.formulae?.length) parts.push(...node.formulae.map((f) => `${f.expression}${f.description ? ` — ${f.description}` : ''}`));
  if (node.examples?.length) parts.push(...node.examples);
  if (node.solvedExamples?.length) parts.push(...node.solvedExamples.map((s) => `Problem: ${s.problem}\nSolution: ${s.solution}`));
  if (node.mcqs?.length)
    parts.push(
      ...node.mcqs.map(
        (m) => `Q: ${m.question}\nOptions: ${m.options.join(' | ')}\nAnswer index: ${m.answerIndex}${m.explanation ? `\nExplanation: ${m.explanation}` : ''}`,
      ),
    );
  if (node.homework?.length) parts.push(...node.homework.map((h) => `Homework: ${h}`));
  if (node.summary?.length) parts.push(...node.summary);
  if (node.tables?.length)
    parts.push(...node.tables.map((t) => `Table: ${t.headers.join(' | ')}\n${t.rows.map((r) => r.join(' | ')).join('\n')}`));
  if (node.notes) parts.push(node.notes);
  return parts.join('\n');
}

/** Instructions derived from the approved blueprint's section spec — the
 * per-slide contract the teacher signed off on. */
function sectionSpecLines(brief: SlideBrief): string[] {
  const spec = brief.sectionSpec;
  if (!spec) return [];
  const lines: string[] = [];
  lines.push(
    `- This slide is part ${spec.positionInSection} of ${spec.sectionSlideCount} of the "${spec.sectionTitle}" section (kind: ${spec.kind}) in a teacher-approved lecture plan. Follow the plan exactly.`,
  );
  if (spec.explanationDepth === 'brief') lines.push('- Explanation depth: BRIEF — key points only, minimal elaboration.');
  if (spec.explanationDepth === 'standard') lines.push('- Explanation depth: STANDARD — clear, classroom-ready explanation.');
  if (spec.explanationDepth === 'in_depth') lines.push('- Explanation depth: IN-DEPTH — thorough explanation with reasoning, edge cases, and connections.');
  if (spec.exampleTarget != null && spec.exampleTarget > 0) {
    lines.push(`- Include EXACTLY ${spec.exampleTarget} example(s) on this slide.`);
  }
  if (spec.questionTarget != null && spec.questionTarget > 0) {
    const types = spec.questionTypes?.length ? spec.questionTypes.join(', ') : 'MCQ';
    lines.push(
      `- This slide must carry EXACTLY ${spec.questionTarget} question(s) — type(s): ${types}; difficulty: ${spec.difficulty || 'mixed'}. For MCQ use the "mcq" field (4 options each, one correct); for written-answer types list the questions as "bullets" (numbered).`,
    );
  }
  if (spec.kind === 'activity') {
    lines.push(
      `- This is a CLASSROOM ACTIVITY slide${spec.activityDescription ? `: ${spec.activityDescription}` : ''} — present the activity as clear student-facing steps in "exampleBox" entries (one step per entry), plus what students should learn from it.`,
    );
  }
  if (spec.kind === 'revision') {
    lines.push('- This is a REVISION slide — rapid-fire recall of the taught material.');
  }
  if (spec.notes) lines.push(`- Teacher's instruction for this section: ${spec.notes}`);
  return lines;
}

promptRegistry.register({
  id: 'ppt.slideGenerate',
  version: 'v2', // v2: blueprint section-spec contract + no-grounding synthesis branch
  task: 'generation',
  description: 'Authors ONE slide per the approved blueprint section spec — grounded in its assigned knowledge nodes, or synthesized from the section topic when the teacher added a section with no extracted content.',
  render: (params: {
    brief: SlideBrief;
    groundingNodes: KnowledgeNode[];
    feedback?: SlideGenerationFeedback;
    context?: { subject?: string; className?: string; chapter?: string; language?: string };
  }) => {
    const { brief, groundingNodes, feedback, context } = params;
    const lines: string[] = [];
    lines.push(`Write the content for ONE slide with layout type "${brief.layoutType}". Return EXACTLY this JSON schema (populate ONLY the field(s) relevant to this layout type; omit the rest):`);
    lines.push(SLIDE_SCHEMA);
    lines.push('');
    lines.push(
      brief.modeInstructions.preserveWordingCloseToSource
        ? '- Preserve the source wording closely — light grammar/formatting polish only, do not rewrite or condense.'
        : '- You may rewrite/condense for a clear, concise slide (short bullets, ~14 words max each).',
    );
    lines.push('- Use LaTeX delimited by $...$ for any mathematical/scientific notation.');
    lines.push(...sectionSpecLines(brief));
    if (brief.modeInstructions.extraTeacherInstruction) {
      lines.push(`- Teacher's note for this deck: ${brief.modeInstructions.extraTeacherInstruction}`);
    }
    lines.push('');
    if (groundingNodes.length) {
      lines.push('Grounding content (the ONLY source of truth for this slide — do not add anything beyond this):');
      lines.push('"""');
      lines.push(groundingNodes.map(nodeToGroundingText).join('\n\n'));
      lines.push('"""');
    } else {
      // Teacher-authored section with no extracted content behind it (e.g. a
      // practice or activity section added in the blueprint editor) — the
      // approved plan explicitly asks for this material, so synthesize it,
      // strictly within syllabus scope.
      lines.push(
        `No source content is attached to this slide — write it yourself on the topic "${brief.sectionSpec?.sectionTitle || brief.title}", strictly within the syllabus scope below. Do not exceed the class level.`,
      );
      if (context?.subject) lines.push(`Subject: ${context.subject}`);
      if (context?.className) lines.push(`Class/Grade: ${context.className}`);
      if (context?.chapter) lines.push(`Chapter: ${context.chapter}`);
      if (context?.language) lines.push(`Language: ${context.language}`);
    }
    if (brief.priorSlideTitle || brief.nextSlideTitle) {
      lines.push('');
      if (brief.priorSlideTitle) lines.push(`Previous slide: "${brief.priorSlideTitle}"`);
      if (brief.nextSlideTitle) lines.push(`Next slide: "${brief.nextSlideTitle}"`);
      lines.push('(Use these only for natural transition phrasing in speakerNotes — never to add new content.)');
    }
    if (feedback) {
      lines.push('');
      lines.push('A previous attempt at this slide had these issues — fix ONLY these, keep everything else the same:');
      lines.push(feedback.issues.map((i) => `- ${i}`).join('\n'));
      lines.push('Previous attempt:');
      lines.push(JSON.stringify(feedback.previousSlide));
    }
    return [
      { role: 'system' as const, content: SYSTEM },
      { role: 'user' as const, content: lines.join('\n') },
    ];
  },
});

function coerceSlide(raw: any, brief: SlideBrief): GeneratedSlide {
  return {
    slideIndex: brief.slideIndex,
    layoutType: brief.layoutType,
    title: String(raw?.title ?? brief.title ?? '').trim() || brief.title,
    subtitle: raw?.subtitle ? String(raw.subtitle) : undefined,
    bullets: Array.isArray(raw?.bullets) ? raw.bullets.map(String).filter(Boolean) : undefined,
    definitionCard: Array.isArray(raw?.definitionCard)
      ? raw.definitionCard.map((d: any) => ({ term: String(d?.term ?? ''), definition: String(d?.definition ?? '') })).filter((d: any) => d.term)
      : undefined,
    formulaBox: Array.isArray(raw?.formulaBox)
      ? raw.formulaBox.map((f: any) => ({ expression: String(f?.expression ?? ''), description: f?.description ? String(f.description) : undefined })).filter((f: any) => f.expression)
      : undefined,
    exampleBox: Array.isArray(raw?.exampleBox)
      ? raw.exampleBox.map((e: any) => ({ text: String(e?.text ?? '') })).filter((e: any) => e.text)
      : undefined,
    solvedExample: raw?.solvedExample?.problem
      ? { problem: String(raw.solvedExample.problem), solution: String(raw.solvedExample.solution ?? '') }
      : undefined,
    mcq: Array.isArray(raw?.mcq)
      ? raw.mcq
          .map((m: any) => ({
            question: String(m?.question ?? ''),
            options: Array.isArray(m?.options) ? m.options.map(String) : [],
            answerIndex: Number.isFinite(Number(m?.answerIndex)) ? Number(m.answerIndex) : 0,
          }))
          .filter((m: any) => m.question)
      : undefined,
    table:
      raw?.table && Array.isArray(raw.table.headers)
        ? { headers: raw.table.headers.map(String), rows: Array.isArray(raw.table.rows) ? raw.table.rows.map((r: any) => (Array.isArray(r) ? r.map(String) : [])) : [] }
        : undefined,
    speakerNotes: raw?.speakerNotes ? String(raw.speakerNotes) : undefined,
  };
}

export const slideGenerator: SlideGenerator = {
  async generateSlide(
    brief: SlideBrief,
    groundingNodes: KnowledgeNode[],
    ctx: PipelineContext,
    feedback?: SlideGenerationFeedback,
  ): Promise<StageResult<GeneratedSlide>> {
    const prompt = promptRegistry.get<{
      brief: SlideBrief;
      groundingNodes: KnowledgeNode[];
      feedback?: SlideGenerationFeedback;
      context?: { subject?: string; className?: string; chapter?: string; language?: string };
    }>('ppt.slideGenerate');
    const context = {
      subject: ctx.options.subject,
      className: ctx.options.className,
      chapter: ctx.options.chapter,
      language: ctx.options.language,
    };
    const res = await ai.chat(prompt.render({ brief, groundingNodes, feedback, context }), {
      label: `${prompt.id}@${prompt.version}`,
      model: pickModel(prompt.task),
      json: true,
      maxTokens: 2048,
    });
    const parsed = safeParse<any>(res.text);
    if (parsed === undefined) {
      throw new Error(`Slide generator returned unparseable JSON for "${brief.title}": ${res.text.slice(0, 150)}`);
    }

    return {
      output: coerceSlide(parsed, brief),
      metrics: {
        llmCalls: 1,
        tokensIn: res.usage.promptTokens,
        tokensOut: res.usage.completionTokens,
        costUsd: estimateCostUSD(res.provider, res.usage),
        retries: 0,
      },
      warnings: [],
    };
  },
};
