// GENERATED FILE — DO NOT EDIT.
//
// Generated from schemas/*.json, the OUI integrator contract, by @ouispec/contract.
// Edit the schemas, then: pnpm generate (in packages/contract).

import type { ContractSchemaDocument } from '../schema-document.js';

/** Every schema of the contract, by file name, exactly as `schemas/` holds it. */
export const CONTRACT_SCHEMAS = {
  'json-schema.json': {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://schemas.closurestudio.ai/oui/v1/json-schema.json",
    "title": "JsonSchema",
    "description": "The subset of JSON Schema (draft 2020-12) every capability declares its input and values in. It is what assistant tool inputs are written in, so a declared or derived schema is used as is. `x-unit` names the unit a number is in: `px`, `%`, `°`.",
    "type": "object",
    "properties": {
      "type": {
        "anyOf": [
          {
            "$ref": "#/$defs/JsonSchemaType"
          },
          {
            "type": "array",
            "items": {
              "$ref": "#/$defs/JsonSchemaType"
            }
          }
        ]
      },
      "description": {
        "type": "string"
      },
      "enum": {
        "type": "array",
        "items": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "number"
            },
            {
              "type": "boolean"
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "const": {
        "anyOf": [
          {
            "type": "string"
          },
          {
            "type": "number"
          },
          {
            "type": "boolean"
          },
          {
            "type": "null"
          }
        ]
      },
      "properties": {
        "type": "object",
        "additionalProperties": {
          "$ref": "#"
        }
      },
      "required": {
        "type": "array",
        "items": {
          "type": "string"
        }
      },
      "additionalProperties": {
        "anyOf": [
          {
            "type": "boolean"
          },
          {
            "$ref": "#"
          }
        ]
      },
      "items": {
        "$ref": "#"
      },
      "minItems": {
        "type": "number"
      },
      "maxItems": {
        "type": "number"
      },
      "uniqueItems": {
        "description": "No two items are the same.",
        "type": "boolean"
      },
      "minimum": {
        "type": "number"
      },
      "maximum": {
        "type": "number"
      },
      "multipleOf": {
        "type": "number"
      },
      "minLength": {
        "type": "number"
      },
      "maxLength": {
        "type": "number"
      },
      "pattern": {
        "type": "string"
      },
      "format": {
        "type": "string"
      },
      "oneOf": {
        "type": "array",
        "items": {
          "$ref": "#"
        }
      },
      "anyOf": {
        "type": "array",
        "items": {
          "$ref": "#"
        }
      },
      "default": {
        "$comment": "ts: unknown"
      },
      "x-unit": {
        "description": "The unit a number is in: `px`, `%`, `°`.",
        "type": "string"
      },
      "x-enum-omitted": {
        "description": "How many allowed values a shortened `enum` leaves out. Only in the page state, where a row's options are summarised; a tool's input schema always lists every value.",
        "type": "number"
      }
    },
    "$defs": {
      "JsonSchemaType": {
        "description": "A JSON Schema type name.",
        "enum": [
          "object",
          "array",
          "string",
          "number",
          "integer",
          "boolean",
          "null"
        ]
      }
    }
  } as ContractSchemaDocument,
  'action-effect.json': {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://schemas.closurestudio.ai/oui/v1/action-effect.json",
    "title": "ActionEffect",
    "description": "What using an action does (ADR-0226 §2.6): one vocabulary for a design-system control's binding, a room catalog's entry and a generated API tool, so a page control, a room action and an API call are told apart by what they change, never by where they are declared.\n\n| Effect | What it changes | ADR-0210 access |\n|---|---|---|\n| `view`, `selection`, `navigate`, `open` | What is shown | read |\n| `edit` | The document, one undo step | write |\n| `file` | Imports or exports a file | write |\n| `mutate` | Backend data, through an API operation | write |\n| `job` | Starts work that outlives the call, settled on its outcome | write |\n| `transaction` | An irreversible external act: an order, a payment, a send, a publish | write, approved |\n\nA `transaction`, and any `write` declared `destructive`, runs only on an approval the person gave, bound to the call (ADR-0228).",
    "oneOf": [
      {
        "$ref": "#/$defs/SimpleEffect"
      },
      {
        "description": "Goes to another page: a route pattern from the app's routes.",
        "type": "object",
        "properties": {
          "kind": {
            "const": "navigate"
          },
          "to": {
            "type": "string",
            "minLength": 1
          }
        },
        "required": [
          "kind",
          "to"
        ],
        "additionalProperties": false
      },
      {
        "description": "Opens a container on the page: the binding id of a dialog, drawer, popover or tab set.",
        "type": "object",
        "properties": {
          "kind": {
            "const": "open"
          },
          "container": {
            "type": "string",
            "minLength": 1
          }
        },
        "required": [
          "kind",
          "container"
        ],
        "additionalProperties": false
      },
      {
        "description": "Changes backend data through an API operation, by its `operationId` (`updateVoice`).",
        "type": "object",
        "properties": {
          "kind": {
            "const": "mutate"
          },
          "operation": {
            "type": "string",
            "minLength": 1
          }
        },
        "required": [
          "kind",
          "operation"
        ],
        "additionalProperties": false
      },
      {
        "description": "Starts work that outlives the call, such as a GPU job. The handler returns `{ ok: true, pending: { jobId } }`; the action is reported done only when the job's completion arrives, failed when it fails, and never done when it has not finished within `timeoutMs` (default 5 minutes). Its states are `JobStatus`.",
        "type": "object",
        "properties": {
          "kind": {
            "const": "job"
          },
          "estimatedDuration": {
            "type": "string"
          },
          "timeoutMs": {
            "type": "number",
            "exclusiveMinimum": 0
          }
        },
        "required": [
          "kind"
        ],
        "additionalProperties": false
      },
      {
        "description": "An irreversible external act: an order placed, a payment made, a message sent, something published. Modelled on `job`: its handler may return `pending: { jobId }` and it settles on the outcome. It always needs the person's approval of the exact call (ADR-0228), which no policy waives.\n\n- `operation`: the API operation it goes through, when it is one.\n- `approvalMinutes`: how long an approval of it lasts, at most 30 (default 5).",
        "type": "object",
        "properties": {
          "kind": {
            "const": "transaction"
          },
          "operation": {
            "type": "string",
            "minLength": 1
          },
          "estimatedDuration": {
            "type": "string"
          },
          "timeoutMs": {
            "type": "number",
            "exclusiveMinimum": 0
          },
          "approvalMinutes": {
            "type": "integer",
            "minimum": 1,
            "maximum": 30
          }
        },
        "required": [
          "kind"
        ],
        "additionalProperties": false
      }
    ],
    "$defs": {
      "SimpleEffect": {
        "description": "An effect that needs nothing but its name.",
        "enum": [
          "view",
          "selection",
          "edit",
          "file"
        ]
      },
      "ActionEffectKind": {
        "description": "The effect kinds, in the order of the table above. The vocabulary, what each one may change, and what needs the person's approval are OUI's (`oui-spec`).",
        "enum": [
          "view",
          "selection",
          "navigate",
          "open",
          "edit",
          "file",
          "mutate",
          "job",
          "transaction"
        ]
      },
      "EffectAccess": {
        "description": "Whether an effect only changes what is shown (`read`), or changes something (`write`), as ADR-0210 names it. An action that declares no effect is a `write`.",
        "enum": [
          "read",
          "write"
        ]
      },
      "JobStatus": {
        "description": "Where an action whose effect is `job` or `transaction` is (plan §2.3, #205/#209):\n\n- `started`: the handler returned; the job is tracked from this moment, so an outcome that arrives before the first poll is kept.\n- `running`: still going; the runtime polls the app's `JobTracker`.\n- `complete`: the job's declared completion arrived; the result exists.\n- `failed`: its declared failure arrived; the result never will.\n- `timeout`: it did not finish within `timeoutMs`. A failure, never a late success.\n- `unverified`: no `JobTracker`, or no job id to follow: the work was started but cannot be confirmed from the page.",
        "enum": [
          "started",
          "running",
          "complete",
          "failed",
          "timeout",
          "unverified"
        ]
      },
      "JobOutcome": {
        "description": "A job's end, as the assistant is told it. `complete` means the result exists; `failed` that it never will. A `complete` outcome carries the declared result fields beside its job id.",
        "oneOf": [
          {
            "type": "object",
            "properties": {
              "status": {
                "const": "complete"
              },
              "jobId": {
                "type": "string"
              }
            },
            "required": [
              "status",
              "jobId"
            ],
            "additionalProperties": true
          },
          {
            "type": "object",
            "properties": {
              "status": {
                "const": "failed"
              },
              "jobId": {
                "type": "string"
              },
              "error": {
                "type": "string"
              }
            },
            "required": [
              "status",
              "jobId",
              "error"
            ],
            "additionalProperties": false
          }
        ]
      },
      "JobSettlement": {
        "description": "What an action that settles on a job reports, from its first answer to its last: `started` (with the job id when the handler gave one), `running` while it polls, then the `JobOutcome`, or `unverified`. A `timeout` is reported as the error `TIMEOUT`, never as data.",
        "oneOf": [
          {
            "type": "object",
            "properties": {
              "status": {
                "const": "started"
              },
              "jobId": {
                "type": "string"
              }
            },
            "required": [
              "status"
            ],
            "additionalProperties": true
          },
          {
            "type": "object",
            "properties": {
              "status": {
                "const": "running"
              },
              "jobId": {
                "type": "string"
              }
            },
            "required": [
              "status",
              "jobId"
            ],
            "additionalProperties": false
          },
          {
            "$ref": "#/$defs/JobOutcome"
          },
          {
            "type": "object",
            "properties": {
              "status": {
                "const": "unverified"
              },
              "message": {
                "type": "string"
              }
            },
            "required": [
              "status",
              "message"
            ],
            "additionalProperties": false
          }
        ]
      }
    }
  } as ContractSchemaDocument,
  'agent-binding.json': {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://schemas.closurestudio.ai/oui/v1/agent-binding.json",
    "title": "AgentBinding",
    "description": "The semantic binding a design-system control carries (ADR-0220 §2.2): what the control means, in the user's terms, declared where the page uses it, as its `agent` prop.\n\nIt uses a room catalog entry's vocabulary (id, title and description; `ActionEffect`; `destructive`), so to the generator a page control and a room entry look the same. What is never written: the input schema, which is derived from the control's own props, and where the control is, which the generator derives from the page's component tree.\n\n**Every value is a build-time constant** (#203). The generator reads bindings from source without running it, so each value is a literal, a `const` it can follow, a property of a constant object, a template literal or `+` over those, or a single-literal type read through the type checker. A value built by a call (`t('save')`, `format(...)`) is refused, naming the binding. A field's build-time `hint` and `placeholder` are added to its tool description the same way.",
    "type": "object",
    "properties": {
      "id": {
        "description": "Stable, globally unique, dotted and lower-kebab: `voices.library`, `voices.detail.engine`. The first segment is the area. The tool name is the id with `.` and `-` as `_`, at most 64 characters.",
        "type": "string",
        "pattern": "^[a-z][a-z0-9-]*(\\.[a-z0-9][a-z0-9-]*)+$"
      },
      "title": {
        "description": "Defaults to the control's visible label or aria-label.",
        "type": "string"
      },
      "description": {
        "description": "What using it does, for someone who cannot see the screen.",
        "type": "string",
        "minLength": 1
      },
      "effect": {
        "description": "What using it does: what reach paths, data and verification are derived from (ADR-0226 §2.6).",
        "$ref": "action-effect.json"
      },
      "destructive": {
        "description": "It removes or replaces something the person made; running it needs the person's approval (ADR-0228).",
        "type": "boolean"
      },
      "confirm": {
        "description": "It changes what the person is working in (their account, project or role) rather than their work; the assistant asks before using it.",
        "type": "boolean"
      },
      "item": {
        "description": "Set when the control is one of a list's rows: which row.",
        "$ref": "#/$defs/AgentItem"
      }
    },
    "required": [
      "id",
      "description"
    ],
    "additionalProperties": false,
    "$defs": {
      "AgentItem": {
        "description": "One of several of the same control rendered from a list: which one it is.",
        "type": "object",
        "properties": {
          "key": {
            "description": "The id of what the row shows (a voice id, a project id).",
            "type": "string"
          },
          "title": {
            "description": "What the row is called on screen (the voice's name).",
            "type": "string"
          },
          "description": {
            "description": "What this row is, when the rows' meanings are only known at run time (a model's parameters, from its manifest). Shown with the row in the page state.",
            "type": "string"
          }
        },
        "required": [
          "key",
          "title"
        ],
        "additionalProperties": false
      },
      "NonAgentBinding": {
        "description": "On a control the assistant must never operate — purely decorative, or chrome that duplicates a bound control. The reason is required and is reviewed like any other declaration.",
        "type": "object",
        "properties": {
          "nonAgent": {
            "type": "string",
            "minLength": 1
          }
        },
        "required": [
          "nonAgent"
        ],
        "additionalProperties": false
      },
      "AgentProp": {
        "description": "The `agent` prop of a single-purpose control.",
        "anyOf": [
          {
            "$ref": "#"
          },
          {
            "$ref": "#/$defs/NonAgentBinding"
          }
        ]
      }
    }
  } as ContractSchemaDocument,
  'control-kind-registration.json': {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://schemas.closurestudio.ai/oui/v1/control-kind-registration.json",
    "title": "ControlKindRegistration",
    "description": "A control kind a design system adds (ADR-0226 §2.6). `ControlKind` is closed: a design system adds a kind only by registering it, under an `x-` name. The registration ships in the design system's control table (`$kinds`), where the generator reads it, and the design system registers it at run time with `registerControlKind`, so the browser and the generator derive the same schema.",
    "type": "object",
    "properties": {
      "kind": {
        "$ref": "#/$defs/RegisteredControlKind"
      },
      "verb": {
        "description": "What using it does, as a tool description starts: \"Set the price range of\".",
        "type": "string",
        "minLength": 1,
        "pattern": "\\S"
      },
      "deriveSchema": {
        "$ref": "#/$defs/KindSchemaDerivation"
      }
    },
    "required": [
      "kind",
      "verb",
      "deriveSchema"
    ],
    "additionalProperties": false,
    "$defs": {
      "ControlKind": {
        "description": "The built-in control kinds, closed:\n\n- `button`: press it (buttons, toolbar buttons, menu items, a row's action).\n- `toggle`: set it on or off (switches, checkboxes).\n- `text`: type into it (inputs, text areas).\n- `number`: set a number (sliders, scrub fields).\n- `choice`: choose one of its options (selects, radio groups, preset tiles).\n- `multi-choice`: choose any of its options (multi-selects, checkbox groups, filter chips).\n- `color`: set a colour or paint (colour pickers, swatches).\n- `font`: choose a family and style (font pickers).\n- `tabs`: select a tab.\n- `date`: set a date.\n- `date-range`: set a start and an end date.\n- `dialog`: close it. Opening is its trigger's.",
        "enum": [
          "button",
          "toggle",
          "text",
          "number",
          "choice",
          "multi-choice",
          "color",
          "font",
          "tabs",
          "date",
          "date-range",
          "dialog"
        ]
      },
      "RegisteredControlKind": {
        "description": "A kind a design system registers: `x-` and lower-kebab, so it never collides with a built-in one.",
        "type": "string",
        "pattern": "^x-[a-z][a-z0-9]*(-[a-z0-9]+)*$",
        "$comment": "ts: `x-${string}`"
      },
      "AnyControlKind": {
        "description": "A built-in kind, or one a design system registers.",
        "anyOf": [
          {
            "$ref": "#/$defs/ControlKind"
          },
          {
            "$ref": "#/$defs/RegisteredControlKind"
          }
        ]
      },
      "SchemaPropName": {
        "description": "A key of `SchemaProps`: a prop a control's value schema is derived from.",
        "enum": [
          "min",
          "max",
          "step",
          "unit",
          "wrap",
          "options",
          "minLength",
          "maxLength",
          "pattern",
          "inputType",
          "paintKinds",
          "allowNone",
          "clearable"
        ]
      },
      "ControlOption": {
        "description": "One option of a choice, tab set or menu, as the control shows it.",
        "type": "object",
        "properties": {
          "value": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "number"
              }
            ]
          },
          "title": {
            "type": "string"
          },
          "disabled": {
            "type": "boolean"
          }
        },
        "required": [
          "value",
          "title"
        ],
        "additionalProperties": false
      },
      "SchemaProps": {
        "description": "The props a control's input schema is derived from, by the one derivation (`deriveInputSchema`) the browser runs on live props and the generator on the props it reads statically. A live schema may narrow the generated one but never widen it.",
        "type": "object",
        "properties": {
          "min": {
            "type": "number"
          },
          "max": {
            "type": "number"
          },
          "step": {
            "type": "number"
          },
          "unit": {
            "type": "string"
          },
          "wrap": {
            "description": "Wraps past either end: an angle, where 181° is −179°.",
            "type": "boolean"
          },
          "options": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/ControlOption"
            }
          },
          "minLength": {
            "type": "number"
          },
          "maxLength": {
            "type": "number"
          },
          "pattern": {
            "type": "string"
          },
          "inputType": {
            "description": "An input's `type`: `email`, `url`, `number`, `password`…",
            "type": "string"
          },
          "paintKinds": {
            "description": "The paint kinds a colour control offers: `solid`, `linear`, `radial`.",
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "allowNone": {
            "description": "A colour control can be set to no paint.",
            "type": "boolean"
          },
          "clearable": {
            "description": "A choice that can be cleared (a toggleable tile grid).",
            "type": "boolean"
          }
        },
        "additionalProperties": false
      },
      "KindSchemaDerivation": {
        "description": "How a registered kind's value schema follows from a control's props, as data, so the browser and the generator derive it with the same function: the schema, and which of its keywords each prop sets, by JSON Pointer. `options` sets a keyword to the values of the options that are not disabled.\n\n```json\n{ \"schema\": { \"type\": \"object\", \"properties\": { \"low\": { \"type\": \"number\" }, \"high\": { \"type\": \"number\" } } },\n  \"props\": { \"/properties/low/minimum\": \"min\", \"/properties/high/maximum\": \"max\" } }\n```",
        "type": "object",
        "properties": {
          "schema": {
            "$ref": "json-schema.json"
          },
          "props": {
            "type": "object",
            "propertyNames": {
              "pattern": "^/"
            },
            "additionalProperties": {
              "$ref": "#/$defs/SchemaPropName"
            }
          }
        },
        "required": [
          "schema"
        ],
        "additionalProperties": false
      }
    }
  } as ContractSchemaDocument,
  'control-table.json': {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://schemas.closurestudio.ai/oui/v1/control-table.json",
    "title": "ControlTableFile",
    "description": "A design-system package's control table as it ships (`agent-controls.json`, ADR-0226 §2.2 rule 4): each interactive export's `ControlDescriptor` by export name, and under `$kinds` the control kinds the design system registers, if any. The package declares the table next to its controls, writes it at build time, and names it in its `package.json` under `oui.agentControls` (`closure.agentControls` is read during the transition; declaring both is an error). The conformance kit holds every listed component to registering with the kind declared here.",
    "type": "object",
    "properties": {
      "$kinds": {
        "description": "The control kinds this design system registers.",
        "type": "array",
        "items": {
          "$ref": "control-kind-registration.json"
        }
      }
    },
    "propertyNames": {
      "anyOf": [
        {
          "const": "$kinds"
        },
        {
          "pattern": "^[A-Z][A-Za-z0-9]*$"
        }
      ]
    },
    "additionalProperties": {
      "$ref": "#/$defs/ControlDescriptor"
    },
    "$defs": {
      "ControlTable": {
        "description": "A design-system package's controls, by export name: the table without its `$kinds`.",
        "type": "object",
        "additionalProperties": {
          "$ref": "#/$defs/ControlDescriptor"
        }
      },
      "SlotDescriptor": {
        "description": "One slot of a composite: its kind and the callback it binds. `callback` absent: the slot is always interactive (a toast host's toasts, whatever the page passes). `rows`: the slot registers once per row the control renders (a table's rows, a filter bar's pills), so its action takes an `item`. `defaults`: what the slot always registers, over the component's (a table's sort can be cleared), so the declared schema is as wide as the live one.",
        "type": "object",
        "properties": {
          "kind": {
            "$ref": "control-kind-registration.json#/$defs/AnyControlKind"
          },
          "callback": {
            "type": "string",
            "minLength": 1
          },
          "rows": {
            "type": "boolean"
          },
          "defaults": {
            "$ref": "control-kind-registration.json#/$defs/SchemaProps"
          }
        },
        "required": [
          "kind"
        ],
        "additionalProperties": false
      },
      "EntriesDescriptor": {
        "description": "An array prop whose entries carry their own `agent` (toolbar items, menu items, selection actions).",
        "type": "object",
        "properties": {
          "prop": {
            "type": "string",
            "minLength": 1
          },
          "kind": {
            "$ref": "control-kind-registration.json#/$defs/AnyControlKind"
          },
          "callback": {
            "type": "string",
            "minLength": 1
          },
          "titleKey": {
            "type": "string",
            "minLength": 1
          }
        },
        "required": [
          "prop",
          "kind",
          "callback",
          "titleKey"
        ],
        "additionalProperties": false
      },
      "ControlDescriptor": {
        "description": "How the generator reads one design-system component where a page uses it: what kind of control it is, which of its props make it interactive, and where its schema, options, slots and nested bindings come from. The component itself registers through `useAgentBinding` with the same kind.",
        "type": "object",
        "properties": {
          "kind": {
            "description": "What a binding on the component itself makes. Absent when it binds only per slot or per entry.",
            "$ref": "control-kind-registration.json#/$defs/AnyControlKind"
          },
          "callbacks": {
            "description": "Props whose presence makes a use interactive — a use with one of them must be bound. Empty: always.",
            "type": "array",
            "items": {
              "type": "string",
              "minLength": 1
            }
          },
          "schemaProps": {
            "description": "Props the schema is derived from, by `SchemaProps` key: the prop of the component each comes from.",
            "$ref": "#/$defs/SchemaPropSources"
          },
          "options": {
            "description": "Where the options come from: the prop, and the keys of each option's value and title.",
            "$ref": "#/$defs/OptionsSource"
          },
          "slots": {
            "description": "A composite with several callbacks: slot name → its kind and the callback it binds.",
            "type": "object",
            "additionalProperties": {
              "$ref": "#/$defs/SlotDescriptor"
            }
          },
          "entries": {
            "$ref": "#/$defs/EntriesDescriptor"
          },
          "rows": {
            "description": "The control registers one binding per row it renders (a selectable grid), so its action takes an `item`.",
            "type": "boolean"
          },
          "container": {
            "description": "A container: a dialog whose prop says whether it shows, or a tab set whose prop selects a panel.",
            "type": "object",
            "properties": {
              "kind": {
                "enum": [
                  "dialog",
                  "tabs"
                ]
              },
              "stateProp": {
                "type": "string",
                "minLength": 1
              }
            },
            "required": [
              "kind",
              "stateProp"
            ],
            "additionalProperties": false
          },
          "defaults": {
            "description": "What the schema props are when the page leaves them out, as the component defaults them. The declared schema is the widest the control can take; the live one may only narrow it.",
            "$ref": "control-kind-registration.json#/$defs/SchemaProps"
          },
          "display": {
            "description": "It shows facts rather than taking input (a clip's parameters): a binding on it names what it shows, and the page reports its facts by label. Its facts are the array prop `itemsProp`, each labelled by `labelKey`. Not a control, so a use without a binding is not unbound.",
            "type": "object",
            "properties": {
              "itemsProp": {
                "type": "string",
                "minLength": 1
              },
              "labelKey": {
                "type": "string",
                "minLength": 1
              }
            },
            "required": [
              "itemsProp",
              "labelKey"
            ],
            "additionalProperties": false
          },
          "titleProps": {
            "description": "Props that give a default title, in order. `children` means the element's text.",
            "type": "array",
            "items": {
              "type": "string",
              "minLength": 1
            }
          }
        },
        "required": [
          "callbacks",
          "titleProps"
        ],
        "additionalProperties": false
      },
      "OptionsSource": {
        "description": "Where a control's options come from: the prop that holds them, and the keys of each option's value and title.",
        "type": "object",
        "properties": {
          "prop": {
            "type": "string",
            "minLength": 1
          },
          "value": {
            "type": "string",
            "minLength": 1
          },
          "title": {
            "type": "string",
            "minLength": 1
          }
        },
        "required": [
          "prop",
          "value",
          "title"
        ],
        "additionalProperties": false
      },
      "OuiPackageDeclaration": {
        "description": "What a package declares to the generator under the `oui` key of its `package.json` (ADR-0226 §2.2): its control table, its room catalog, and the components only the person may use. During the transition the generator and the kit also read `closure.agentControls` and `closure.agentCatalog`; a package declaring a key under both `oui` and `closure` is an error.",
        "type": "object",
        "properties": {
          "agentControls": {
            "description": "The path of the package's control table, relative to the package.",
            "type": "string",
            "minLength": 1
          },
          "agentCatalog": {
            "$ref": "room-catalog-data.json#/$defs/AgentCatalogManifestEntry"
          },
          "personOnly": {
            "description": "Export name → why only the person may use it, such as the approval card (ADR-0228). The generator refuses an `agent` binding on one.",
            "type": "object",
            "additionalProperties": {
              "type": "string",
              "minLength": 1
            }
          }
        },
        "additionalProperties": false
      },
      "SchemaPropSources": {
        "description": "Props a control's schema is derived from, by `SchemaProps` key (every key but `options`, which `OptionsSource` gives): the prop of the component each comes from.",
        "type": "object",
        "properties": {
          "min": {
            "type": "string"
          },
          "max": {
            "type": "string"
          },
          "step": {
            "type": "string"
          },
          "unit": {
            "type": "string"
          },
          "wrap": {
            "type": "string"
          },
          "minLength": {
            "type": "string"
          },
          "maxLength": {
            "type": "string"
          },
          "pattern": {
            "type": "string"
          },
          "inputType": {
            "type": "string"
          },
          "paintKinds": {
            "type": "string"
          },
          "allowNone": {
            "type": "string"
          },
          "clearable": {
            "type": "string"
          }
        },
        "additionalProperties": false
      }
    }
  } as ContractSchemaDocument,
  'tier2-mapping.json': {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://schemas.closurestudio.ai/oui/v1/tier2-mapping.json",
    "title": "Tier2Mapping",
    "description": "A tier 2 mapping (ADR-0226 §2.3): how an app binds the controls of a third-party design system it does not own (MUI, Mantine, shadcn/Radix). It is a declaration, not handler code: `oui generate` emits one module per mapping into `<out>/bound/`. Each wrapper accepts `agent`, calls `useAgentBinding` with the app's own callback, returns that callback's result (§2.2 rule 3), and renders the third-party component unchanged. The emitted module ships its own control table and is treated exactly like a tier 1 package. On an enforced page, importing a mapped component straight from the third-party package fails the build.",
    "type": "object",
    "properties": {
      "$schema": {
        "type": "string"
      },
      "package": {
        "description": "The third-party package the controls are imported from (`@mantine/core`).",
        "type": "string",
        "minLength": 1
      },
      "controls": {
        "description": "Each mapped export, by its export name in that package.",
        "type": "object",
        "minProperties": 1,
        "propertyNames": {
          "pattern": "^[A-Z][A-Za-z0-9]*$"
        },
        "additionalProperties": {
          "$ref": "#/$defs/Tier2Control"
        }
      }
    },
    "required": [
      "package",
      "controls"
    ],
    "additionalProperties": false,
    "$defs": {
      "ValueFrom": {
        "description": "Where the new value is in the callback's arguments: `{ \"arg\": 0 }` for Mantine's `onChange(value)`, `{ \"arg\": 1 }` for MUI's `onChange(event, value)`, and `{ \"arg\": 0, \"path\": \"target.value\" }` for a native-style event. The wrapper builds those arguments when the assistant sets the value, and reads them back when the person does.",
        "type": "object",
        "properties": {
          "arg": {
            "description": "The argument's position.",
            "type": "integer",
            "minimum": 0
          },
          "path": {
            "description": "A dotted path into that argument.",
            "type": "string",
            "pattern": "^[A-Za-z_$][A-Za-z0-9_$]*(\\.[A-Za-z_$][A-Za-z0-9_$]*)*$"
          }
        },
        "required": [
          "arg"
        ],
        "additionalProperties": false
      },
      "Tier2Part": {
        "description": "One part of a control exported under a namespace: the export path of that part (`Select.Root`, `Select.Item`, `Tabs.Tab`). A path is an export of the package, or one member of one (one dot at most).",
        "type": "object",
        "properties": {
          "export": {
            "description": "The part's export path: an export of the package, or one member of it, dotted (`Select.Item`).",
            "type": "string",
            "pattern": "^[A-Z][A-Za-z0-9]*(\\.[A-Z][A-Za-z0-9]*)?$"
          },
          "valueProp": {
            "description": "On an item part: the prop that is the option's value.",
            "type": "string",
            "minLength": 1
          },
          "titleProps": {
            "description": "On an item part: the props, in order, that give the option's title. `children` means its text.",
            "type": "array",
            "items": {
              "type": "string",
              "minLength": 1
            }
          }
        },
        "required": [
          "export"
        ],
        "additionalProperties": false
      },
      "Tier2Control": {
        "description": "One mapped control. The bound wrapper reports the component's `disabled` prop, so a control the page disables is not offered (a disabled job control is still followed until its job settles).",
        "type": "object",
        "properties": {
          "kind": {
            "$ref": "control-kind-registration.json#/$defs/AnyControlKind"
          },
          "callbacks": {
            "description": "Props whose presence makes a use interactive. The first is the one a binding runs: for a value, with the arguments `valueFrom` describes; for a button or a dialog, with an event-shaped argument whose `isTrusted` is false.",
            "type": "array",
            "minItems": 1,
            "items": {
              "type": "string",
              "minLength": 1
            }
          },
          "valueFrom": {
            "description": "Required for every kind that takes a value (all but `button` and `dialog`).",
            "$ref": "#/$defs/ValueFrom"
          },
          "controlled": {
            "description": "The prop that shows the value. The generator reports every use of the control that does not pass it: there the handler would run, but the control would not show the new value.",
            "type": "string",
            "minLength": 1
          },
          "options": {
            "description": "Where the options come from: the prop, and the keys of each option's value and title.",
            "$ref": "control-table.json#/$defs/OptionsSource"
          },
          "titleProps": {
            "description": "Props that give a default title, in order. `children` means the element's text.",
            "type": "array",
            "items": {
              "type": "string",
              "minLength": 1
            }
          },
          "schemaProps": {
            "description": "Props the value schema is derived from, by `SchemaProps` key.",
            "$ref": "control-table.json#/$defs/SchemaPropSources"
          },
          "defaults": {
            "description": "What the schema props are when the app leaves them out, as the component defaults them.",
            "$ref": "control-kind-registration.json#/$defs/SchemaProps"
          },
          "parts": {
            "description": "A control exported under a namespace (Radix `Switch.Root`) or made of parts (Radix `Select.Root` / `Select.Item`, Mantine `Tabs` / `Tabs.Tab`): its `root`, which takes the callbacks, and, when the options are the items it renders, its `item`. The bound module keeps every other member of each namespace (`Select.Trigger`, `Tabs.List`).",
            "type": "object",
            "properties": {
              "root": {
                "$ref": "#/$defs/Tier2Part"
              },
              "item": {
                "$ref": "#/$defs/Tier2Part"
              }
            },
            "required": [
              "root"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "kind",
          "callbacks"
        ],
        "additionalProperties": false,
        "allOf": [
          {
            "if": {
              "properties": {
                "kind": {
                  "not": {
                    "enum": [
                      "button",
                      "dialog"
                    ]
                  }
                }
              }
            },
            "then": {
              "required": [
                "valueFrom",
                "controlled"
              ]
            }
          },
          {
            "if": {
              "required": [
                "parts"
              ],
              "properties": {
                "parts": {
                  "type": "object",
                  "required": [
                    "item"
                  ]
                }
              }
            },
            "then": {
              "not": {
                "required": [
                  "options"
                ]
              }
            }
          }
        ]
      }
    }
  } as ContractSchemaDocument,
  'room-catalog-data.json': {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://schemas.closurestudio.ai/oui/v1/room-catalog-data.json",
    "title": "RoomCatalogData",
    "description": "A room catalog as plain data (ADR-0220 §2.3, tier 3 of ADR-0226): what a room with its own editing model — a canvas, a chart, a timeline, a player — declares about everything a person can do in it, so the assistant's actions and knowledge are generated from the room's code. Every declaration, none of the functions: a room's package writes it as `agent-catalog.json` (named in `package.json` under `oui.agentCatalog`) so a build-time generator reads the catalog without loading React or the room's code; an app's own catalog is read through the app's Vite config.\n\n- **actions**: its operations, each carried out through the room's own reducer and commands, with a JSON schema for the input;\n- **fields**: its inspector's fields, each with its value's schema, unit, range, its animation where the room has a timeline, and which kinds of thing it applies to;\n- **commands**: its keymap, each command with its keys and what it does;\n- **observations**: what the host reports about the room's state, including the problems it has drawing it.\n\nA room derives each action's input from the schema its reducer already validates with (`z.toJSONSchema`) and re-checks input with the same schema before applying it.",
    "type": "object",
    "properties": {
      "room": {
        "description": "The room's id: the surface id its assistant surface is published under (`room:<id>`).",
        "type": "string",
        "minLength": 1
      },
      "title": {
        "type": "string",
        "minLength": 1
      },
      "description": {
        "description": "What the room is for, in one or two sentences.",
        "type": "string",
        "minLength": 1
      },
      "actions": {
        "type": "array",
        "items": {
          "$ref": "#/$defs/RoomActionData"
        }
      },
      "fields": {
        "type": "array",
        "items": {
          "$ref": "#/$defs/RoomFieldData"
        }
      },
      "commands": {
        "type": "array",
        "items": {
          "$ref": "#/$defs/RoomCommand"
        }
      },
      "observations": {
        "type": "array",
        "items": {
          "$ref": "#/$defs/RoomObservation"
        }
      },
      "problems": {
        "description": "The kinds of problem it reports, in its own vocabulary. Default: the generic `problems` schema.",
        "type": "array",
        "items": {
          "$ref": "#/$defs/RoomProblemKind"
        }
      },
      "recipes": {
        "description": "Tasks its tools carry out together, which only the room knows.",
        "type": "array",
        "items": {
          "$ref": "#/$defs/RoomRecipe"
        }
      }
    },
    "required": [
      "room",
      "title",
      "description",
      "actions",
      "fields",
      "commands",
      "observations"
    ],
    "additionalProperties": false,
    "$defs": {
      "RoomEntryInfo": {
        "description": "What every catalog entry says about itself. Knowledge is generated from these words alone.",
        "type": "object",
        "properties": {
          "id": {
            "description": "Stable, kebab-case, unique among the room's entries of its kind.",
            "type": "string",
            "minLength": 1
          },
          "title": {
            "description": "What the UI calls it: a button's label, a field's label, a command's name.",
            "type": "string"
          },
          "description": {
            "description": "What it does, in a sentence or two, in the room's own terms.",
            "type": "string"
          },
          "control": {
            "description": "Where a person does it: the tool, panel, button, key or gesture.",
            "type": "string"
          }
        },
        "required": [
          "id",
          "title",
          "description",
          "control"
        ]
      },
      "RoomActionData": {
        "description": "One operation of the room, without its `run`.",
        "type": "object",
        "allOf": [
          {
            "$ref": "#/$defs/RoomEntryInfo"
          },
          {
            "type": "object",
            "properties": {
              "kind": {
                "const": "action"
              },
              "input": {
                "description": "An object schema: a tool's input is one, never a union at its top level. Its property descriptions are the parameters' documentation.",
                "$ref": "json-schema.json"
              },
              "effect": {
                "description": "What it changes: the document (`edit`), the selection, the view, files, backend data, a job, a transaction.",
                "$ref": "action-effect.json"
              },
              "destructive": {
                "description": "It removes or replaces something the person made; running it needs the person's approval (ADR-0228).",
                "type": "boolean"
              }
            },
            "required": [
              "kind",
              "input",
              "effect"
            ]
          }
        ],
        "unevaluatedProperties": false
      },
      "RoomSection": {
        "description": "Which inspector section a field is in, as the inspector titles it.",
        "type": "object",
        "properties": {
          "id": {
            "type": "string"
          },
          "title": {
            "type": "string"
          }
        },
        "required": [
          "id",
          "title"
        ],
        "additionalProperties": false
      },
      "RoomFieldAnimation": {
        "description": "A field's animation, in a room with a timeline. Animation is a capability, not a requirement (ADR-0226 §2.6).",
        "type": "object",
        "properties": {
          "keyframeable": {
            "description": "Set at the playhead, it is a keyframe there when the property is animated.",
            "type": "boolean"
          }
        },
        "required": [
          "keyframeable"
        ],
        "additionalProperties": false
      },
      "RoomFieldData": {
        "description": "One inspector field, without its `read` and `write`: what it shows for the selection, and what setting it does.",
        "type": "object",
        "allOf": [
          {
            "$ref": "#/$defs/RoomEntryInfo"
          },
          {
            "type": "object",
            "properties": {
              "kind": {
                "const": "field"
              },
              "section": {
                "$ref": "#/$defs/RoomSection"
              },
              "appliesTo": {
                "description": "The kinds of thing it applies to, in the room's vocabulary (`text`, `shape`, `artboard`…).",
                "type": "array",
                "items": {
                  "type": "string"
                }
              },
              "value": {
                "description": "The value's schema: its type, range (`minimum`/`maximum`), options (`enum`) and unit (`x-unit`).",
                "$ref": "json-schema.json"
              },
              "animation": {
                "description": "How it animates, in a room with a timeline. A room without one leaves it out.",
                "$ref": "#/$defs/RoomFieldAnimation"
              },
              "keyframeable": {
                "description": "Deprecated since oui-bindings 0.8: `animation: { keyframeable }`. Read for one minor.",
                "type": "boolean"
              }
            },
            "required": [
              "kind",
              "section",
              "appliesTo",
              "value"
            ]
          }
        ],
        "unevaluatedProperties": false
      },
      "RoomCommand": {
        "description": "One keymap command: what its key does.",
        "type": "object",
        "allOf": [
          {
            "$ref": "#/$defs/RoomEntryInfo"
          },
          {
            "type": "object",
            "properties": {
              "kind": {
                "const": "command"
              },
              "group": {
                "description": "The group the room lists it under: tools, objects, edit, view.",
                "type": "string"
              },
              "keys": {
                "description": "Its keys as a person reads them (`⇧⌘G`). Empty when it has none.",
                "type": "array",
                "items": {
                  "type": "string"
                }
              },
              "status": {
                "description": "`reserved`: its key is kept for a feature that is not built; it does nothing. Never offered.",
                "enum": [
                  "available",
                  "reserved"
                ]
              },
              "options": {
                "description": "Options the command takes beyond the selection (a nudge's direction).",
                "$ref": "json-schema.json"
              }
            },
            "required": [
              "kind",
              "group",
              "keys",
              "status"
            ]
          }
        ],
        "unevaluatedProperties": false
      },
      "RoomObservation": {
        "description": "Something the room reports about its state: the document, what is selected, or the problems it has drawing it. The host pushes the value; the catalog declares what it means.",
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "minLength": 1
          },
          "description": {
            "type": "string"
          },
          "schema": {
            "$ref": "json-schema.json"
          }
        },
        "required": [
          "id",
          "description",
          "schema"
        ],
        "additionalProperties": false
      },
      "RoomProblemKind": {
        "description": "One kind of problem a room or page reports, in its own vocabulary (`missing-font`, `order-rejected`): the kind, and what it means.",
        "type": "object",
        "properties": {
          "kind": {
            "type": "string",
            "minLength": 1
          },
          "description": {
            "type": "string",
            "minLength": 1
          }
        },
        "required": [
          "kind",
          "description"
        ],
        "additionalProperties": false
      },
      "RoomRecipe": {
        "description": "A task the room's own tools carry out together, declared by the room because only it knows the task (animating a property, placing an order). The generator turns it into a knowledge recipe and ends it with reading what the room reports.\n\nIn `name`, `trigger` and each step, `{room}` is the room's title, and these name the tool that does a step, checked against the catalog when the knowledge is generated:\n- `{action:<id>}`: the action's tool;\n- `{command:<id>}`: the command, run with the `run-command` action;\n- `{field:<id>}`: the field, set with the `set-properties` action;\n- `{keyframeable}`: the ids of the fields that animate.",
        "type": "object",
        "properties": {
          "name": {
            "type": "string",
            "minLength": 1
          },
          "trigger": {
            "type": "string",
            "minLength": 1
          },
          "steps": {
            "type": "array",
            "items": {
              "type": "string"
            }
          }
        },
        "required": [
          "name",
          "trigger",
          "steps"
        ],
        "additionalProperties": false
      },
      "RoomProblem": {
        "description": "A problem a room or page has drawing or reading what the person is working on: a face it cannot load, text it therefore does not draw, an asset that failed, something an import could not reproduce. Reported in a `problems` observation, so an assistant sees what the person sees in the banners.",
        "type": "object",
        "properties": {
          "kind": {
            "description": "`missing-font`, `font-error`, `unsupported-import`, `asset-failed`, `access-required`…",
            "type": "string"
          },
          "message": {
            "description": "The room's own words for it, as its banner says it.",
            "type": "string"
          },
          "hides": {
            "description": "Ids of the things not drawn because of it.",
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "resolve": {
            "description": "How the person resolves it in the room: an action of this catalog, and the choices it offers.",
            "type": "object",
            "properties": {
              "action": {
                "type": "string"
              },
              "choices": {
                "type": "array",
                "items": {
                  "type": "object",
                  "additionalProperties": true
                }
              }
            },
            "required": [
              "action"
            ],
            "additionalProperties": false
          },
          "detail": {
            "description": "Anything else that names the problem precisely (the face, the element).",
            "type": "object",
            "additionalProperties": true
          }
        },
        "required": [
          "kind",
          "message"
        ],
        "additionalProperties": false
      },
      "RoomResult": {
        "description": "What running a catalog entry or a bound control did: its data, or why it could not be done, in words a person would read. `pending` says the work outlives the call: a job was started and is done only when its completion arrives (an action whose effect is `job` or `transaction`). Every binding's `run` returns what the consumer's callback returned (ADR-0226 §2.2 rule 3, #209), so a handler's `{ ok, pending: { jobId } }` reaches the runtime.",
        "oneOf": [
          {
            "type": "object",
            "properties": {
              "ok": {
                "const": true
              },
              "data": {
                "type": "object",
                "additionalProperties": true
              },
              "pending": {
                "type": "object",
                "properties": {
                  "jobId": {
                    "type": "string"
                  }
                },
                "required": [
                  "jobId"
                ],
                "additionalProperties": false
              }
            },
            "required": [
              "ok"
            ],
            "additionalProperties": false
          },
          {
            "type": "object",
            "properties": {
              "ok": {
                "const": false
              },
              "code": {
                "type": "string"
              },
              "message": {
                "type": "string"
              }
            },
            "required": [
              "ok",
              "code",
              "message"
            ],
            "additionalProperties": false
          }
        ]
      },
      "AgentCatalogManifestEntry": {
        "description": "Where a room package names its catalog, under `oui.agentCatalog` in its `package.json` (`closure.agentCatalog` is read during the transition). `hosts` are the exported components that mount the room (and register it); a page that renders one has the room's surface.\n\n```json\n\"oui\": { \"agentCatalog\": { \"path\": \"./dist/agent-catalog.json\", \"hosts\": [\"VectorStudioRoom\"] } }\n```",
        "type": "object",
        "properties": {
          "path": {
            "type": "string",
            "minLength": 1
          },
          "hosts": {
            "type": "array",
            "items": {
              "type": "string",
              "minLength": 1
            },
            "minItems": 1,
            "$comment": "ts: string[]"
          }
        },
        "required": [
          "path",
          "hosts"
        ],
        "additionalProperties": false
      }
    }
  } as ContractSchemaDocument,
  'oui-manifest.json': {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://schemas.closurestudio.ai/oui/v1/oui-manifest.json",
    "title": "OuiManifest",
    "description": "What the generator emits for each build (`oui-manifest.json`, ADR-0220 §2.4–2.5): every surface, action and observation the build's UI offers. The runtime (`connectBindings`) offers the intersection of the manifest and the handlers mounted right now, so an action the build declares is a tool only while its control, or its room, is on screen. CI regenerates it and diffs it (`oui generate --check`).",
    "type": "object",
    "properties": {
      "version": {
        "description": "The contract major (`MANIFEST_VERSION`). A breaking change to any of these schemas bumps it.",
        "const": 1
      },
      "buildId": {
        "description": "A hash of everything else in the manifest and the knowledge: the build's identity to the assistant.",
        "type": "string",
        "minLength": 1
      },
      "surfaces": {
        "type": "array",
        "items": {
          "$ref": "#/$defs/ManifestSurface"
        }
      }
    },
    "required": [
      "version",
      "buildId",
      "surfaces"
    ],
    "additionalProperties": false,
    "$defs": {
      "ReachStep": {
        "description": "One step of the way a person reaches a capability.",
        "oneOf": [
          {
            "description": "Go to the page. `nav` is where the sidebar lists it.",
            "type": "object",
            "properties": {
              "kind": {
                "const": "route"
              },
              "path": {
                "type": "string"
              },
              "title": {
                "type": "string"
              },
              "nav": {
                "type": "string"
              }
            },
            "required": [
              "kind",
              "path",
              "title"
            ],
            "additionalProperties": false
          },
          {
            "description": "Select a tab: the tab set's binding (its tool) and the tab's value.",
            "type": "object",
            "properties": {
              "kind": {
                "const": "tab"
              },
              "binding": {
                "type": "string"
              },
              "value": {
                "anyOf": [
                  {
                    "type": "string"
                  },
                  {
                    "type": "number"
                  }
                ]
              },
              "title": {
                "type": "string"
              }
            },
            "required": [
              "kind",
              "binding",
              "value",
              "title"
            ],
            "additionalProperties": false
          },
          {
            "description": "Open a dialog, drawer or popover, with one of the controls that open it.",
            "type": "object",
            "properties": {
              "kind": {
                "const": "dialog"
              },
              "binding": {
                "type": "string"
              },
              "title": {
                "type": "string"
              },
              "openedBy": {
                "type": "array",
                "items": {
                  "type": "string"
                }
              }
            },
            "required": [
              "kind",
              "title",
              "openedBy"
            ],
            "additionalProperties": false
          },
          {
            "description": "Show a part of the page that appears once a control sets its state (a detail panel opened by choosing a row).",
            "type": "object",
            "properties": {
              "kind": {
                "const": "panel"
              },
              "title": {
                "type": "string"
              },
              "openedBy": {
                "type": "array",
                "items": {
                  "type": "string"
                }
              }
            },
            "required": [
              "kind",
              "title",
              "openedBy"
            ],
            "additionalProperties": false
          },
          {
            "description": "Open a menu or toolbar the control is an entry of.",
            "type": "object",
            "properties": {
              "kind": {
                "const": "menu"
              },
              "title": {
                "type": "string"
              }
            },
            "required": [
              "kind",
              "title"
            ],
            "additionalProperties": false
          },
          {
            "description": "A room's own place for it: its tool, panel, section, key or gesture, as the room says.",
            "type": "object",
            "properties": {
              "kind": {
                "const": "room"
              },
              "room": {
                "type": "string"
              },
              "where": {
                "type": "string"
              },
              "selection": {
                "type": "array",
                "items": {
                  "type": "string"
                }
              }
            },
            "required": [
              "kind",
              "room",
              "where"
            ],
            "additionalProperties": false
          }
        ]
      },
      "ManifestActionSource": {
        "description": "Where an action comes from: a bound control, a room's catalog entry, or the generated navigation.",
        "enum": [
          "control",
          "room-action",
          "navigation"
        ]
      },
      "ManifestAction": {
        "description": "One action a surface offers: one tool.",
        "type": "object",
        "properties": {
          "name": {
            "description": "The tool name: unique across the build.",
            "type": "string",
            "pattern": "^[a-z0-9_]{1,64}$"
          },
          "id": {
            "description": "The binding id, or `<room>/<kind>/<entry>` for a room's.",
            "type": "string",
            "minLength": 1
          },
          "source": {
            "$ref": "#/$defs/ManifestActionSource"
          },
          "control": {
            "description": "The control kind, for a control: a built-in one, or one its design system registers.",
            "$ref": "control-kind-registration.json#/$defs/AnyControlKind"
          },
          "title": {
            "type": "string"
          },
          "description": {
            "type": "string"
          },
          "input": {
            "description": "The tool's input: one object schema, never a union at its top level.",
            "$ref": "json-schema.json"
          },
          "effect": {
            "description": "What running it does. A `job` or `transaction` settles on its outcome (`JobSettlement`); a `transaction`, or a destructive `write`, runs only on the person's approval of the exact call.",
            "$ref": "action-effect.json"
          },
          "destructive": {
            "type": "boolean"
          },
          "confirm": {
            "description": "It changes what the person is working in (account, project, role): the assistant asks first.",
            "type": "boolean"
          },
          "itemized": {
            "description": "One of a list's rows: the action takes the row as `item`.",
            "type": "boolean"
          },
          "reach": {
            "description": "How a person gets to it, from the page.",
            "type": "array",
            "items": {
              "$ref": "#/$defs/ReachStep"
            }
          },
          "declaredIn": {
            "description": "The source file that declares it, relative to the app.",
            "type": "string"
          }
        },
        "required": [
          "name",
          "id",
          "source",
          "title",
          "description",
          "input",
          "reach"
        ],
        "additionalProperties": false
      },
      "ManifestObservation": {
        "description": "One observation a surface reports: its id, what it means, and its value's schema.",
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "minLength": 1
          },
          "description": {
            "type": "string"
          },
          "schema": {
            "$ref": "json-schema.json"
          }
        },
        "required": [
          "id",
          "description",
          "schema"
        ],
        "additionalProperties": false
      },
      "ManifestSurfaceKind": {
        "description": "A page, a room on a page, a component shared by pages, the app's frame around the pages (`shell`, from `oui.config.json`'s `shell` entries), or the app's pages themselves: going to one by address (`navigation`).",
        "enum": [
          "page",
          "room",
          "shared",
          "shell",
          "navigation"
        ]
      },
      "ManifestSurface": {
        "description": "One surface: what it offers, where it can be mounted, and what it reports.",
        "type": "object",
        "properties": {
          "id": {
            "description": "`page:VoicesPage`, `room:vector-studio`, `shared:MoveToProjectModal`, `shell:StudioShell`, `app:navigation`.",
            "type": "string",
            "pattern": "^(page|room|shared|shell|app):.+$"
          },
          "kind": {
            "$ref": "#/$defs/ManifestSurfaceKind"
          },
          "title": {
            "type": "string"
          },
          "description": {
            "type": "string"
          },
          "routes": {
            "description": "The route patterns where it can be mounted.",
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "actions": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/ManifestAction"
            }
          },
          "observations": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/ManifestObservation"
            }
          }
        },
        "required": [
          "id",
          "kind",
          "title",
          "description",
          "routes",
          "actions",
          "observations"
        ],
        "additionalProperties": false
      }
    }
  } as ContractSchemaDocument,
  'generated-knowledge.json': {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://schemas.closurestudio.ai/oui/v1/generated-knowledge.json",
    "title": "GeneratedKnowledge",
    "description": "The knowledge the generator emits with the manifest (`oui-knowledge.json`, ADR-0220 §2.5), from the same declarations: the map of the app, every page in full with its relationships and recipes, and the app's frame. No word of it is written by hand. Each turn carries the part for the page the person is on (`resolveKnowledge`): the map, the frame parts around that page, the page in full, and one paragraph for each adjacent page.",
    "type": "object",
    "properties": {
      "version": {
        "description": "The contract major (`MANIFEST_VERSION`).",
        "const": 1
      },
      "buildId": {
        "description": "The manifest's build id: the two are one build.",
        "type": "string",
        "minLength": 1
      },
      "overview": {
        "description": "Every page, one line each: the map of the app.",
        "$ref": "#/$defs/KnowledgeEntry"
      },
      "pages": {
        "type": "array",
        "items": {
          "$ref": "#/$defs/PageKnowledge"
        }
      },
      "frames": {
        "description": "The app's frame around the pages (`shell` surfaces), each part with the route patterns it frames.",
        "type": "array",
        "items": {
          "$ref": "#/$defs/PageKnowledge"
        }
      }
    },
    "required": [
      "version",
      "buildId",
      "overview",
      "pages"
    ],
    "additionalProperties": false,
    "$defs": {
      "KnowledgeEntry": {
        "description": "One block of knowledge, as the assistant's prompt shows it.",
        "type": "object",
        "properties": {
          "title": {
            "type": "string"
          },
          "content": {
            "type": "string"
          }
        },
        "required": [
          "title",
          "content"
        ],
        "additionalProperties": false
      },
      "KnowledgeRecipe": {
        "description": "A task recipe the UI implies, as the assistant's prompt shows a workflow.",
        "type": "object",
        "properties": {
          "name": {
            "type": "string"
          },
          "trigger": {
            "type": "string"
          },
          "steps": {
            "type": "array",
            "items": {
              "type": "string"
            }
          }
        },
        "required": [
          "name",
          "trigger",
          "steps"
        ],
        "additionalProperties": false
      },
      "PageKnowledge": {
        "description": "What the assistant knows of one page, or one part of the app's frame.",
        "type": "object",
        "properties": {
          "surface": {
            "description": "The page surface this describes.",
            "type": "string"
          },
          "routes": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "summary": {
            "description": "One paragraph: what the page is for, for when the user is elsewhere.",
            "$ref": "#/$defs/KnowledgeEntry"
          },
          "detail": {
            "description": "Everything the page and its rooms offer, where each thing is, and its parameters.",
            "$ref": "#/$defs/KnowledgeEntry"
          },
          "relationships": {
            "description": "Relationships derived from types: which fields apply to what, which animate, what leads where.",
            "anyOf": [
              {
                "$ref": "#/$defs/KnowledgeEntry"
              },
              {
                "type": "null"
              }
            ]
          },
          "recipes": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/KnowledgeRecipe"
            }
          },
          "adjacent": {
            "description": "Page surfaces this page leads to or is reached from.",
            "type": "array",
            "items": {
              "type": "string"
            }
          }
        },
        "required": [
          "surface",
          "routes",
          "summary",
          "detail",
          "relationships",
          "recipes",
          "adjacent"
        ],
        "additionalProperties": false
      }
    }
  } as ContractSchemaDocument,
  'oui-config.json': {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://schemas.closurestudio.ai/oui/v1/oui-config.json",
    "title": "OuiConfigFile",
    "description": "`oui.config.json` at the app's root (ADR-0226 §2.4): where the app keeps its routes, navigation and output, which design systems and mappings its controls come from, where its API is described, and which of its pages are not yet bound. Paths are relative to the file. It is required and explicit: nothing an app depends on has a default, so a misconfigured app fails here, naming the setting, instead of generating an assistant that can do nothing. A setting the generator does not know is an error.",
    "type": "object",
    "properties": {
      "$schema": {
        "description": "This schema's URL, for editors.",
        "type": "string"
      },
      "$comment": {
        "type": "string"
      },
      "tsconfig": {
        "description": "The tsconfig the app's source compiles with.",
        "type": "string",
        "minLength": 1,
        "pattern": "\\S"
      },
      "routes": {
        "description": "The file whose routes decide where the app can go: `<Route>` elements (nested paths are joined to their parent, `index` routes kept, `React.lazy` followed) or a data router (`createBrowserRouter([...])`).",
        "type": "string",
        "minLength": 1,
        "pattern": "\\S"
      },
      "routeWrappers": {
        "description": "Components a route's element is wrapped in that are never the page (`Suspense`, `ErrorBoundary`). Default none.",
        "type": "array",
        "items": {
          "type": "string",
          "minLength": 1,
          "pattern": "\\S"
        }
      },
      "nav": {
        "description": "Files holding the navigation entries (`{ label, route, group }` object literals). Default none.",
        "type": "array",
        "items": {
          "type": "string",
          "minLength": 1,
          "pattern": "\\S"
        }
      },
      "out": {
        "description": "Where generated output goes.",
        "type": "string",
        "minLength": 1,
        "pattern": "\\S"
      },
      "designSystem": {
        "description": "Design-system packages whose controls carry bindings (tier 1). Each must resolve from the app and name its control table in its `package.json` (`oui.agentControls`). `[]`: every control is tier 2 or in a room.",
        "type": "array",
        "items": {
          "type": "string",
          "minLength": 1,
          "pattern": "\\S"
        }
      },
      "mappings": {
        "description": "Tier 2 mappings (`tier2-mapping.json`), one per third-party design system the app does not own, by path. `oui generate` emits a bound module per mapping into `<out>/bound/` (named after the package: `@mantine/core` → `mantine-core.ts`, with its control table beside it), and reads every use of a bound control as it reads a tier 1 control. On an enforced page, importing a mapped control straight from its package is an error naming the bound import. A package is in `designSystem` or mapped, never both. Default none.",
        "type": "array",
        "items": {
          "type": "string",
          "minLength": 1,
          "pattern": "\\S"
        }
      },
      "apiSpec": {
        "description": "The API's OpenAPI 3 document, by module path, as the installed API client ships it (`@traidr/api-client/openapi.json`) — never a sibling checkout path, so the generator reads exactly the spec of the client version the app installs; or a path inside the app. Every `mutate` effect names one of its `operationId`s. `null`: the app declares no API, and a `mutate` effect is an error.",
        "anyOf": [
          {
            "type": "string",
            "minLength": 1,
            "pattern": "\\S"
          },
          {
            "type": "null"
          }
        ]
      },
      "unbound": {
        "description": "Page components whose interactive controls are not all bound yet. It may only get shorter: the generator fails for a listed page that is fully bound, so the list cannot rot. Every other page is enforced. Default none.",
        "type": "array",
        "items": {
          "type": "string",
          "minLength": 1,
          "pattern": "\\S"
        }
      },
      "appCatalogs": {
        "description": "Room catalogs the app itself declares (tier 3, a page's own editor), each loaded through the app's own Vite config so its modules resolve as the app build resolves them: the app needs `vite` among its own dependencies. Only their declarations are read. Default none.",
        "type": "array",
        "items": {
          "$ref": "#/$defs/AppCatalogEntry"
        }
      },
      "shell": {
        "description": "The app's frame: components mounted around the pages rather than by a route (a sidebar, a top bar, a phone tab bar, a toast host). Each becomes a `shell:` surface offered on the routes it frames, and its controls are enforced as a page's are, unless listed in `unbound`. Default none.",
        "type": "array",
        "items": {
          "$ref": "#/$defs/ShellEntry"
        }
      }
    },
    "required": [
      "tsconfig",
      "routes",
      "designSystem",
      "apiSpec",
      "out"
    ],
    "additionalProperties": false,
    "$defs": {
      "ShellEntry": {
        "description": "One part of the app's frame.",
        "type": "object",
        "properties": {
          "module": {
            "description": "The module, relative to the app root.",
            "type": "string",
            "minLength": 1,
            "pattern": "\\S"
          },
          "export": {
            "description": "The export that is the frame's component.",
            "type": "string",
            "minLength": 1,
            "pattern": "\\S"
          },
          "routes": {
            "description": "The route patterns it frames. Default every route (`*`).",
            "type": "array",
            "items": {
              "type": "string"
            }
          }
        },
        "required": [
          "module",
          "export"
        ],
        "additionalProperties": false
      },
      "AppCatalogEntry": {
        "description": "A room catalog the app declares.",
        "type": "object",
        "properties": {
          "module": {
            "description": "The module, relative to the app root.",
            "type": "string",
            "minLength": 1,
            "pattern": "\\S"
          },
          "export": {
            "description": "The export that is the catalog.",
            "type": "string",
            "minLength": 1,
            "pattern": "\\S"
          },
          "hosts": {
            "description": "App components whose use puts the room on a page.",
            "type": "array",
            "items": {
              "type": "string",
              "minLength": 1
            }
          }
        },
        "required": [
          "module",
          "export",
          "hosts"
        ],
        "additionalProperties": false
      }
    }
  } as ContractSchemaDocument,
  'approvals.json': {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://schemas.closurestudio.ai/oui/v1/approvals.json",
    "title": "Approvals",
    "description": "Approvals (ADR-0228): the shapes the agent worker, the approval store in the realtime server, the browser's approval card, OUI's surface runtime and a conversation engine exchange. An irreversible action — a `transaction`, or a `write` declared `destructive` — runs only on an approval the person gave, bound to the exact call by a single-use token.\n\n1. The worker stops the turn at the call and stores it (`PendingApprovalInput`); the person's tab receives `agent:approval_required` (`ApprovalRequiredEvent`) and renders the approval card from its `preview`, whose every word comes from the action's declaration, never from the model.\n2. In a UI only a click on the card counts: the card sends `approval:decide` (`ApprovalDecidePayload`) from the person's own socket. On a conversation channel, the verbatim `readback` and an affirmative next turn (ADR-0210 §2.6).\n3. The store answers the decider only (`ApprovalDecideResult`): a single-use token, a compact JWS (`ApprovalTokenClaims`), and the call's `argsHash`. The tab's OUI runtime holds an `ApprovalGrant`.\n4. The next turn carries the token (`ApprovalContinuation`); the worker redeems it for the stored call, exactly (`ApprovedCall`), and runs it. A UI action request then carries `approval` (`ActionRequestApproval`), which the browser checks against its grant before it runs the handler.\n\nThe args hash is SHA-256 over the RFC 8785 (JCS) canonical JSON of the call's arguments, lowercase hex; `oui-spec/approval-vectors.json` holds every implementation, in any language, to it.",
    "$defs": {
      "ArgsHash": {
        "description": "SHA-256 of the RFC 8785 canonical JSON of a call's arguments, lowercase hex.",
        "type": "string",
        "pattern": "^[0-9a-f]{64}$"
      },
      "ApprovalChannel": {
        "description": "Where the person confirmed. In a UI only a click on the card counts (`ui`); in a conversation channel, the verbatim readback and an affirmative next turn (ADR-0210 §2.6).",
        "enum": [
          "ui",
          "voice",
          "phone",
          "sms",
          "chat"
        ]
      },
      "ApprovalDecision": {
        "enum": [
          "approve",
          "decline"
        ]
      },
      "ApprovalPreviewArgument": {
        "description": "One argument of the call, as the person reads it: its declared label and its value in words.",
        "type": "object",
        "properties": {
          "name": {
            "description": "The argument's name in the call.",
            "type": "string"
          },
          "label": {
            "description": "Its label, from the action's input schema.",
            "type": "string"
          },
          "value": {
            "description": "Its value, as text.",
            "type": "string"
          }
        },
        "required": [
          "name",
          "label",
          "value"
        ],
        "additionalProperties": false
      },
      "ApprovalPreview": {
        "description": "What the person is asked to approve. Every word comes from the action's declaration (its title, description and input schema labels), never from the model (ADR-0228 §2.2).",
        "type": "object",
        "properties": {
          "title": {
            "type": "string"
          },
          "consequence": {
            "description": "What running it does, from the declaration.",
            "type": "string"
          },
          "arguments": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/ApprovalPreviewArgument"
            }
          },
          "readback": {
            "description": "One sentence composed from the fields above, read or sent verbatim on a conversation channel.",
            "type": "string"
          }
        },
        "required": [
          "title",
          "arguments",
          "readback"
        ],
        "additionalProperties": false
      },
      "ApprovalEffect": {
        "description": "The effect the approval is for: the action's declared effect kind (ADR-0226 §2.6, `transaction` for an irreversible external act), or `write` when it declares none.",
        "type": "string",
        "minLength": 1
      },
      "PendingApprovalInput": {
        "description": "A call waiting for the person's approval, as the worker stores it (`POST /internal/approvals`).",
        "type": "object",
        "properties": {
          "approvalId": {
            "description": "Equals the tool call id.",
            "type": "string"
          },
          "toolCallId": {
            "type": "string"
          },
          "conversationId": {
            "type": "string"
          },
          "turnId": {
            "type": "string"
          },
          "userId": {
            "description": "The user whose turn made the call: the only one who may decide it.",
            "type": "string"
          },
          "tool": {
            "type": "string"
          },
          "args": {
            "type": "object",
            "additionalProperties": true
          },
          "argsHash": {
            "description": "`argsHash(args)`; the store checks it.",
            "$ref": "#/$defs/ArgsHash"
          },
          "effect": {
            "$ref": "#/$defs/ApprovalEffect"
          },
          "destructive": {
            "type": "boolean"
          },
          "argsSensitive": {
            "description": "Whether the arguments may be written to logs. They are only when the declaration says they are not sensitive.",
            "type": "boolean"
          },
          "expiresAt": {
            "description": "Epoch ms, at most 30 minutes away (`MAX_APPROVAL_TTL_MS`).",
            "type": "number"
          },
          "preview": {
            "$ref": "#/$defs/ApprovalPreview"
          }
        },
        "required": [
          "approvalId",
          "toolCallId",
          "conversationId",
          "turnId",
          "userId",
          "tool",
          "args",
          "argsHash",
          "effect",
          "destructive",
          "argsSensitive",
          "expiresAt",
          "preview"
        ],
        "additionalProperties": false
      },
      "ApprovalRequiredEvent": {
        "description": "`agent:approval_required`: the worker stopped the turn at a call that needs the person's approval. The approval card renders it.",
        "type": "object",
        "properties": {
          "turnId": {
            "type": "string"
          },
          "conversationId": {
            "type": "string"
          },
          "approvalId": {
            "type": "string"
          },
          "tool": {
            "type": "string"
          },
          "effect": {
            "$ref": "#/$defs/ApprovalEffect"
          },
          "destructive": {
            "type": "boolean"
          },
          "preview": {
            "$ref": "#/$defs/ApprovalPreview"
          },
          "expiresAt": {
            "type": "number"
          },
          "timestamp": {
            "type": "number"
          }
        },
        "required": [
          "turnId",
          "conversationId",
          "approvalId",
          "tool",
          "effect",
          "destructive",
          "preview",
          "expiresAt",
          "timestamp"
        ],
        "additionalProperties": false
      },
      "ApprovalDecidePayload": {
        "description": "`approval:decide`, from the person's own socket: the card's click.",
        "type": "object",
        "properties": {
          "approvalId": {
            "type": "string"
          },
          "decision": {
            "$ref": "#/$defs/ApprovalDecision"
          }
        },
        "required": [
          "approvalId",
          "decision"
        ],
        "additionalProperties": false
      },
      "ApprovalRefusalReason": {
        "description": "Why an approval was refused:\n\n- `unknown`: no such pending approval: never stored, already declined or redeemed, or expired and gone.\n- `forbidden`: another user's approval, or another conversation's.\n- `expired`.\n- `decided`: already decided.\n- `used`: already redeemed.\n- `invalid`: not a token this environment signed, or malformed.\n- `mismatch`: signed, but not for the stored call.\n- `channel`: a decision from a channel that may not make it.",
        "enum": [
          "unknown",
          "forbidden",
          "expired",
          "decided",
          "used",
          "invalid",
          "mismatch",
          "channel"
        ]
      },
      "ApprovalRefusal": {
        "type": "object",
        "properties": {
          "ok": {
            "const": false
          },
          "reason": {
            "$ref": "#/$defs/ApprovalRefusalReason"
          },
          "error": {
            "type": "string"
          }
        },
        "required": [
          "ok",
          "reason",
          "error"
        ],
        "additionalProperties": false
      },
      "ApprovalDecideResult": {
        "description": "The answer to a decision. An approval's token goes only to the decider: the socket that clicked, or the engine that asked.",
        "oneOf": [
          {
            "type": "object",
            "properties": {
              "ok": {
                "const": true
              },
              "decision": {
                "const": "approve"
              },
              "approvalId": {
                "type": "string"
              },
              "token": {
                "description": "The single-use token the continuation turn redeems.",
                "type": "string"
              },
              "argsHash": {
                "description": "What the browser checks a UI action's params against before it runs it.",
                "$ref": "#/$defs/ArgsHash"
              },
              "expiresAt": {
                "type": "number"
              },
              "channel": {
                "$ref": "#/$defs/ApprovalChannel"
              }
            },
            "required": [
              "ok",
              "decision",
              "approvalId",
              "token",
              "argsHash",
              "expiresAt",
              "channel"
            ],
            "additionalProperties": false
          },
          {
            "type": "object",
            "properties": {
              "ok": {
                "const": true
              },
              "decision": {
                "const": "decline"
              },
              "approvalId": {
                "type": "string"
              }
            },
            "required": [
              "ok",
              "decision",
              "approvalId"
            ],
            "additionalProperties": false
          },
          {
            "$ref": "#/$defs/ApprovalRefusal"
          }
        ]
      },
      "ApprovalTokenClaims": {
        "description": "The token's claims: a compact JWS (HS256), signed with the environment's approval key.",
        "type": "object",
        "properties": {
          "aid": {
            "description": "The approval id, which is the tool call id.",
            "type": "string"
          },
          "sub": {
            "description": "The user.",
            "type": "string"
          },
          "cid": {
            "description": "The conversation.",
            "type": "string"
          },
          "tool": {
            "type": "string"
          },
          "ah": {
            "description": "The args hash.",
            "$ref": "#/$defs/ArgsHash"
          },
          "eff": {
            "description": "The effect.",
            "$ref": "#/$defs/ApprovalEffect"
          },
          "ch": {
            "description": "Where the user confirmed.",
            "$ref": "#/$defs/ApprovalChannel"
          },
          "iat": {
            "description": "Issued at, epoch seconds.",
            "type": "integer"
          },
          "exp": {
            "description": "Expires at, epoch seconds.",
            "type": "integer"
          },
          "jti": {
            "description": "A nonce.",
            "type": "string"
          }
        },
        "required": [
          "aid",
          "sub",
          "cid",
          "tool",
          "ah",
          "eff",
          "ch",
          "iat",
          "exp",
          "jti"
        ],
        "additionalProperties": false
      },
      "ApprovedCall": {
        "description": "What redeeming a token returns: the stored call, exactly, for the worker to run.",
        "type": "object",
        "properties": {
          "approvalId": {
            "type": "string"
          },
          "toolCallId": {
            "type": "string"
          },
          "conversationId": {
            "type": "string"
          },
          "turnId": {
            "type": "string"
          },
          "userId": {
            "type": "string"
          },
          "tool": {
            "type": "string"
          },
          "args": {
            "type": "object",
            "additionalProperties": true
          },
          "argsHash": {
            "$ref": "#/$defs/ArgsHash"
          },
          "effect": {
            "$ref": "#/$defs/ApprovalEffect"
          },
          "destructive": {
            "type": "boolean"
          },
          "channel": {
            "$ref": "#/$defs/ApprovalChannel"
          }
        },
        "required": [
          "approvalId",
          "toolCallId",
          "conversationId",
          "turnId",
          "userId",
          "tool",
          "args",
          "argsHash",
          "effect",
          "destructive",
          "channel"
        ],
        "additionalProperties": false
      },
      "ApprovalRedeemResult": {
        "oneOf": [
          {
            "type": "object",
            "properties": {
              "ok": {
                "const": true
              },
              "call": {
                "$ref": "#/$defs/ApprovedCall"
              }
            },
            "required": [
              "ok",
              "call"
            ],
            "additionalProperties": false
          },
          {
            "$ref": "#/$defs/ApprovalRefusal"
          }
        ]
      },
      "ApprovalStatus": {
        "description": "An approval's state, for the turn that follows a decision.",
        "type": "object",
        "properties": {
          "approvalId": {
            "type": "string"
          },
          "status": {
            "enum": [
              "pending",
              "approved",
              "declined"
            ]
          },
          "tool": {
            "type": "string"
          },
          "title": {
            "type": "string"
          }
        },
        "required": [
          "approvalId",
          "status",
          "tool",
          "title"
        ],
        "additionalProperties": false
      },
      "ApprovalContinuation": {
        "description": "What a turn that follows a decision carries, outside the message text: the token to redeem, or that the person declined.",
        "oneOf": [
          {
            "type": "object",
            "properties": {
              "approvalId": {
                "type": "string"
              },
              "decision": {
                "const": "approve"
              },
              "token": {
                "type": "string"
              }
            },
            "required": [
              "approvalId",
              "decision",
              "token"
            ],
            "additionalProperties": false
          },
          {
            "type": "object",
            "properties": {
              "approvalId": {
                "type": "string"
              },
              "decision": {
                "const": "decline"
              }
            },
            "required": [
              "approvalId",
              "decision"
            ],
            "additionalProperties": false
          }
        ]
      },
      "ActionRequestApproval": {
        "description": "What a UI action request carries when it runs an approved call (`OUIActionApproval`): the browser runs a `transaction` or destructive action only when this matches a grant this tab received from its own card click (ADR-0228 §2.2.6).",
        "type": "object",
        "properties": {
          "approvalId": {
            "type": "string"
          },
          "argsHash": {
            "description": "`argsHash(params)` of the request the user approved.",
            "$ref": "#/$defs/ArgsHash"
          }
        },
        "required": [
          "approvalId",
          "argsHash"
        ],
        "additionalProperties": false
      },
      "ApprovalGrant": {
        "description": "What the person's approval click gives this tab's OUI runtime (`runtime.grantApproval`, `OUIApprovalGrant`): the request it approved, until it expires.",
        "type": "object",
        "properties": {
          "approvalId": {
            "type": "string"
          },
          "argsHash": {
            "$ref": "#/$defs/ArgsHash"
          },
          "expiresAt": {
            "description": "Epoch ms after which the grant no longer admits anything.",
            "type": "number"
          }
        },
        "required": [
          "approvalId",
          "argsHash",
          "expiresAt"
        ],
        "additionalProperties": false
      }
    }
  } as ContractSchemaDocument,
  'event-declarations.json': {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://schemas.closurestudio.ai/agent-sdk/event-declarations/v1.json",
    "title": "Event declarations",
    "description": "Every event a product emits over realtime: its payload schema, the rooms it is published to, its correlation fields and its role in a job (ADR-0227 §2.4).",
    "type": "object",
    "required": [
      "version",
      "product",
      "rooms",
      "events"
    ],
    "additionalProperties": false,
    "properties": {
      "$schema": {
        "type": "string"
      },
      "version": {
        "description": "The version of this document's format.",
        "const": 1
      },
      "product": {
        "description": "Who declares these events.",
        "type": "string",
        "minLength": 1
      },
      "description": {
        "type": "string"
      },
      "$defs": {
        "description": "Payload shapes the events share, referenced as `#/$defs/<Name>`.",
        "type": "object",
        "propertyNames": {
          "pattern": "^[A-Z][A-Za-z0-9]*$"
        },
        "additionalProperties": {
          "$ref": "#/$defs/EventPayloadSchema"
        }
      },
      "rooms": {
        "description": "Every room these events go to, by name.",
        "type": "object",
        "propertyNames": {
          "pattern": "^[a-z][A-Za-z0-9]*$"
        },
        "additionalProperties": {
          "$ref": "#/$defs/RoomDeclaration"
        }
      },
      "events": {
        "description": "Every event, by its name on the wire.",
        "type": "object",
        "propertyNames": {
          "pattern": "^[a-z][a-z0-9_-]*(:[a-z][a-z0-9_-]*)*$"
        },
        "additionalProperties": {
          "$ref": "#/$defs/EventDeclaration"
        }
      }
    },
    "$defs": {
      "JsonType": {
        "description": "The JSON Schema types a payload may use.",
        "enum": [
          "object",
          "array",
          "string",
          "number",
          "integer",
          "boolean",
          "null"
        ]
      },
      "EventPayloadSchema": {
        "description": "A JSON Schema (draft 2020-12). A payload may use any keyword; the platform reads `$ref` (to the document's `$defs`), `allOf`, `type`, `properties` and `required` to find the fields it correlates and reports on, and validates the rest with a full validator.",
        "type": "object",
        "properties": {
          "$ref": {
            "type": "string"
          },
          "type": {
            "description": "A JSON Schema type name, or a list of them.",
            "$comment": "ts: JsonType | readonly JsonType[]"
          },
          "description": {
            "type": "string"
          },
          "properties": {
            "type": "object",
            "additionalProperties": {
              "$ref": "#/$defs/EventPayloadSchema"
            }
          },
          "required": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "additionalProperties": {
            "description": "`false`, or the schema every other property follows.",
            "$comment": "ts: boolean | EventPayloadSchema"
          },
          "items": {
            "$ref": "#/$defs/EventPayloadSchema"
          },
          "enum": {
            "type": "array"
          },
          "const": {},
          "allOf": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/EventPayloadSchema"
            }
          },
          "anyOf": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/EventPayloadSchema"
            }
          },
          "oneOf": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/EventPayloadSchema"
            }
          }
        },
        "additionalProperties": true
      },
      "RoomDeclaration": {
        "type": "object",
        "required": [
          "pattern"
        ],
        "additionalProperties": false,
        "properties": {
          "pattern": {
            "description": "The room's name with `{placeholder}`s for its ids, e.g. `generation:{jobId}`. An id is letters, digits, `_` and `-`.",
            "type": "string",
            "pattern": "^([a-z0-9_:-]|\\{[a-zA-Z][a-zA-Z0-9]*\\})+$"
          },
          "description": {
            "type": "string"
          }
        }
      },
      "EventRole": {
        "description": "What an event is for, as the platform acts on it:\n- `completion`: a job of kind `completes` produced its result. A wait on the job ends well.\n- `failure`: a job of kind `completes` ended without a result. A wait on the job ends with its reason.\n- `progress`: a job is still running. Nothing waits on it: resolving a wait on progress reports a running job as done.\n- `notice`: anything else a client is told.",
        "enum": [
          "completion",
          "failure",
          "progress",
          "notice"
        ]
      },
      "FailureReason": {
        "description": "Where a settling event says why a job failed.",
        "type": "object",
        "required": [
          "field",
          "fallback"
        ],
        "additionalProperties": false,
        "properties": {
          "field": {
            "description": "The payload field carrying the reason.",
            "type": "string",
            "pattern": "^[A-Za-z_][A-Za-z0-9_]*$"
          },
          "fallback": {
            "description": "What the reason is when the field is absent.",
            "type": "string",
            "minLength": 1
          }
        }
      },
      "EventDeclaration": {
        "type": "object",
        "required": [
          "description",
          "payload",
          "rooms",
          "correlation",
          "role"
        ],
        "additionalProperties": false,
        "properties": {
          "description": {
            "type": "string",
            "minLength": 1
          },
          "payload": {
            "description": "The payload's JSON Schema: an object. `$ref`s point into the document's `$defs`. Every correlation, result and reason field is one of its properties.",
            "$ref": "#/$defs/EventPayloadSchema"
          },
          "typeName": {
            "description": "The name generated code gives the payload type. Default: the event name in PascalCase (`generation:completed` → `GenerationCompleted`).",
            "type": "string",
            "pattern": "^[A-Z][A-Za-z0-9]*$"
          },
          "rooms": {
            "description": "The rooms the event is published to: names from the document's `rooms`, or `turn` for the room of the agent turn it belongs to (the host names that room in each turn).",
            "type": "array",
            "items": {
              "type": "string",
              "minLength": 1
            },
            "minItems": 1,
            "uniqueItems": true
          },
          "correlation": {
            "description": "The payload fields that say which job, or which resource, the event is about (e.g. `jobId`). A completion or failure has exactly one.",
            "type": "array",
            "items": {
              "type": "string",
              "pattern": "^[A-Za-z_][A-Za-z0-9_]*$"
            },
            "uniqueItems": true
          },
          "role": {
            "$ref": "#/$defs/EventRole"
          },
          "completes": {
            "description": "For a completion or failure: the kind of job it settles.",
            "type": "string",
            "pattern": "^[a-z][A-Za-z0-9]*$"
          },
          "result": {
            "description": "For a completion: the payload fields that are the job's result, as a follower reports them.",
            "type": "array",
            "items": {
              "type": "string",
              "pattern": "^[A-Za-z_][A-Za-z0-9_]*$"
            },
            "uniqueItems": true
          },
          "reason": {
            "description": "For a failure: where its reason is.",
            "$ref": "#/$defs/FailureReason"
          }
        },
        "allOf": [
          {
            "if": {
              "properties": {
                "role": {
                  "enum": [
                    "completion",
                    "failure"
                  ]
                }
              }
            },
            "then": {
              "required": [
                "completes"
              ],
              "properties": {
                "correlation": {
                  "type": "array",
                  "minItems": 1,
                  "maxItems": 1
                }
              }
            },
            "else": {
              "not": {
                "required": [
                  "completes"
                ]
              }
            }
          },
          {
            "if": {
              "properties": {
                "role": {
                  "const": "completion"
                }
              }
            },
            "else": {
              "not": {
                "required": [
                  "result"
                ]
              }
            }
          },
          {
            "if": {
              "properties": {
                "role": {
                  "const": "failure"
                }
              }
            },
            "then": {
              "required": [
                "reason"
              ]
            },
            "else": {
              "not": {
                "required": [
                  "reason"
                ]
              }
            }
          }
        ]
      }
    }
  } as ContractSchemaDocument,
} as const;

