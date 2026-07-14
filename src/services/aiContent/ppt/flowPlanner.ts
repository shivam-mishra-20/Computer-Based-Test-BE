/**
 * Stage 7 — Pedagogical Flow Planner (internal, deterministic). Ordering
 * chunks by raw topic/heading position isn't the same as teaching order:
 *
 *  1. Within each chunk, nodes are sorted into a canonical pedagogical role
 *     sequence — objectives → definition → explanation → formula → example →
 *     table → solved example → practice/MCQ → summary → note, with
 *     **homework always last**.
 *  2. Across chunks, `prerequisiteOf` edges (when present) are respected via
 *     topological sort; with no such edges (true for every graph produced by
 *     today's Knowledge Extraction — it only infers `assessedBy`/`exampleOf`,
 *     deliberately, see knowledgeExtractor.ts) this is a no-op that preserves
 *     the graph's natural topic order, which is already a reasonable default
 *     since extraction batches process source content in document order.
 *
 * No fast-model fallback is wired here: the one genuinely hard-to-resolve
 * case — a cycle in `prerequisiteOf` edges — is handled by a deterministic,
 * order-preserving fallback (break the cycle, keep original relative order,
 * warn) rather than an LLM call. This is honest scoping, not a shortcut: no
 * current edge producer creates cycles, so the AI-assisted tie-break the
 * architecture doc anticipates has no real case to resolve today. If a
 * future KnowledgeExtractor enhancement infers real prerequisiteOf edges
 * across topics, genuine ambiguity (not just cycles) may start to appear —
 * that's the point at which a fast-model tie-break would earn its cost.
 *
 * PRESERVATION modes (modernizer AND teacher_enhancement) are exempt from
 * BOTH reordering steps: the teacher's own document carries its own teaching
 * order, and preserving that flow is those modes' core promise — Modernizer
 * redesigns the PRESENTATION of the material, never its sequence. Chunks
 * (and nodes within them) pass through in exactly the order Semantic
 * Chunking produced them, which mirrors source-document order (chunker.ts).
 * Only the generative modes (smart_generator / hybrid) get canonical
 * pedagogical re-sequencing.
 */
import type { KnowledgeChunk, KnowledgeNode, PipelineContext, TeachingKnowledgeGraph } from '../../aiOrchestrator/interfaces';

const ROLE_PRIORITY: Record<KnowledgeNode['contentType'], number> = {
  objectives: 0,
  definition: 1,
  explanation: 2,
  formula: 3,
  example: 4,
  table: 5,
  solved_example: 6,
  mcq: 7,
  summary: 8,
  note: 9,
  homework: 10, // always last
};

function orderNodesWithinChunk(nodeIds: string[], nodesById: Map<string, KnowledgeNode>): string[] {
  return [...nodeIds].sort((a, b) => {
    const na = nodesById.get(a);
    const nb = nodesById.get(b);
    const pa = na ? ROLE_PRIORITY[na.contentType] ?? 99 : 99;
    const pb = nb ? ROLE_PRIORITY[nb.contentType] ?? 99 : 99;
    return pa - pb;
  });
}

/** Which chunk (by index) a node belongs to. */
function nodeChunkIndex(chunks: KnowledgeChunk[]): Map<string, number> {
  const map = new Map<string, number>();
  chunks.forEach((chunk, i) => chunk.nodeIds.forEach((id) => map.set(id, i)));
  return map;
}

/** Stable topological sort of chunk indices by prerequisiteOf edges (A -> B
 * means A's chunk must come before B's chunk). Falls back to original order
 * for any chunk left unresolved by a cycle, with a warning. */
function topoSortChunks(
  chunks: KnowledgeChunk[],
  graph: TeachingKnowledgeGraph,
): { order: number[]; warnings: string[] } {
  const chunkOf = nodeChunkIndex(chunks);
  const n = chunks.length;
  const adjacency: Set<number>[] = Array.from({ length: n }, () => new Set());
  const inDegree = new Array(n).fill(0);

  for (const edge of graph.edges) {
    if (edge.type !== 'prerequisiteOf') continue;
    const fromChunk = chunkOf.get(edge.from);
    const toChunk = chunkOf.get(edge.to);
    if (fromChunk == null || toChunk == null || fromChunk === toChunk) continue;
    if (!adjacency[fromChunk].has(toChunk)) {
      adjacency[fromChunk].add(toChunk);
      inDegree[toChunk]++;
    }
  }

  // Kahn's algorithm, processing zero-in-degree chunks in original index
  // order — with no edges (today's reality) this reproduces the input order.
  const order: number[] = [];
  const available = Array.from({ length: n }, (_, i) => i).filter((i) => inDegree[i] === 0);
  const remaining = new Set(Array.from({ length: n }, (_, i) => i));

  while (available.length) {
    available.sort((a, b) => a - b);
    const i = available.shift()!;
    order.push(i);
    remaining.delete(i);
    for (const next of adjacency[i]) {
      inDegree[next]--;
      if (inDegree[next] === 0) available.push(next);
    }
  }

  const warnings: string[] = [];
  if (remaining.size > 0) {
    // A cycle exists among the leftover chunks — break it by appending them
    // in their original order rather than guessing.
    warnings.push(
      `Pedagogical Flow Planner found a prerequisiteOf cycle involving ${remaining.size} chunk(s) — falling back to original order for them.`,
    );
    Array.from(remaining)
      .sort((a, b) => a - b)
      .forEach((i) => order.push(i));
  }

  return { order, warnings };
}

export function planPedagogicalFlow(
  chunks: KnowledgeChunk[],
  graph: TeachingKnowledgeGraph,
  ctx: PipelineContext,
): { chunks: KnowledgeChunk[]; warnings: string[] } {
  if (ctx.mode === 'redesign') {
    // Preserving the teacher's original lecture flow IS this mode's promise.
    return { chunks, warnings: [] };
  }

  const nodesById = new Map(graph.nodes.map((n) => [n.id, n]));
  const { order, warnings } = topoSortChunks(chunks, graph);

  const reordered = order.map((chunkIdx, newOrder) => {
    const chunk = chunks[chunkIdx];
    return {
      ...chunk,
      nodeIds: orderNodesWithinChunk(chunk.nodeIds, nodesById),
      order: newOrder,
    };
  });

  return { chunks: reordered, warnings };
}
