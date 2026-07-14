/**
 * Phase-2 stage — Blueprint Compilation (deterministic, no LLM). Expands the
 * APPROVED LectureBlueprint 1:1 into slide briefs. The blueprint is the
 * single source of truth: exactly `slideCount` briefs per section, in section
 * order, title slide first — nothing here (or downstream) re-decides lecture
 * flow, merges, drops, or adds anything the teacher didn't approve.
 *
 * Layout templates per section kind (fixed set — the LLM never picks layouts):
 *   objectives → objectives            practice → mcq_card (content_bullets
 *   concept    → inferred from its       when the section's question types
 *                grounding nodes         are written-answer styles)
 *   revision   → mcq_card              activity → example_box
 *   summary    → summary_card          homework → homework
 *
 * Section content controls (depth/examples/questions/difficulty/notes) ride
 * into generation on each brief's `sectionSpec`, with per-slide question
 * quotas computed here (e.g. 10 questions over 3 slides → 4/3/3).
 */
import type {
  KnowledgeNode,
  PipelineContext,
  SlideBrief,
  SlideLayoutType,
  TeachingKnowledgeGraph,
} from '../../aiOrchestrator/interfaces';
import type { BlueprintSection, LectureBlueprint } from './blueprint';

const WRITTEN_ANSWER_TYPES = ['short answer', 'long answer', 'fill in the blanks', 'numerical', 'case study'];

function layoutForSection(section: BlueprintSection, groundingNodes: KnowledgeNode[]): SlideLayoutType {
  switch (section.kind) {
    case 'objectives':
      return 'objectives';
    case 'practice':
    case 'revision': {
      const types = (section.questionTypes || []).map((t) => t.toLowerCase());
      const writtenOnly = types.length > 0 && types.every((t) => WRITTEN_ANSWER_TYPES.includes(t));
      return writtenOnly ? 'content_bullets' : 'mcq_card';
    }
    case 'activity':
      return 'example_box';
    case 'summary':
      return 'summary_card';
    case 'homework':
      return 'homework';
    case 'concept':
    default:
      return inferConceptLayout(groundingNodes);
  }
}

/** A homogeneous concept slide keeps its natural layout (all-definitions →
 * definition card, all-formulae → formula highlight, …); mixed → bullets. */
function inferConceptLayout(nodes: KnowledgeNode[]): SlideLayoutType {
  if (!nodes.length) return 'content_bullets';
  const types = new Set(nodes.map((n) => n.contentType));
  if (types.size !== 1) return 'content_bullets';
  switch (nodes[0].contentType) {
    case 'definition':
      return 'definition_card';
    case 'formula':
      return 'formula_highlight';
    case 'example':
      return 'example_box';
    case 'solved_example':
      return 'solved_example';
    case 'table':
      return 'table';
    default:
      return 'content_bullets';
  }
}

/** Split n items across k slots as evenly as possible (10,3 → [4,3,3]). */
export function distribute(n: number, k: number): number[] {
  const base = Math.floor(n / k);
  const extra = n % k;
  return Array.from({ length: k }, (_, i) => base + (i < extra ? 1 : 0));
}

/** Grounding nodes for slide i (1-based) of a section: contiguous share of
 * the section's nodes, so consecutive slides cover consecutive material. */
function nodesForSlide(nodeIds: string[], slideIdx: number, slideCount: number): string[] {
  if (!nodeIds.length) return [];
  if (slideCount === 1) return nodeIds;
  const per = distribute(nodeIds.length, slideCount);
  const start = per.slice(0, slideIdx - 1).reduce((a, b) => a + b, 0);
  return nodeIds.slice(start, start + per[slideIdx - 1]);
}

export function compileBlueprint(
  blueprint: LectureBlueprint,
  graph: TeachingKnowledgeGraph,
  ctx: PipelineContext,
): SlideBrief[] {
  const nodesById = new Map(graph.nodes.map((n) => [n.id, n]));
  const preserveWording = ctx.mode === 'redesign';

  const briefs: SlideBrief[] = [
    {
      slideIndex: 0,
      layoutType: 'title',
      title: blueprint.title,
      knowledgeNodeIds: [],
      modeInstructions: {
        preserveWordingCloseToSource: preserveWording,
        allowRewriteAndCondense: !preserveWording,
        extraTeacherInstruction: ctx.options.prompt,
      },
    },
  ];

  let slideIndex = 1;
  for (const section of blueprint.sections) {
    const validNodeIds = (section.knowledgeNodeIds || []).filter((id) => nodesById.has(id));
    const questionQuota =
      section.kind === 'practice' || section.kind === 'revision'
        ? distribute(section.questionCount || section.slideCount * 2, section.slideCount)
        : null;
    const exampleQuota =
      section.kind === 'concept' && section.exampleCount
        ? distribute(section.exampleCount, section.slideCount)
        : null;

    for (let pos = 1; pos <= section.slideCount; pos++) {
      const slideNodeIds = nodesForSlide(validNodeIds, pos, section.slideCount);
      const groundingNodes = slideNodeIds
        .map((id) => nodesById.get(id))
        .filter((n): n is KnowledgeNode => !!n);

      briefs.push({
        slideIndex: slideIndex++,
        layoutType: layoutForSection(section, groundingNodes),
        title: section.slideCount > 1 ? `${section.title} (${pos}/${section.slideCount})` : section.title,
        knowledgeNodeIds: slideNodeIds,
        sectionSpec: {
          sectionId: section.id,
          sectionTitle: section.title,
          kind: section.kind,
          positionInSection: pos,
          sectionSlideCount: section.slideCount,
          explanationDepth: section.explanationDepth,
          exampleTarget: exampleQuota ? exampleQuota[pos - 1] : undefined,
          questionTypes: section.questionTypes,
          difficulty: section.difficulty,
          questionTarget: questionQuota ? questionQuota[pos - 1] : undefined,
          activityDescription: section.activityDescription,
          notes: section.notes,
        },
        modeInstructions: {
          // Preserve-wording only makes sense when there IS source wording.
          preserveWordingCloseToSource: preserveWording && groundingNodes.length > 0,
          allowRewriteAndCondense: !(preserveWording && groundingNodes.length > 0),
          extraTeacherInstruction: ctx.options.prompt,
        },
      });
    }
  }

  // Prior/next titles for speaker-note transitions.
  briefs.forEach((brief, i) => {
    brief.priorSlideTitle = briefs[i - 1]?.title;
    brief.nextSlideTitle = briefs[i + 1]?.title;
  });

  return briefs;
}
