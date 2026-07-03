/**
 * Central registry every pipeline-stage prompt is registered against, so each
 * prompt has a stable id + version that shows up in `logAICall`'s `label` and
 * in `TeachingKnowledgeGraph.metadata.extractionPromptId/Version` — an edit to
 * prompt text is only "safe" if it also bumps the version, otherwise cached
 * knowledge graphs and audit logs silently point at the wrong prompt.
 *
 * Legacy prompts (pptGenerator.ts, paperGenerator.ts) are NOT required to
 * migrate onto this — they keep building prompt text inline, unchanged. This
 * registry is for the new multi-stage pipeline only.
 */
import type { ChatMessage } from '../types';

export type PromptTask = 'generation' | 'vision' | 'fast';

export interface PromptTemplate<TParams = Record<string, any>> {
  id: string;
  version: string;
  task: PromptTask;
  description: string;
  render(params: TParams): ChatMessage[];
}

class PromptRegistryImpl {
  /** id -> version -> template */
  private templates = new Map<string, Map<string, PromptTemplate<any>>>();
  /** id -> version considered "active"/latest when none is specified. */
  private latest = new Map<string, string>();

  register<TParams>(template: PromptTemplate<TParams>): void {
    if (!template.id || !template.version) {
      throw new Error('PromptTemplate requires both id and version');
    }
    let versions = this.templates.get(template.id);
    if (!versions) {
      versions = new Map();
      this.templates.set(template.id, versions);
    }
    versions.set(template.version, template);
    // Last registration for an id wins as "latest" — module load order is
    // deterministic (newest version file registered last by convention).
    this.latest.set(template.id, template.version);
  }

  get<TParams = Record<string, any>>(id: string, version?: string): PromptTemplate<TParams> {
    const versions = this.templates.get(id);
    if (!versions) {
      throw new Error(`No prompt template registered for id "${id}"`);
    }
    const resolvedVersion = version ?? this.latest.get(id);
    const template = resolvedVersion ? versions.get(resolvedVersion) : undefined;
    if (!template) {
      throw new Error(`Prompt template "${id}" has no version "${resolvedVersion}"`);
    }
    return template as PromptTemplate<TParams>;
  }

  listVersions(id: string): string[] {
    return Array.from(this.templates.get(id)?.keys() ?? []);
  }

  /** Descriptor-only registration for prompts not yet routed through render() —
   * e.g. legacy prompts kept inline in pptGenerator.ts/paperGenerator.ts. Gives
   * them a stable id/version for labeling and future migration, without
   * requiring the caller to actually build messages through this registry. */
  registerDescriptor(id: string, version: string, task: PromptTask, description: string): void {
    this.register({
      id,
      version,
      task,
      description,
      render: () => {
        throw new Error(
          `Prompt "${id}@${version}" is a descriptor-only registration (legacy prompt) — it is not renderable through the registry.`,
        );
      },
    });
  }
}

export const promptRegistry = new PromptRegistryImpl();
