/**
 * The guard on capabilities only a person can reach: a design-system control
 * marked `nonAgent` that is the only way into what it does.
 *
 * On 2026-11-23 a character's Add Images button was `nonAgent`, and it was the
 * only way to add a picture to a character: the assistant could not do it and
 * nothing said so. A `nonAgent` control is the only way into what it does when
 * its handlers call no app function that a bound control on the same page
 * also calls, and its reason names no action, tool or command the build has
 * (`(the.action.id)`, `the x.y command`, or such a name anywhere in it: an id
 * with a dot, dash or underscore, as the build names its actions). Each such control is listed
 * in `oui-non-agent.allow.json` on purpose (`oui generate --allow-non-agent`),
 * or the generation fails; a listed one that is gone fails it too, so the list
 * only shrinks.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import type { Finding, PageAnalysis } from './analyze.js';
import { roomFamilyMembers } from '@ouispec/bindings';

import { nonAgentReferences } from './assemble.js';

/** The list of `nonAgent` controls that are, on purpose, the only way into what they do. */
export const NON_AGENT_ALLOW_FILE = 'oui-non-agent.allow.json';

/** One `nonAgent` control that is the only way into what it does. */
export interface NonAgentOnly {
  file: string;
  line: number;
  reason: string;
}

/** Whether a reason names something the build has, which the assistant uses instead. */
export function namesAlternative(reason: string, known: ReadonlySet<string>): boolean {
  const named = nonAgentReferences(reason);
  if (named.actions.length || named.commands.length) return true;
  return (reason.match(/[\w.:-]+/g) ?? [])
    .map(token => token.replace(/^[.:-]+|[.:-]+$/g, ''))
    .some(token => /[._-]/.test(token) && known.has(token));
}

/**
 * The names the build gives what the assistant can do: every tool name and
 * action id, a room action's own id, the members of a room's action families
 * by their own ids (`x-members` on the family's `op`), and every room command.
 */
export function knownNames(
  surfaces: readonly { actions: readonly { name: string; id: string; input?: { properties?: Record<string, unknown> } }[] }[],
  commands: Iterable<string>,
): Set<string> {
  const known = new Set<string>(commands);
  for (const s of surfaces) {
    for (const a of s.actions) {
      known.add(a.name);
      known.add(a.id);
      const own = a.id.split('/action/')[1];
      if (own) known.add(own);
      for (const member of roomFamilyMembers(a.input)) known.add(member);
    }
  }
  return known;
}

/** Every `nonAgent` control that is the only way into what it does, once each, in file order. */
export function nonAgentOnlyEntries(analyses: Iterable<PageAnalysis>, known: ReadonlySet<string>): NonAgentOnly[] {
  const found = new Map<string, NonAgentOnly>();
  for (const analysis of analyses) {
    for (const c of analysis.nonAgentControls) {
      if (namesAlternative(c.reason, known)) continue;
      if (c.callees.length && c.callees.every(callee => analysis.boundCallees.has(callee))) continue;
      found.set(`${c.file}:${c.line}:${c.reason}`, { file: c.file, line: c.line, reason: c.reason });
    }
  }
  return [...found.values()].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.reason.localeCompare(b.reason));
}

/** A listed control by where it is and why, not by its line: lines move with every edit above them. */
const keyOf = (e: { file: string; reason: string }) => `${e.file}\u0000${e.reason}`;

/** The list's content for these controls: each file's reasons, how many times each, sorted. */
export function allowListContent(entries: readonly NonAgentOnly[]): string {
  const files: Record<string, Record<string, number>> = {};
  for (const e of entries) {
    const reasons = (files[e.file] ??= {});
    reasons[e.reason] = (reasons[e.reason] ?? 0) + 1;
  }
  const sorted = Object.fromEntries(
    Object.keys(files)
      .sort()
      .map(f => [f, Object.fromEntries(Object.keys(files[f]).sort().map(r => [r, files[f][r]]))]),
  );
  return `${JSON.stringify(
    {
      $comment:
        "nonAgent controls that are, on purpose, the only way into what they do: the assistant cannot reach what they do. Written by `oui generate --allow-non-agent`; it may only shrink. Bind a control, or name the action the assistant uses instead in its reason ('(the.action.id)'), and it leaves the list.",
      files: sorted,
    },
    null,
    2,
  )}\n`;
}

/** The list as committed: how many controls of each file and reason it allows. */
export function readAllowList(path: string): Map<string, number> {
  const out = new Map<string, number>();
  if (!existsSync(path)) return out;
  const raw = JSON.parse(readFileSync(path, 'utf8')) as { files?: Record<string, Record<string, number>> };
  for (const [file, reasons] of Object.entries(raw.files ?? {})) {
    for (const [reason, count] of Object.entries(reasons)) out.set(keyOf({ file, reason }), count);
  }
  return out;
}

/** Where the list is for a build's output directory. */
export function allowListPath(out: string): string {
  return join(out, NON_AGENT_ALLOW_FILE);
}

/**
 * What the list and the controls disagree on: a control it does not allow
 * (more of a file's reason than it lists), and a listing nothing matches any
 * more.
 */
export function nonAgentFindings(entries: readonly NonAgentOnly[], allowed: ReadonlyMap<string, number>, root: string, out: string): Finding[] {
  const findings: Finding[] = [];
  const counts = new Map<string, NonAgentOnly[]>();
  for (const e of entries) counts.set(keyOf(e), [...(counts.get(keyOf(e)) ?? []), e]);
  const list = relative(root, allowListPath(out));
  for (const [key, found] of counts) {
    const allow = allowed.get(key) ?? 0;
    for (const e of found.slice(allow)) {
      findings.push({
        file: e.file,
        line: e.line,
        message:
          `A nonAgent control ("${e.reason}") is the only way into what it does: no bound control calls what its handler calls, and its reason names no action the assistant uses instead. ` +
          `Bind it, or name that action in its reason ("(the.action.id)"); if the assistant must never do this, list it on purpose with oui generate --allow-non-agent (${list})`,
      });
    }
  }
  for (const [key, allow] of allowed) {
    const found = counts.get(key)?.length ?? 0;
    if (found >= allow) continue;
    const [file, reason] = key.split('\u0000');
    findings.push({
      file: list,
      line: 0,
      message: `${file}: "${reason}" is listed ${allow} time(s) but ${found} such control(s) remain: the list only shrinks, so run oui generate --allow-non-agent to take it off`,
    });
  }
  return findings;
}
