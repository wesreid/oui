import { Button } from '@closurestudio/ui';

/** A route module a data route loads lazily: the router renders its `Component`. */
export function Component() {
  return (
    <Button agent={{ id: 'profile.edit', description: 'Edit the profile' }} onClick={() => {}}>
      Edit
    </Button>
  );
}
