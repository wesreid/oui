/**
 * Recipes a room declares (`RoomCatalog.recipes`, ADR-0226 §2.6): tasks only
 * the room knows, written in its own words, whose references to its entries
 * become the tools that carry each step out. The generator infers no recipe
 * from what entries are called.
 */

import {
  isKeyframeable,
  ROOM_RUN_COMMAND_ID,
  ROOM_SET_PROPERTIES_ID,
  toolName,
  type KnowledgeRecipe,
  type RoomCatalogData,
  type RoomRecipe,
} from '@ouispec/bindings';

const REFERENCE = /\{(room|keyframeable|action:[^}]+|command:[^}]+|field:[^}]+)\}/g;

/** A room entry's tool name: `<room>_<entry>`. */
export const roomToolName = (room: string, entry: string) => toolName(`${room}.${entry}`);

/** A declared recipe with its references resolved, or what it names that the room does not have. */
export function resolveRecipe(
  catalog: RoomCatalogData,
  recipe: RoomRecipe,
): { recipe: KnowledgeRecipe; problems: string[] } {
  const problems: string[] = [];
  const has = (kind: 'action' | 'command' | 'field', id: string) =>
    kind === 'action'
      ? catalog.actions.some(a => a.id === id)
      : kind === 'command'
        ? catalog.commands.some(c => c.id === id && c.status === 'available')
        : catalog.fields.some(f => f.id === id);
  const missing = (kind: string, id: string) =>
    problems.push(`${catalog.room}’s recipe "${recipe.name}" names ${kind} ${id}, which the room does not have`);

  const resolve = (text: string) =>
    text.replace(REFERENCE, (_, ref: string) => {
      if (ref === 'room') return catalog.title;
      if (ref === 'keyframeable')
        return catalog.fields
          .filter(isKeyframeable)
          .map(f => f.id)
          .join(', ');
      const [kind, id] = [ref.slice(0, ref.indexOf(':')), ref.slice(ref.indexOf(':') + 1)] as [
        'action' | 'command' | 'field',
        string,
      ];
      if (!has(kind, id)) {
        missing(kind === 'command' ? 'available command' : kind, id);
        return ref;
      }
      if (kind === 'action') return roomToolName(catalog.room, id);
      if (kind === 'command') return `${roomToolName(catalog.room, ROOM_RUN_COMMAND_ID)} ${id}`;
      return `${roomToolName(catalog.room, ROOM_SET_PROPERTIES_ID)} ${id}`;
    });

  return {
    recipe: { name: resolve(recipe.name), trigger: resolve(recipe.trigger), steps: recipe.steps.map(resolve) },
    problems,
  };
}

/** Every declared recipe's problems. */
export function recipeProblems(catalog: RoomCatalogData): string[] {
  return (catalog.recipes ?? []).flatMap(r => resolveRecipe(catalog, r).problems);
}
