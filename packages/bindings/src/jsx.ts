/**
 * `agent` on JSX, for an app with tier 2 bound modules (ADR-0226 §2.3). A
 * bound export keeps the third-party component's own type, generics and
 * polymorphism included, so `agent` cannot be one of its props; every bound
 * module imports this entry instead, the way a styling library adds `css`.
 * Only apps with a bound module import it. The generator holds every `agent`
 * to the control it is on.
 */
import type { AgentAttribute } from './tier2-react.js';

declare module 'react' {
  // React declares JSX as a namespace; augmenting it is the only way to add an attribute.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicAttributes {
      /** The assistant's binding of a bound control (ADR-0226 §2.3). */
      agent?: AgentAttribute;
    }
  }
}

export {};
