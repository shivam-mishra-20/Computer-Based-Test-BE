/**
 * Stage 10 — Slide Generator. ONE `ai.chatJSON`-equivalent call per slide
 * (never the whole deck), grounded strictly in the slide's own
 * `knowledgeNodeIds` — never the full graph. `priorSlideTitle`/
 * `nextSlideTitle` are for natural transition phrasing in speaker notes
 * only, never a license to add content. On a retry round (fed back by the
 * Reviewer via `feedback`), the prompt asks for a targeted fix rather than a
 * full rewrite, mirroring paperGenerator.ts's existing top-up pattern.
 */
import { ai, aiConfig, estimateCostUSD, pickModel, promptRegistry, safeParse } from '../../../ai';
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

export function nodeToGroundingText(node: KnowledgeNode): string {
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
  version: 'v3', // v3: per-layout content minimums + controlled expansion on thin grounding (v2 said "nothing beyond grounding", which produced thin slides)
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
        ? '- This slide REBUILDS one page of the teacher\'s own presentation. Include EVERY piece of content from the grounding — every definition, formula, derivation step, solved example, question, table row and note. Reorganize into the layout, fix grammar/OCR artifacts, but do NOT rewrite, condense, summarize or drop anything, and do NOT add anything that is not in the grounding (no new examples, questions, tips or applications). Same meaning, same order, same information — only the presentation improves.'
        : '- Write RICH, classroom-ready content: substantive points (each a complete thought, ~8-16 words), not one-line summaries. Fill the slide layout generously — a teacher should be able to teach several minutes from this one slide.',
    );
    // Per-layout content minimums — thin slides are the #1 teacher complaint.
    const MINIMUMS: Record<string, string> = {
      content_bullets: '- Minimum content: 5-7 bullets. Each bullet = one complete teachable idea, not a fragment.',
      objectives: '- Minimum content: 4-6 measurable objectives ("Define…", "Calculate…", "Explain why…").',
      definition_card: '- Minimum content: 2-4 term+definition pairs; definitions precise and class-appropriate.',
      formula_highlight: '- Every formula gets a plain-language description AND what each symbol means.',
      example_box: '- Minimum content: 2-3 fully worked, concrete examples (real numbers/situations, not placeholders).',
      solved_example: '- One complete problem with a full step-by-step numbered solution — every step shown, nothing skipped.',
      mcq_card: '- Each question must be distinct (never repeat a question on the deck), have EXACTLY 4 plausible options, a correct answerIndex, and vary which option is correct.',
      summary_card: '- Minimum content: 5-6 recap points covering every key idea taught in this section.',
      homework: '- Minimum content: 4-6 concrete tasks of mixed difficulty, doable without the teacher.',
      table: '- A real comparison/data table with 3+ rows — never a 1-row placeholder.',
    };
    // Content minimums drive richness in GENERATE mode only — in preserve
    // (redesign) mode they would push the model to INVENT filler, the exact
    // opposite of faithful recreation.
    if (!brief.modeInstructions.preserveWordingCloseToSource && MINIMUMS[brief.layoutType]) {
      lines.push(MINIMUMS[brief.layoutType]);
    }
    lines.push('- Accuracy is non-negotiable: every fact, formula, value and answer must be correct for this class level and board. If unsure of a specific number, state the concept without inventing the number.');
    lines.push('- speakerNotes: 3-5 sentences the teacher can SAY while showing this slide (explanation + one question to ask the class).');
    lines.push('- Use LaTeX delimited by $...$ for any mathematical/scientific notation. Fill-in blanks go OUTSIDE math as ______, never as underscores inside $...$.');
    lines.push(...sectionSpecLines(brief));
    if (brief.modeInstructions.extraTeacherInstruction) {
      lines.push(`- Teacher's note for this deck: ${brief.modeInstructions.extraTeacherInstruction}`);
    }
    lines.push('');
    if (groundingNodes.length) {
      lines.push(
        brief.modeInstructions.preserveWordingCloseToSource
          ? 'Grounding content (the ONLY source of truth for this slide — do not add anything beyond this):'
          : 'Grounding content (the factual anchor for this slide). Teach THIS material — and where it is brief, elaborate it to meet the content minimums with standard curriculum knowledge of the same topic at this class level. Never contradict the grounding; never drift to a different topic:',
      );
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

/**
 * Sanitize model/OCR output before it can reach a slide — observed artifacts:
 * literal "\n"/"\t" escape sequences printed as text, LaTeX \( \) \[ \]
 * delimiters (the renderers only understand $...$), markdown ** / __ / ` that
 * pptx renders literally, and stray double-escaped backslashes.
 */
export function cleanText(v: unknown): string {
  let s = String(v ?? '');
  // Normalize LaTeX delimiters to the $-form every renderer here understands.
  s = s.replace(/\\\(\s*/g, '$').replace(/\s*\\\)/g, '$');
  s = s.replace(/\\\[\s*/g, '$').replace(/\s*\\\]/g, '$');
  // Literal escape sequences that arrived as TEXT (backslash + letter), not
  // as real control characters. Keep \\ (LaTeX) intact.
  s = s.replace(/(?<!\\)\\n/g, ' ').replace(/(?<!\\)\\t/g, ' ');
  // Markdown emphasis/code markers render literally in PPTX — strip markers,
  // keep the content.
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/__([^_]+)__/g, '$1').replace(/`([^`]+)`/g, '$1');
  // Collapse runaway whitespace from OCR joins.
  s = s.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

function coerceSlide(raw: any, brief: SlideBrief): GeneratedSlide {
  return {
    slideIndex: brief.slideIndex,
    layoutType: brief.layoutType,
    title: cleanText(raw?.title ?? brief.title ?? '') || brief.title,
    subtitle: raw?.subtitle ? cleanText(raw.subtitle) : undefined,
    bullets: Array.isArray(raw?.bullets) ? raw.bullets.map(cleanText).filter(Boolean) : undefined,
    definitionCard: Array.isArray(raw?.definitionCard)
      ? raw.definitionCard.map((d: any) => ({ term: cleanText(d?.term), definition: cleanText(d?.definition) })).filter((d: any) => d.term)
      : undefined,
    formulaBox: Array.isArray(raw?.formulaBox)
      ? raw.formulaBox.map((f: any) => ({ expression: cleanText(f?.expression), description: f?.description ? cleanText(f.description) : undefined })).filter((f: any) => f.expression)
      : undefined,
    exampleBox: Array.isArray(raw?.exampleBox)
      ? raw.exampleBox.map((e: any) => ({ text: cleanText(e?.text) })).filter((e: any) => e.text)
      : undefined,
    solvedExample: raw?.solvedExample?.problem
      ? { problem: cleanText(raw.solvedExample.problem), solution: cleanText(raw.solvedExample.solution ?? '') }
      : undefined,
    mcq: Array.isArray(raw?.mcq)
      ? raw.mcq
          .map((m: any) => ({
            question: cleanText(m?.question),
            options: Array.isArray(m?.options) ? m.options.map(cleanText) : [],
            answerIndex: Number.isFinite(Number(m?.answerIndex)) ? Number(m.answerIndex) : 0,
          }))
          .filter((m: any) => m.question)
      : undefined,
    table:
      raw?.table && Array.isArray(raw.table.headers)
        ? { headers: raw.table.headers.map(cleanText), rows: Array.isArray(raw.table.rows) ? raw.table.rows.map((r: any) => (Array.isArray(r) ? r.map(cleanText) : [])) : [] }
        : undefined,
    speakerNotes: raw?.speakerNotes ? cleanText(raw.speakerNotes) : undefined,
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
    const messages = prompt.render({ brief, groundingNodes, feedback, context });
    // Generated content (teacher reads AI-authored prose) → quality model.
    // Preserve-wording/redesign slides reformat the page's own verbatim text —
    // mechanical work the fast model does in seconds instead of minutes.
    const isPreserve = !!brief.modeInstructions.preserveWordingCloseToSource;
    const chatOpts = {
      label: `${prompt.id}@${prompt.version}`,
      model: pickModel(isPreserve ? aiConfig.ppt.redesignSlideModel : aiConfig.ppt.slideModel),
      json: true,
      maxTokens: 4096, // room for the v3 per-layout content minimums
    };
    let res = await ai.chat(messages, chatOpts);
    let parsed = safeParse<any>(res.text);
    let retries = 0;
    let tokensIn = res.usage.promptTokens;
    let tokensOut = res.usage.completionTokens;
    let costUsd = estimateCostUSD(res.provider, res.usage);

    // ONE corrective retry before this slide degrades to the deterministic
    // fallback: an empty or malformed sample happens (observed live on
    // practice/mcq slides) and a single re-ask almost always fixes it. Echo
    // the broken output back only when there IS output to fix.
    if (parsed === undefined) {
      const fixMessages = res.text.trim()
        ? [
            ...messages,
            { role: 'assistant' as const, content: res.text.slice(0, 8000) },
            {
              role: 'user' as const,
              content:
                'Your previous reply was NOT valid JSON. Re-send the SAME slide as one complete, strictly valid JSON object — no markdown fences, no commentary, escape backslashes as \\\\ and inner quotes as \\".',
            },
          ]
        : messages; // empty response — just re-sample
      res = await ai.chat(fixMessages, chatOpts);
      parsed = safeParse<any>(res.text);
      retries = 1;
      tokensIn += res.usage.promptTokens;
      tokensOut += res.usage.completionTokens;
      costUsd += estimateCostUSD(res.provider, res.usage);
    }
    if (parsed === undefined) {
      throw new Error(`Slide generator returned unparseable JSON for "${brief.title}": ${res.text.slice(0, 150)}`);
    }

    return {
      output: coerceSlide(parsed, brief),
      metrics: {
        llmCalls: 1 + retries,
        tokensIn,
        tokensOut,
        costUsd,
        retries,
      },
      warnings: [],
    };
  },
};
