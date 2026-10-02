import { Button } from '@closurestudio/ui';

export default function BillingPage() {
  return (
    <Button agent={{ id: 'settings.billing.upgrade', description: 'Upgrade the plan' }} onClick={() => {}}>
      Go
    </Button>
  );
}
