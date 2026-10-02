/**
 * Approvals: an irreversible action runs only on an approval the user gave,
 * bound to the exact request.
 *
 * An agent runtime stops at an action that needs approval and shows the user
 * a confirmation. Its approval store issues a single-use grant when the user
 * confirms, and the request that then reaches the tab carries `approval:
 * { approvalId, argsHash }`. The surface runtime runs the action only when
 * that matches a grant this tab received from the user's own confirmation.
 *
 * Everything that checks a request computes the same args hash: SHA-256 over
 * the RFC 8785 (JCS) canonical JSON of its params, lowercase hex. The
 * published vectors (`oui-spec/approval-vectors.json`) hold every
 * implementation, in any language, to it.
 */

/**
 * What using an action does. One vocabulary for every kind of action, so an
 * action is told apart by what it changes:
 *
 * | Effect | What it changes | Access |
 * |---|---|---|
 * | `view`, `selection`, `navigate`, `open` | What is shown | read |
 * | `edit` | The document, one undo step | write |
 * | `file` | Imports or exports a file | write |
 * | `mutate` | Backend data, through an API operation | write |
 * | `job` | Starts work that outlives the call | write |
 * | `transaction` | An irreversible external act: an order, a payment, a send, a publish | write, approved |
 */
export type OUIEffectKind =
  | "view"
  | "selection"
  | "navigate"
  | "open"
  | "edit"
  | "file"
  | "mutate"
  | "job"
  | "transaction";

/** Every effect, in the order of the table above. */
export const OUI_EFFECT_KINDS: readonly OUIEffectKind[] = [
  "view",
  "selection",
  "navigate",
  "open",
  "edit",
  "file",
  "mutate",
  "job",
  "transaction",
];

/** Whether an effect only changes what is shown, or changes something. */
export const OUI_EFFECT_ACCESS: Readonly<
  Record<OUIEffectKind, "read" | "write">
> = {
  view: "read",
  selection: "read",
  navigate: "read",
  open: "read",
  edit: "write",
  file: "write",
  mutate: "write",
  job: "write",
  transaction: "write",
};

/** `read` or `write`. An action that declares no effect is a `write`: nothing says it only shows. */
export function effectAccess(
  effect: OUIEffectKind | undefined,
): "read" | "write" {
  return effect === undefined ? "write" : OUI_EFFECT_ACCESS[effect];
}

/**
 * Whether running an action needs the user's approval of the exact request: a
 * `transaction` always, and a `write` declared destructive. An agent
 * runtime's policy may require it of more; nothing waives these.
 */
export function requiresApproval(
  effect: OUIEffectKind | undefined,
  destructive?: boolean,
): boolean {
  if (effect === "transaction") return true;
  return !!destructive && effectAccess(effect) === "write";
}

/** What a request for an approved action carries. */
export interface OUIActionApproval {
  approvalId: string;
  /** `argsHash(params)` of the request the user approved. */
  argsHash: string;
}

/** A grant this tab holds: the user approved this request here. */
export interface OUIApprovalGrant extends OUIActionApproval {
  /** Epoch ms after which the grant no longer admits anything. */
  expiresAt: number;
}

/** An args hash: 64 lowercase hex digits. */
export const ARGS_HASH_PATTERN = /^[0-9a-f]{64}$/;

/**
 * The RFC 8785 canonical form of a JSON value:
 * - object members sorted by their names' UTF-16 code units, with no
 *   whitespace;
 * - numbers in ECMAScript's shortest round-trip form (`-0` is `0`);
 * - strings escaped as ECMAScript's `JSON.stringify` escapes them.
 *
 * The value must be I-JSON (RFC 7493): anything JSON cannot carry — `NaN`,
 * infinities, `undefined` outside an object member, a bigint, a function, a
 * symbol, a class instance, or a string with a lone surrogate — is refused
 * rather than hashed as something the other end never receives. An object
 * member whose value is `undefined` is left out, as it is on the wire.
 */
export function canonicalJson(value: unknown): string {
  return serialize(value, "$");
}

/** SHA-256 of the canonical JSON of a request's params, lowercase hex. Runs wherever WebCrypto does. */
export async function argsHash(params: unknown): Promise<string> {
  const canonical = canonicalJson(params);
  const subtle = await webCrypto();
  const digest = await subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  let hex = "";
  for (const byte of new Uint8Array(digest))
    hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/**
 * WebCrypto: global in browsers and Node 19+; Node 18 has it only on
 * `node:crypto`, imported here by a specifier bundlers leave alone.
 */
async function webCrypto(): Promise<SubtleCrypto> {
  const global = globalThis.crypto?.subtle;
  if (global) return global;
  const nodeCrypto = "node:crypto";
  try {
    const mod = (await import(/* @vite-ignore */ nodeCrypto)) as {
      webcrypto?: { subtle?: SubtleCrypto };
    };
    if (mod.webcrypto?.subtle) return mod.webcrypto.subtle;
  } catch {
    // Not Node: fall through to the error below.
  }
  throw new Error(
    "[OUI] argsHash needs WebCrypto (crypto.subtle), which this runtime does not provide",
  );
}

function refuse(path: string, what: string): never {
  throw new TypeError(`[OUI] ${path} is not I-JSON: ${what}`);
}

function serialize(value: unknown, path: string): string {
  switch (typeof value) {
    case "string":
      return quote(value, path);
    case "number":
      if (!Number.isFinite(value)) refuse(path, String(value));
      // ECMAScript's Number-to-string is RFC 8785's number form, and prints -0 as 0.
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "object": {
      if (value === null) return "null";
      if (Array.isArray(value)) {
        return `[${value.map((item, i) => serialize(item, `${path}[${i}]`)).join(",")}]`;
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        refuse(path, `a ${proto?.constructor?.name ?? "non-plain"} object`);
      }
      const record = value as Record<string, unknown>;
      // Default string order compares UTF-16 code units, which is RFC 8785's order.
      const keys = Object.keys(record)
        .filter((k) => record[k] !== undefined)
        .sort();
      return `{${keys
        .map(
          (k) =>
            `${quote(k, `${path} key`)}:${serialize(record[k], `${path}.${k}`)}`,
        )
        .join(",")}}`;
    }
    default:
      return refuse(path, typeof value);
  }
}

function quote(text: string, path: string): string {
  // I-JSON strings are well-formed Unicode: a lone surrogate has no UTF-8 form.
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i++;
        continue;
      }
      refuse(path, `a lone surrogate at ${i}`);
    }
    if (unit >= 0xdc00 && unit <= 0xdfff)
      refuse(path, `a lone surrogate at ${i}`);
  }
  return JSON.stringify(text);
}
