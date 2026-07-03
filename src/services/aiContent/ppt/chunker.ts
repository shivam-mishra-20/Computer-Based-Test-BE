/**
 * Stage 6 — Semantic Chunking (internal, deterministic). Structural, not
 * vector-based, per the confirmed architecture decision: groups graph nodes
 * by their shared `topic` (the boundary Knowledge Extraction already
 * established), splitting an oversized topic group into multiple chunks so
 * no chunk exceeds ~1200 chars — the same size-based chunking philosophy
 * already used elsewhere in this codebase (e.g. enhancedPdfQuestionExtractor).
 * Node order within the graph is preserved; this stage never reorders.
 */
import type { KnowledgeChunk, KnowledgeNode, TeachingKnowledgeGraph } from '../../aiOrchestrator/interfaces';

export type { KnowledgeChunk };

const MAX_CHUNK_CHARS = 1200;

function nodeTextLength(node: KnowledgeNode): number {
  const parts = [
    node.title,
    ...(node.explanations || []),
    ...(node.definitions?.map((d) => `${d.term} ${d.definition}`) || []),
    ...(node.examples || []),
    ...(node.solvedExamples?.map((s) => `${s.problem} ${s.solution}`) || []),
    ...(node.mcqs?.map((m) => m.question) || []),
  ];
  return parts.filter(Boolean).join(' ').length;
}

export function chunkKnowledgeGraph(graph: TeachingKnowledgeGraph): KnowledgeChunk[] {
  const chunks: KnowledgeChunk[] = [];
  let order = 0;

  // Group by topic, preserving first-seen order.
  const topicOrder: string[] = [];
  const nodesByTopic = new Map<string, KnowledgeNode[]>();
  for (const node of graph.nodes) {
    if (!nodesByTopic.has(node.topic)) {
      nodesByTopic.set(node.topic, []);
      topicOrder.push(node.topic);
    }
    nodesByTopic.get(node.topic)!.push(node);
  }

  for (const topic of topicOrder) {
    const nodes = nodesByTopic.get(topic)!;
    let current: KnowledgeNode[] = [];
    let currentChars = 0;

    const flush = () => {
      if (!current.length) return;
      chunks.push({
        chunkId: `chunk-${order}`,
        topic,
        nodeIds: current.map((n) => n.id),
        order: order++,
      });
      current = [];
      currentChars = 0;
    };

    for (const node of nodes) {
      const len = nodeTextLength(node);
      if (current.length && currentChars + len > MAX_CHUNK_CHARS) flush();
      current.push(node);
      currentChars += len;
    }
    flush();
  }

  return chunks;
}
