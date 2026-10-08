/**
 * Reading a suite (ADR-0260 §3.2): a JSON or YAML file, held to the
 * contract's `agent-evals.json`, then to what a schema cannot say: unique
 * scenario ids, channels the configuration serves, regular expressions that
 * compile, an approval answered only after a turn could have asked for one,
 * and staff who take a conversation before they write in it.
 *
 * Every problem is reported at once, each with where it is.
 */
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { AgentEvalExpectation, AgentEvalSuite, AgentEvalTextMatcher } from '@ouispec/contract';
import { contractProblems } from '@ouispec/contract/validate';

/** A suite that cannot be run, with every reason. */
export class EvalSuiteError extends Error {
  constructor(
    readonly source: string,
    readonly problems: readonly string[],
  ) {
    super(`${source} is not a suite agent-evals can run:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'EvalSuiteError';
  }
}

/** Parse a suite file: `.json`, or `.yaml`/`.yml`. */
export function readSuiteFile(path: string): unknown {
  const text = readFileSync(path, 'utf8');
  const ext = extname(path).toLowerCase();
  if (ext === '.json') return JSON.parse(text);
  if (ext === '.yaml' || ext === '.yml') return parseYaml(text);
  throw new EvalSuiteError(path, [`a suite is a .json, .yaml or .yml file, not ${ext || 'a file with no extension'}`]);
}

const matchersOf = (expect: AgentEvalExpectation | undefined): AgentEvalTextMatcher[] => {
  if (!expect) return [];
  const out: AgentEvalTextMatcher[] = [...(expect.says ?? []), ...(expect.mustNotSay ?? []), ...(expect.doesNotStore ?? [])];
  if (expect.refusal && expect.refusal !== true) out.push(expect.refusal);
  if (expect.approvalRequested && expect.approvalRequested.readback) out.push(expect.approvalRequested.readback);
  return out;
};

/** Every expectation of a turn, the general one and each channel's. */
function expectationsOf(turn: AgentEvalSuite['scenarios'][number]['turns'][number]): Array<[string, AgentEvalExpectation]> {
  if ('staff' in turn) return [];
  return [
    ...(turn.expect ? [['expect', turn.expect] as [string, AgentEvalExpectation]] : []),
    ...Object.entries(turn.expectOn ?? {}).map(([channel, e]) => [`expectOn/${channel}`, e] as [string, AgentEvalExpectation]),
  ];
}

/**
 * The suite, checked: the contract's schema, then the rules it cannot state.
 * `channels` is the configuration's: every channel a suite names must be one.
 */
export function checkSuite(value: unknown, source: string, channels: readonly string[]): AgentEvalSuite {
  const structural = contractProblems('agent-evals.json', value);
  if (structural.length > 0) throw new EvalSuiteError(source, structural);
  const suite = value as AgentEvalSuite;
  const problems: string[] = [];
  const known = new Set(channels);
  const unknownChannels = (at: string, names: readonly string[] | undefined) => {
    for (const name of names ?? []) {
      if (!known.has(name)) problems.push(`${at}: channel "${name}" is not one the configuration serves (${channels.join(', ') || 'none'})`);
    }
  };
  unknownChannels('/channels', suite.channels);
  const suiteChannels = new Set(suite.channels ?? channels);

  const ids = new Set<string>();
  suite.scenarios.forEach((scenario, s) => {
    const at = `/scenarios/${s} (${scenario.id})`;
    if (ids.has(scenario.id)) problems.push(`${at}: the id "${scenario.id}" is used twice`);
    ids.add(scenario.id);
    unknownChannels(`${at}/channels`, scenario.channels);
    for (const name of scenario.channels ?? []) {
      if (known.has(name) && !suiteChannels.has(name)) problems.push(`${at}/channels: "${name}" is not one of the suite's channels`);
    }

    let held = false;
    let agentTurns = 0;
    scenario.turns.forEach((turn, t) => {
      const here = `${at}/turns/${t}`;
      for (const [where, expectation] of expectationsOf(turn)) {
        if (where.startsWith('expectOn/')) unknownChannels(`${here}/${where}`, [where.slice('expectOn/'.length)]);
        for (const matcher of matchersOf(expectation)) {
          if (typeof matcher === 'object' && 'pattern' in matcher) {
            try {
              new RegExp(matcher.pattern, matcher.flags);
            } catch (err) {
              problems.push(`${here}/${where}: /${matcher.pattern}/ is not a regular expression: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        }
      }
      if ('user' in turn) agentTurns += 1;
      else if ('approval' in turn) {
        if (agentTurns === 0) problems.push(`${here}: an approval is answered before any turn could have asked for one`);
        agentTurns += 1;
      } else if ('takeOver' in turn.staff) {
        if (held) problems.push(`${here}: the conversation is already held`);
        held = true;
      } else if ('say' in turn.staff) {
        if (!held) problems.push(`${here}: a person writes before anyone has taken the conversation over`);
      } else if (!held) {
        problems.push(`${here}: the conversation is handed back while nobody holds it`);
      } else {
        held = false;
      }
    });
    if (agentTurns === 0) problems.push(`${at}: it has no turn of the agent's to check`);
  });

  if (problems.length > 0) throw new EvalSuiteError(source, problems);
  return suite;
}

/** Every rubric a suite's scenario asks a judge about: what its recordings were made answering. */
export function rubricsOf(scenario: AgentEvalSuite['scenarios'][number]): string[] {
  return scenario.turns.flatMap((turn) =>
    expectationsOf(turn).flatMap(([, e]) => matchersOf(e).flatMap((m) => (typeof m === 'object' && 'rubric' in m ? [m.rubric] : []))),
  );
}
