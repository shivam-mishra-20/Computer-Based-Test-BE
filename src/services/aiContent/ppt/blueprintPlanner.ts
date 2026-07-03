/**
 * Phase-1 stage — AI Lecture Planner. Proposes the editable LectureBlueprint
 * the teacher reviews/edits/approves before any slide is generated.
 *
 * Three proposal paths, in priority order:
 *   1. TEMPLATE (options.blueprintTemplateId): the saved template's section
 *      structure is reused as-is; concept-section topics are filled from the
 *      extracted content in order. No LLM call.
 *   2. GENERATIVE modes (smart_generator / hybrid): one generation-model call
 *      plans the lecture the way a teacher would — concept → practice on it →
 *      next concept → quiz → revision → homework — grounded on the topics the
 *      knowledge graph actually contains. Deterministic fallback on failure.
 *   3. PRESERVATION modes (modernizer / teacher_enhancement): fully
 *      deterministic derivation in source order (their whole promise is that
 *      AI never re-decides the teacher's flow) — the teacher can still edit.
 *
 * The proposal is ALWAYS passed through coerceBlueprint before leaving this
 * stage, so downstream code (and the client) only ever sees a valid plan.
 */
import { ai, estimateCostUSD, pickModel, promptRegistry, safeParse } from '../../../ai';
import BlueprintTemplate from '../../../models/BlueprintTemplate';
import { emptyMetrics } from '../../aiOrchestrator/interfaces';
import type {
  KnowledgeChunk,
  KnowledgeNode,
  PipelineContext,
  ResolvedIntent,
  StageResult,
  TeachingKnowledgeGraph,
} from '../../aiOrchestrator/interfaces';
import {
  coerceBlueprint,
  newSectionId,
  sectionKindOf,
  type BlueprintSection,
  type LectureBlueprint,
  type SectionKind,
} from './blueprint';

interface TopicGroup {
  topic: string;
  nodeIds: string[];
  kinds: Set<SectionKind>;
}

/** Group flow-ordered chunks into per-topic buckets, preserving order. */
function topicGroups(chunks: KnowledgeChunk[], nodesById: Map<string, KnowledgeNode>): TopicGroup[] {
  const groups: TopicGroup[] = [];
  const byTopic = new Map<string, TopicGroup>();
  for (const chunk of chunks) {
    let g = byTopic.get(chunk.topic);
    if (!g) {
      g = { topic: chunk.topic, nodeIds: [], kinds: new Set() };
      byTopic.set(chunk.topic, g);
      groups.push(g);
    }
    for (const id of chunk.nodeIds) {
      g.nodeIds.push(id);
      const node = nodesById.get(id);
      if (node) g.kinds.add(sectionKindOf(node.contentType));
    }
  }
  return groups;
}

/** Nodes of a topic group that belong to one section kind. */
function nodeIdsOfKind(
  g: TopicGroup,
  kind: SectionKind,
  nodesById: Map<string, KnowledgeNode>,
): string[] {
  return g.nodeIds.filter((id) => {
    const n = nodesById.get(id);
    return n ? sectionKindOf(n.contentType) === kind : false;
  });
}

/** Deterministic proposal straight from the content, in content order —
 * the preservation-mode path and the fallback for everything else. */
