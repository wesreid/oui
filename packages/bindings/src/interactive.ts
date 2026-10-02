/**
 * What makes something a person can use, for the generator's reading of a
 * page and the conformance kit's reading of a design system's exports: one
 * definition, so the two never disagree on what must be bound.
 */

/** Elements someone can use by their nature. */
export const INTERACTIVE_TAGS: ReadonlySet<string> = new Set(['button', 'input', 'select', 'textarea']);

/** Handlers that make an element someone can use: a press, an edit, a key, a pointer. */
export const INTERACTIVE_HANDLERS: readonly string[] = [
  'onClick',
  'onChange',
  'onInput',
  'onSubmit',
  'onDoubleClick',
  'onPointerDown',
  'onMouseDown',
  'onKeyDown',
];

/** A prop that takes a callback, by React's naming: `onValueChange`, `onDragEnd`. */
export const CALLBACK_PROP = /^on[A-Z]/;
