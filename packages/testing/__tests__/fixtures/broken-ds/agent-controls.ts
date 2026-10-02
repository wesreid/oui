/** The broken fixture's control table: the good one, with its breaks. */
import type { ControlTableFile } from '@ouispec/bindings';

import { TABLE as GOOD } from '../good-ds/agent-controls';

export const TABLE: ControlTableFile = {
  ...GOOD,
  Choice: { ...(GOOD.Choice as object), placeholder: 'Pick one' } as never,
  Toggle: { kind: 'toggle', callbacks: ['onChange'], titleProps: ['label'] },
  SaveButton: { kind: 'button', callbacks: ['onSave'], titleProps: [] },
};