function deriveBlueprintFromContent(
  graph: TeachingKnowledgeGraph,
  chunks: KnowledgeChunk[],
  intent: ResolvedIntent,
): LectureBlueprint {
  const nodesById = new Map(graph.nodes.map((n) => [n.id, n]));
  const groups = topicGroups(chunks, nodesById);
  const sections: BlueprintSection[] = [];

  // Objectives first when the content has them.
  const objectiveIds = graph.nodes.filter((n) => n.contentType === 'objectives').map((n) => n.id);
  if (objectiveIds.length) {
    sections.push({
      id: newSectionId(),
      kind: 'objectives',
      title: 'Learning Objectives',
      slideCount: 1,
      knowledgeNodeIds: objectiveIds,
    });
  }

  for (const g of groups) {
    const conceptIds = g.nodeIds.filter((id) => {
      const n = nodesById.get(id);
      return n ? !['objectives', 'mcq', 'summary', 'homework'].includes(n.contentType) : false;
    });
    if (conceptIds.length) {
      sections.push({
        id: newSectionId(),
        kind: 'concept',
        title: g.topic,
        slideCount: Math.min(Math.max(Math.ceil(conceptIds.length / 2), 1), 4),
        explanationDepth: 'standard',
        exampleCount: Math.min(
          conceptIds.filter((id) => {
            const n = nodesById.get(id);
            return n?.contentType === 'example' || n?.contentType === 'solved_example';
          }).length || 1,
          3,
        ),
        knowledgeNodeIds: conceptIds,
      });
    }
    const mcqIds = nodeIdsOfKind(g, 'practice', nodesById);
    if (mcqIds.length) {
      const questionCount = mcqIds.reduce(
        (sum, id) => sum + (nodesById.get(id)?.mcqs?.length || 1),
        0,
      );
      sections.push({
        id: newSectionId(),
        kind: 'practice',
        title: `Practice: ${g.topic}`,
        slideCount: Math.min(Math.max(Math.ceil(questionCount / 3), 1), 3),
        questionTypes: ['MCQ'],
        difficulty: 'mixed',
        questionCount: Math.min(questionCount, 20),
        knowledgeNodeIds: mcqIds,
      });
    }
  }

  const summaryIds = graph.nodes.filter((n) => n.contentType === 'summary').map((n) => n.id);
  sections.push({
    id: newSectionId(),
    kind: 'revision',
    title: 'Quick Revision',
    slideCount: 1,
    questionTypes: ['MCQ'],
    difficulty: 'mixed',
    questionCount: 3,
  });
  sections.push({
    id: newSectionId(),
    kind: 'summary',
    title: 'Summary',
    slideCount: 1,
    knowledgeNodeIds: summaryIds.length ? summaryIds : undefined,
  });
  const homeworkIds = graph.nodes.filter((n) => n.contentType === 'homework').map((n) => n.id);
  sections.push({
    id: newSectionId(),
    kind: 'homework',
    title: 'Homework',
    slideCount: 1,
    knowledgeNodeIds: homeworkIds.length ? homeworkIds : undefined,
  });

  return coerceBlueprint({
    version: 1,
    title: graph.deckTitle || intent.chapter || intent.subject || 'Lecture',
    subject: graph.subject ?? intent.subject,
    className: graph.className ?? intent.className,
    chapter: graph.chapter ?? intent.chapter,
    language: graph.language ?? intent.language,
    teachingStyle: intent.teachingStyle,
    sections,
  });
}

// ── AI planner (generative modes) ────────────────────────────────────────────

