/**
 * What Mantine and Radix read from a browser that jsdom does not have:
 * `matchMedia` (Mantine's colour scheme and reduced motion), `ResizeObserver`
 * (Radix's and Mantine's measured popovers) and `scrollIntoView`.
 */
if (!window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

if (!('ResizeObserver' in window)) {
  (window as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

/**
 * jsdom has no top layer, so nothing in it is `:modal` or `:popover-open`.
 * floating-ui asks each ancestor of a positioned popover (Mantine's Select,
 * Radix's Select) whether it is, and jsdom's selector engine answers `:modal`
 * by recursing through every ancestor's `:fullscreen` — seconds per popover.
 * The answer is always false here, so it is given directly.
 */
const TOP_LAYER = new Set([':modal', ':popover-open']);
const matches = Element.prototype.matches;
Element.prototype.matches = function (this: Element, selectors: string) {
  return TOP_LAYER.has(selectors.trim()) ? false : matches.call(this, selectors);
};
