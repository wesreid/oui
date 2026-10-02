/**
 * The fixture app on the broken design system (ADR-0226 §3.2, the fourth
 * rule): its page is the same source, so its generated manifest is the same,
 * but the broken `Button` drops the binding of a ghost button. The manifest
 * then declares an action no state of the page mounts, which the kit reports
 * once.
 */
import { describe, expect, it, vi } from 'vitest';

import { checkApp, formatReport } from '../src/index';
import { OrdersPage } from './fixtures/app/src/OrdersPage';
import { fixtureManifest } from './support/app-manifest';

vi.mock('@kit/ds', () => import('./fixtures/broken-ds/index'));

describe('the broken fixtures fail each rule once', () => {
  it('the app on the broken design system fails actions-mounted once', async () => {
    const report = await checkApp({
      name: 'the fixture app on the broken design system',
      manifest: await fixtureManifest(),
      pages: { 'page:OrdersPage': [<OrdersPage key="none" />, <OrdersPage key="open" order={{ id: 'o-1' }} />] },
    });
    expect(report.violations, formatReport(report)).toEqual([
      {
        rule: 'actions-mounted',
        subject: 'page:OrdersPage orders_cancel',
        message: 'declares the control orders.cancel, and no state of the page mounts a handler for it',
      },
    ]);
  });
});