promptRegistry.register({
  id: 'ppt.blueprintPlan',
  version: 'v1',
  task: 'generation',
  description: 'Plans a lecture as a teacher would — ordered sections (concept → practice → … → homework) over the topics the knowledge graph contains. Output is the editable Lecture Blueprint proposal.',
  render: (params: {
    topics: { index: number; topic: string; hasQuestions: boolean }[];
    intent: ResolvedIntent;
    extraInstruction?: string;
  }) => [
    {
      role: 'system',
      content: `You are an experienced teacher planning a classroom lecture. You think in teaching flow — teach a concept, let students practice it, move to the next concept, quiz, revise, assign homework — never in raw slide counts.
You ALWAYS respond with a single valid JSON object and nothing else.`,
    },
    {
      role: 'user',
      content: [
        `Plan a lecture over these topics (numbered) targeting roughly ${params.intent.targetSlideCount} slides total:`,
        ...params.topics.map((t) => `${t.index}. ${t.topic}${t.hasQuestions ? ' (has practice questions available)' : ''}`),
        '',
        `Respond with EXACTLY this JSON shape:`,
        `{`,
        `  "sections": [`,
        `    {`,
        `      "kind": "objectives" | "concept" | "practice" | "revision" | "activity" | "summary" | "homework",`,
        `      "title": string,                    // topic name / section label the teacher will see`,
        `      "slideCount": number,               // 1-10`,
        `      "topicRefs": number[],              // indices of the topics above this section covers ([] for generic sections)`,
        `      "explanationDepth": "brief"|"standard"|"in_depth",   // concept sections only`,
        `      "exampleCount": number,             // concept sections only, 0-5`,
        `      "questionTypes": ["MCQ"|"Short Answer"|...],          // practice/revision only`,
        `      "difficulty": "easy"|"medium"|"hard"|"mixed",         // practice/revision only`,
        `      "questionCount": number             // practice/revision only, 1-20`,
        `    }`,
        `  ]`,
        `}`,
        '',
        `Rules:`,
        `- Follow real teaching flow: objectives first, then alternate concept sections with practice on what was just taught, and end with revision, summary, homework.`,
        `- Cover EVERY topic listed at least once; do not invent topics that are not listed.`,
        `- Prefer a practice section after each major concept when questions are available.`,
        params.intent.teachingStyle ? `- Teaching style: ${params.intent.teachingStyle}.` : '',
        params.intent.className ? `- Class/Grade: ${params.intent.className}.` : '',
        params.extraInstruction ? `- Teacher's note: ${params.extraInstruction}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    },
  ],
});

async function aiPlanBlueprint(
  graph: TeachingKnowledgeGraph,
  chunks: KnowledgeChunk[],
  intent: ResolvedIntent,
  ctx: PipelineContext,
): Promise<{ blueprint: LectureBlueprint; metrics: StageResult<unknown>['metrics'] } | null> {
  const nodesById = new Map(graph.nodes.map((n) => [n.id, n]));
  const groups = topicGroups(chunks, nodesById);
  if (!groups.length) return null;

  const topics = groups.map((g, i) => ({
    index: i,
    topic: g.topic,
    hasQuestions: nodeIdsOfKind(g, 'practice', nodesById).length > 0,
  }));

  const template = promptRegistry.get<any>('ppt.blueprintPlan');
  const res = await ai.chat(
    template.render({ topics, intent, extraInstruction: ctx.options.prompt }),
    { label: `${template.id}@${template.version}`, model: pickModel(template.task), json: true, maxTokens: 4096 },
  );
  const parsed = safeParse<{ sections?: any[] }>(res.text);
  const rawSections = Array.isArray(parsed?.sections) ? parsed!.sections! : [];
  if (!rawSections.length) return null;

  const sections = rawSections.map((raw) => {
    // Resolve topicRefs → grounding node ids (kind-filtered so a practice
    // section grounds on the topic's questions, a concept section on its
    // teaching content).
    const refs: number[] = Array.isArray(raw?.topicRefs)
      ? raw.topicRefs.map(Number).filter((n: number) => Number.isFinite(n) && groups[n])
      : [];
    const kind: SectionKind = raw?.kind === 'practice' || raw?.kind === 'revision' ? raw.kind : raw?.kind;
    const knowledgeNodeIds = refs.flatMap((r) => {
      const g = groups[r];
      if (kind === 'practice') {
        const q = nodeIdsOfKind(g, 'practice', nodesById);
        return q.length ? q : g.nodeIds;
      }
      return g.nodeIds.filter((id) => {
        const n = nodesById.get(id);
        return n ? !['mcq'].includes(n.contentType) : false;
      });
    });
    return { ...raw, knowledgeNodeIds };
  });

  const blueprint = coerceBlueprint({
    version: 1,
    title: graph.deckTitle || intent.chapter || intent.subject || 'Lecture',
    subject: graph.subject ?? intent.subject,
    className: graph.className ?? intent.className,
    chapter: graph.chapter ?? intent.chapter,
    language: graph.language ?? intent.language,
    teachingStyle: intent.teachingStyle,
    sections,
  });

  return {
    blueprint,
    metrics: {
      llmCalls: 1,
      tokensIn: res.usage.promptTokens,
      tokensOut: res.usage.completionTokens,
      costUsd: estimateCostUSD(res.provider, res.usage),
      retries: 0,
    },
  };
}

/** Fill a saved template's structure with this lecture's actual topics. */
function applyTemplate(
  templateBlueprint: any,
  graph: TeachingKnowledgeGraph,
  chunks: KnowledgeChunk[],
  intent: ResolvedIntent,
): LectureBlueprint {
  const nodesById = new Map(graph.nodes.map((n) => [n.id, n]));
  const groups = topicGroups(chunks, nodesById);
  let conceptIdx = 0;

  const sectionsRaw = Array.isArray(templateBlueprint?.sections) ? templateBlueprint.sections : [];
  const sections = sectionsRaw.map((raw: any) => {
    const out = { ...raw, id: newSectionId(), knowledgeNodeIds: undefined as string[] | undefined };
    if (raw?.kind === 'concept' && groups.length) {
      const g = groups[conceptIdx % groups.length];
      conceptIdx++;
      out.title = g.topic; // template structure, THIS lecture's topic
      out.knowledgeNodeIds = g.nodeIds.filter((id) => nodesById.get(id)?.contentType !== 'mcq');
    }
    if (raw?.kind === 'practice' && groups.length) {
      const g = groups[Math.max(0, (conceptIdx - 1) % groups.length)];
      const q = nodeIdsOfKind(g, 'practice', nodesById);
      if (q.length) out.knowledgeNodeIds = q;
    }
    return out;
  });

  return coerceBlueprint({
    ...templateBlueprint,
    version: 1,
    title: graph.deckTitle || intent.chapter || intent.subject || 'Lecture',
    subject: graph.subject ?? intent.subject,
    className: graph.className ?? intent.className,
    chapter: graph.chapter ?? intent.chapter,
    language: graph.language ?? intent.language,
    teachingStyle: intent.teachingStyle,
    sections,
  });
}

export async function planBlueprint(
  graph: TeachingKnowledgeGraph,
  chunks: KnowledgeChunk[],
  intent: ResolvedIntent,
  ctx: PipelineContext,
): Promise<StageResult<LectureBlueprint>> {
  // 1. Saved template wins — the teacher explicitly chose a structure.
  const templateId = (ctx.options as any).blueprintTemplateId;
  if (templateId) {
    try {
      const tpl = await BlueprintTemplate.findOne({ _id: templateId, ownerId: ctx.ownerId }).lean();
      if (tpl) {
        return {
          output: applyTemplate(tpl.blueprint, graph, chunks, intent),
          metrics: emptyMetrics(),
          warnings: [],
        };
      }
    } catch {
      /* fall through to normal planning */
    }
  }

  // 2. Generative modes: real AI lecture planning, deterministic fallback.
  if (ctx.mode === 'smart_generator' || ctx.mode === 'hybrid') {
    try {
      const planned = await aiPlanBlueprint(graph, chunks, intent, ctx);
      if (planned) return { output: planned.blueprint, metrics: planned.metrics, warnings: [] };
    } catch (err: any) {
      return {
        output: deriveBlueprintFromContent(graph, chunks, intent),
        metrics: emptyMetrics(),
        warnings: [`AI lecture planning fell back to a content-derived plan: ${err?.message || 'unknown error'}`],
      };
    }
    return {
      output: deriveBlueprintFromContent(graph, chunks, intent),
      metrics: emptyMetrics(),
      warnings: ['AI lecture planning returned nothing usable — proposed a content-derived plan instead.'],
    };
  }

  // 3. Preservation modes: content order IS the plan.
  return { output: deriveBlueprintFromContent(graph, chunks, intent), metrics: emptyMetrics(), warnings: [] };
}
