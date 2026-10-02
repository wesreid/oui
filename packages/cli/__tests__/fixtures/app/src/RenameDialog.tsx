import { Input, Modal } from '@closurestudio/ui';

export function RenameDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Rename"
      agent={{ id: 'voices.rename-dialog', description: 'The rename dialog' }}
    >
      <Input
        label="Name"
        maxLength={40}
        onChange={() => {}}
        agent={{ id: 'voices.rename-name', description: 'The new name' }}
      />
    </Modal>
  );
}
