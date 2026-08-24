import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { selectRefreshableKeys } from '../src/cron.js';
import { createDeviceIdentity, deviceColumns } from '../src/deviceIdentity.js';

const withOwnDevice = (id) => ({ id, theater_name: `own-${id}`, ...deviceColumns(createDeviceIdentity()) });
const onSharedDevice = (id) => ({ id, theater_name: `shared-${id}`, device_id: null, device_privkey: null });

describe('Nightly refresh selection', () => {
  // Вход за одну кассу с общего устройства обнуляет сессию предыдущей, поэтому
  // такие кассы прогон обязан пропускать — иначе он их же и убивает.
  it('skips cashiers still on the shared device', () => {
    const rows = [onSharedDevice(1), withOwnDevice(2), onSharedDevice(3), withOwnDevice(4)];
    assert.deepEqual(
      selectRefreshableKeys(rows).map((r) => r.id),
      [2, 4],
    );
  });

  it('refreshes nothing when no cashier has its own device', () => {
    assert.deepEqual(selectRefreshableKeys([onSharedDevice(1), onSharedDevice(2)]), []);
  });

  it('treats a half-written device row as shared, not as its own', () => {
    const rows = [
      { id: 1, device_id: 'D-1', device_privkey: null },
      { id: 2, device_id: null, device_privkey: 'enc' },
    ];
    assert.deepEqual(selectRefreshableKeys(rows), []);
  });
});
