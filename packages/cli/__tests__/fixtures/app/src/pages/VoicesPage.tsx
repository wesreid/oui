import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import {
  Button,
  ConfirmDialog,
  FactList,
  PageHeader,
  SelectionToolbar,
  SimpleTabs,
  SyncedMediaPlayer,
  Table,
  VoiceCard,
} from '@closurestudio/ui';
import { RenameDialog } from '../RenameDialog';

type Scope = 'user' | 'account';

export function VoicesPage() {
  const navigate = useNavigate();
  const [scope, setScope] = useState<Scope>('user');
  const [bulkDeleteIds, setBulkDeleteIds] = useState<string[] | null>(null);
  const [renaming, setRenaming] = useState(false);
  const voices = [{ id: 'v1', name: 'Ava' }];
  const tabs = [
    { id: 'user', label: 'My Voices' },
    { id: 'account', label: 'Account Voices' },
  ];
  const actions = useMemo(
    () => [
      {
        id: 'delete',
        label: 'Delete',
        onClick: (ids: string[]) => setBulkDeleteIds(ids),
        agent: { id: 'voices.bulk-delete', description: 'Delete the selected voices', destructive: true },
      },
    ],
    [],
  );
  const seed = scope === 'user' ? 42 : null;
  return (
    <div>
      <FactList
        title="Parameters"
        facts={[
          { label: 'Engine', value: scope },
          ...(seed !== null ? [{ label: 'Seed', value: seed }] : []),
        ]}
        agent={{ id: 'voices.parameters', description: 'The library’s generation parameters' }}
      />
      <FactList facts={[{ label: 'Count', value: 2 }]} />
      <PageHeader
        title="Voices"
        subtitle={scope === 'user' ? 'Your voice library.' : 'Voices shared with your account.'}
      />
      <SimpleTabs
        agent={{ id: 'voices.library', description: 'Which library to show' }}
        tabs={tabs}
        value={scope}
        onChange={v => setScope(v as Scope)}
      />
      <Button
        agent={{ id: 'voices.add', description: 'Start a new voice' }}
        onClick={() => navigate('/voices/create')}
      >
        Add Voice
      </Button>
      {scope === 'account' && (
        <Button
          agent={{ id: 'voices.rename', description: 'Rename the account' }}
          onClick={() => setRenaming(true)}
        >
          Rename
        </Button>
      )}
      <Button
        agent={{ id: 'voices.switch-account', description: 'Show the voices of another account', confirm: true }}
        onClick={() => {}}
      >
        Switch account
      </Button>
      <SelectionToolbar
        selectedCount={0}
        selectedIds={[]}
        totalCount={1}
        onDeselectAll={() => {}}
        actions={actions}
        agent={{ deselectAll: { nonAgent: 'selection bar chrome' } }}
      />
      {voices.map(v => (
        <VoiceCard
          key={v.id}
          name={v.name}
          type="cloned"
          onClick={() => {}}
          agent={{
            item: { key: v.id, title: v.name },
            open: { id: 'voices.open', description: 'Open a voice' },
          }}
        />
      ))}
      <Table
        columns={[]}
        data={voices}
        onRowClick={() => {}}
        sortable
        agent={{
          open: { id: 'voices.row', description: 'Open a voice from the table' },
          sort: { id: 'voices.sort', description: 'Sort the voices' },
        }}
      />
      <SyncedMediaPlayer tracks={[]} agent={{ play: { id: 'voices.play', description: 'Play the sample' } }} />
      <ConfirmDialog
        open={bulkDeleteIds != null}
        title="Delete Voices"
        message="Sure?"
        onConfirm={() => {}}
        onCancel={() => setBulkDeleteIds(null)}
        agent={{
          confirm: {
            id: 'voices.bulk-delete.confirm',
            description: 'Delete them',
            effect: { kind: 'mutate', operation: 'deleteVoice' },
          },
          cancel: { id: 'voices.bulk-delete.cancel', description: 'Keep them' },
        }}
      />
      <RenameDialog open={renaming} onClose={() => setRenaming(false)} />
    </div>
  );
}