export type ContractSchemaFile = keyof typeof CONTRACT_SCHEMAS;

/**
 * Each generated type, by name, and the schema it is generated from (`file`, or
 * `file#/$defs/Name`).
 */
export const CONTRACT_TYPES = {
  JsonSchema: 'json-schema.json',
  JsonSchemaType: 'json-schema.json#/$defs/JsonSchemaType',
  ActionEffect: 'action-effect.json',
  SimpleEffect: 'action-effect.json#/$defs/SimpleEffect',
  ActionEffectKind: 'action-effect.json#/$defs/ActionEffectKind',
  EffectAccess: 'action-effect.json#/$defs/EffectAccess',
  JobStatus: 'action-effect.json#/$defs/JobStatus',
  JobOutcome: 'action-effect.json#/$defs/JobOutcome',
  JobSettlement: 'action-effect.json#/$defs/JobSettlement',
  AgentBinding: 'agent-binding.json',
  AgentItem: 'agent-binding.json#/$defs/AgentItem',
  NonAgentBinding: 'agent-binding.json#/$defs/NonAgentBinding',
  AgentProp: 'agent-binding.json#/$defs/AgentProp',
  ControlKindRegistration: 'control-kind-registration.json',
  ControlKind: 'control-kind-registration.json#/$defs/ControlKind',
  RegisteredControlKind: 'control-kind-registration.json#/$defs/RegisteredControlKind',
  AnyControlKind: 'control-kind-registration.json#/$defs/AnyControlKind',
  SchemaPropName: 'control-kind-registration.json#/$defs/SchemaPropName',
  ControlOption: 'control-kind-registration.json#/$defs/ControlOption',
  SchemaProps: 'control-kind-registration.json#/$defs/SchemaProps',
  KindSchemaDerivation: 'control-kind-registration.json#/$defs/KindSchemaDerivation',
  ControlTableFile: 'control-table.json',
  ControlTable: 'control-table.json#/$defs/ControlTable',
  SlotDescriptor: 'control-table.json#/$defs/SlotDescriptor',
  EntriesDescriptor: 'control-table.json#/$defs/EntriesDescriptor',
  ControlDescriptor: 'control-table.json#/$defs/ControlDescriptor',
  OptionsSource: 'control-table.json#/$defs/OptionsSource',
  OuiPackageDeclaration: 'control-table.json#/$defs/OuiPackageDeclaration',
  SchemaPropSources: 'control-table.json#/$defs/SchemaPropSources',
  Tier2Mapping: 'tier2-mapping.json',
  ValueFrom: 'tier2-mapping.json#/$defs/ValueFrom',
  Tier2Part: 'tier2-mapping.json#/$defs/Tier2Part',
  Tier2Control: 'tier2-mapping.json#/$defs/Tier2Control',
  RoomCatalogData: 'room-catalog-data.json',
  RoomEntryInfo: 'room-catalog-data.json#/$defs/RoomEntryInfo',
  RoomActionData: 'room-catalog-data.json#/$defs/RoomActionData',
  RoomSection: 'room-catalog-data.json#/$defs/RoomSection',
  RoomFieldAnimation: 'room-catalog-data.json#/$defs/RoomFieldAnimation',
  RoomFieldData: 'room-catalog-data.json#/$defs/RoomFieldData',
  RoomCommand: 'room-catalog-data.json#/$defs/RoomCommand',
  RoomObservation: 'room-catalog-data.json#/$defs/RoomObservation',
  RoomProblemKind: 'room-catalog-data.json#/$defs/RoomProblemKind',
  RoomRecipe: 'room-catalog-data.json#/$defs/RoomRecipe',
  RoomProblem: 'room-catalog-data.json#/$defs/RoomProblem',
  RoomResult: 'room-catalog-data.json#/$defs/RoomResult',
  AgentCatalogManifestEntry: 'room-catalog-data.json#/$defs/AgentCatalogManifestEntry',
  OuiManifest: 'oui-manifest.json',
  ReachStep: 'oui-manifest.json#/$defs/ReachStep',
  ManifestActionSource: 'oui-manifest.json#/$defs/ManifestActionSource',
  ManifestAction: 'oui-manifest.json#/$defs/ManifestAction',
  ManifestObservation: 'oui-manifest.json#/$defs/ManifestObservation',
  ManifestSurfaceKind: 'oui-manifest.json#/$defs/ManifestSurfaceKind',
  ManifestSurface: 'oui-manifest.json#/$defs/ManifestSurface',
  GeneratedKnowledge: 'generated-knowledge.json',
  KnowledgeEntry: 'generated-knowledge.json#/$defs/KnowledgeEntry',
  KnowledgeRecipe: 'generated-knowledge.json#/$defs/KnowledgeRecipe',
  PageKnowledge: 'generated-knowledge.json#/$defs/PageKnowledge',
  OuiConfigFile: 'oui-config.json',
  ShellEntry: 'oui-config.json#/$defs/ShellEntry',
  AppCatalogEntry: 'oui-config.json#/$defs/AppCatalogEntry',
  ArgsHash: 'approvals.json#/$defs/ArgsHash',
  ApprovalChannel: 'approvals.json#/$defs/ApprovalChannel',
  ApprovalDecision: 'approvals.json#/$defs/ApprovalDecision',
  ApprovalPreviewArgument: 'approvals.json#/$defs/ApprovalPreviewArgument',
  ApprovalPreview: 'approvals.json#/$defs/ApprovalPreview',
  ApprovalEffect: 'approvals.json#/$defs/ApprovalEffect',
  PendingApprovalInput: 'approvals.json#/$defs/PendingApprovalInput',
  ApprovalRequiredEvent: 'approvals.json#/$defs/ApprovalRequiredEvent',
  ApprovalDecidePayload: 'approvals.json#/$defs/ApprovalDecidePayload',
  ApprovalRefusalReason: 'approvals.json#/$defs/ApprovalRefusalReason',
  ApprovalRefusal: 'approvals.json#/$defs/ApprovalRefusal',
  ApprovalDecideResult: 'approvals.json#/$defs/ApprovalDecideResult',
  ApprovalTokenClaims: 'approvals.json#/$defs/ApprovalTokenClaims',
  ApprovedCall: 'approvals.json#/$defs/ApprovedCall',
  ApprovalRedeemResult: 'approvals.json#/$defs/ApprovalRedeemResult',
  ApprovalStatus: 'approvals.json#/$defs/ApprovalStatus',
  ApprovalContinuation: 'approvals.json#/$defs/ApprovalContinuation',
  ActionRequestApproval: 'approvals.json#/$defs/ActionRequestApproval',
  ApprovalGrant: 'approvals.json#/$defs/ApprovalGrant',
  EventDeclarationDocument: 'event-declarations.json',
  JsonType: 'event-declarations.json#/$defs/JsonType',
  EventPayloadSchema: 'event-declarations.json#/$defs/EventPayloadSchema',
  RoomDeclaration: 'event-declarations.json#/$defs/RoomDeclaration',
  EventRole: 'event-declarations.json#/$defs/EventRole',
  FailureReason: 'event-declarations.json#/$defs/FailureReason',
  EventDeclaration: 'event-declarations.json#/$defs/EventDeclaration',
} as const;

export type ContractTypeName = keyof typeof CONTRACT_TYPES;
