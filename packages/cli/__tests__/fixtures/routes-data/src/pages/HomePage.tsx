import { Button } from '@closurestudio/ui';

export function HomePage() {
  return (
    <Button agent={{ id: 'home.start', description: 'Start something new' }} onClick={() => {}}>
      Go
    </Button>
  );
}
