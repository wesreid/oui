import { Outlet } from 'react-router';
import { Button } from '@closurestudio/ui';

/** A layout route's element: rendered around every settings page. */
export function SettingsLayout() {
  return (
    <div>
      <Button agent={{ id: 'settings.help', description: 'Open the settings help' }} onClick={() => {}}>
        Help
      </Button>
      <Outlet />
    </div>
  );
}
