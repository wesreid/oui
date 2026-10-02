/**
 * Where a package declares its control table and its room catalog: under the
 * neutral `oui` key of its `package.json` (ADR-0226 §2.2 rule 4), or, during
 * the transition, under `closure`. The generator and the conformance kit both
 * read declarations through this, so they agree on which key wins.
 */

/** A declaration a package makes for the generator. */
export type AgentDeclarationKey = 'agentControls' | 'agentCatalog';

/** The keys read, the neutral one first. `closure` is read during the transition only. */
export const AGENT_DECLARATION_SCOPES = ['oui', 'closure'] as const;

export interface AgentDeclaration {
  /** The declared value, when there is one. */
  value?: unknown;
  /** Where it was found: `oui.agentControls` or `closure.agentControls`; empty when nowhere. */
  source: string;
  /** Why the declaration cannot be read: a package declaring both keys. */
  error?: string;
}

/**
 * A package's `oui.<key>`, or its `closure.<key>`. Declaring both is an error:
 * which one is read would otherwise be a guess.
 */
export function agentDeclaration(pkg: string, packageJson: Readonly<Record<string, unknown>>, key: AgentDeclarationKey): AgentDeclaration {
  const oui = (packageJson.oui as Record<string, unknown> | undefined)?.[key];
  const closure = (packageJson.closure as Record<string, unknown> | undefined)?.[key];
  if (oui !== undefined && closure !== undefined)
    return { source: '', error: `"${pkg}" declares both "oui.${key}" and "closure.${key}": keep "oui"` };
  if (oui !== undefined) return { value: oui, source: `oui.${key}` };
  if (closure !== undefined) return { value: closure, source: `closure.${key}` };
  return { source: '' };
}
