/**
 * The approval card's words (ADR-0228 §2.2.2). Every one comes from the
 * tool's declaration — its title, its description, its input schema's labels —
 * and the call's arguments. None comes from the model: the model chooses the
 * call, never how it is described to the person approving it.
 */
import type { ApprovalPreview, ApprovalPreviewArgument } from '@ouispec/agent-core';
import type { RegisteredTool } from '../tools/types.js';

interface PropertySchema {
  title?: string;
  oneOf?: Array<{ const?: unknown; title?: string }>;
}

/** The action's title and what it does, as its declaration states them. */
export function declaredTitle(tool: RegisteredTool): { title: string; consequence?: string } {
  const title = tool.title?.trim() || tool.name;
  const consequence = (tool.consequence ?? tool.description)?.trim();
  return consequence && consequence !== title ? { title, consequence } : { title };
}

export function buildApprovalPreview(tool: RegisteredTool, args: Record<string, unknown>): ApprovalPreview {
  const { title, consequence } = declaredTitle(tool);
  const properties = ((tool.inputSchema as { properties?: Record<string, PropertySchema> }).properties ?? {}) as Record<
    string,
    PropertySchema
  >;
  // The schema's order first, then anything else the call carries.
  const names = [...Object.keys(properties).filter((k) => k in args), ...Object.keys(args).filter((k) => !(k in properties))];
  const argumentsShown: ApprovalPreviewArgument[] = names
    .filter((name) => args[name] !== undefined)
    .map((name) => ({ name, label: properties[name]?.title?.trim() || name, value: valueText(args[name], properties[name]) }));

  const listed = argumentsShown.map((a) => `${a.label} ${a.value}`).join(', ');
  const readback = `${title}${listed ? `: ${listed}` : ''}.${consequence ? ` ${consequence}` : ''}`;
  return { title, ...(consequence ? { consequence } : {}), arguments: argumentsShown, readback };
}

function valueText(value: unknown, schema: PropertySchema | undefined): string {
  const named = schema?.oneOf?.find((o) => o.const === value && o.title);
  if (named?.title) return named.title;
  if (value === null) return 'none';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value) && value.every((v) => v === null || typeof v !== 'object')) return value.map((v) => String(v)).join(', ');
  return JSON.stringify(value);
}
