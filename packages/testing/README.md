# @ouispec/testing

The OUI conformance kit (ADR-0226 §3.2). It runs in the integrator's own test runner, in any DOM environment, and checks a product against the published contract (`@ouispec/contract`):

- `checkDesignSystem` — a tier 1 design system: its table and declaration match the schemas, every entry registers with its declared kind, every export that takes a callback is accounted for, and every binding's `run` returns its callback's result (a job's `pending.jobId` too).
- `checkApp` — every action of a generated manifest has a handler mounted on the page that offers it.
- `checkTier2` — every tier 2 wrapper forwards `valueFrom` correctly, and every uncontrolled use is reported.

`assertConformant(report)` throws with every violation, by rule. See the integrator guide's "The conformance kit" section for a worked example.
