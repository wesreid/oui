# OUI integrator guide

**For:** engineers plugging a React product into the OUI agent platform, so its assistant can do everything the product's UI lets a person do, through the same code paths the person uses.
**Specified by:** ADR-0226 (the integrator contract), ADR-0227 (the reference architecture) and ADR-0228 (approvals). This guide replaces ADR-0139's dispatch mechanics, which no longer describe how the platform works.

## How it fits together

The assistant never gets a hand-written list of what it can do. A build step, `oui generate`, reads the app's own code — its routes, the controls each page renders, the room catalogs of its editors and its API's OpenAPI document — and writes two files: a **manifest** of every action and observation the UI offers, and **knowledge** describing them. At run time each control registers its real handler while it is mounted, and the tab offers the assistant exactly the actions the manifest declares *and* the page has on screen. The assistant and the person go through one code path.

A product plugs its UI in through one or more of three tiers, combinable in one app:

| Tier | When | The product provides | Section |
|---|---|---|---|
| 1. Native design system | It owns its design system | `agent` props, `useAgentBinding` calls, a control table | [Tier 1](#tier-1-a-design-system-you-own) |
| 2. Third-party design system | It uses one it does not own (MUI, Mantine, shadcn/Radix) | A mapping file; the generator emits bound wrappers | [Tier 2](#tier-2-a-design-system-you-do-not-own) |
| 3. Rooms | Custom editors: canvases, charts, timelines, players | A room catalog of actions, fields, commands and observations | [Tier 3](#tier-3-rooms) |

## The packages

| Package | What it is |
|---|---|
| `@ouispec/contract` | The JSON Schemas below, the TypeScript types generated from them, a validator (`/validate`), and this guide. |
| `@ouispec/bindings` | The binding (`useAgentBinding`, `useRoomRegistration` from `/react`), the registry, and `connectBindings` (from `/oui`), which turns what is mounted into the tab's OUI surfaces. |
| `@ouispec/cli` | The `oui generate [--check]` CLI (also installed as `closure-oui`). |
| `@ouispec/testing` | The conformance kit. |
| `oui-spec` | The OUI surface runtime, protocol and approval rules every package above builds on. |

They are published to the public npm registry from the open [`oui` repository](https://github.com/wesreid/oui), by its CI, with provenance. The schema URLs below are the same as before the packages were public.

## Versions

Every schema of the contract is versioned together by `MANIFEST_VERSION`, and that major is in each schema's `$id` (`…/oui/v1/…`). A breaking change to any schema bumps it. Pin the contract major, and run the conformance kit in CI: it is the compatibility gate. The packages stay below 1.0 until the first outside product is live.

## The schemas

<!-- schemas -->

Validate any of these files in a build step with `contractProblems(ref, value)` from `@ouispec/contract/validate`, where `ref` is a file name (`control-table.json`) or a generated type's name (`ControlDescriptor`). The generator already validates every control table, room catalog, `oui.config.json`, manifest and knowledge it reads or writes, and fails the build on any problem.
