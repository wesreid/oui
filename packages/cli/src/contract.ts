/**
 * The contract the generator reads and writes (ADR-0226 §3.1): every control
 * table, room catalog, manifest and knowledge it handles is checked against
 * the published schemas, and each way one breaks them is a finding.
 */
import { contractProblems, type ContractRef } from '@ouispec/contract/validate';

import type { Finding } from './analyze.js';

/** Each way `value` breaks the contract's `ref`, as a finding against `file`, naming `what`. */
export function contractFindings(ref: ContractRef, value: unknown, file: string, what: string): Finding[] {
  return contractProblems(ref, value).map(problem => ({
    file,
    line: 0,
    message: `${what} does not match the OUI contract (${ref}): ${problem}`,
  }));
}
