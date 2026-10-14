import assert from 'node:assert/strict';
import { test } from 'node:test';
import { visibleWorkspaceNotifications, workspaceNotificationPath } from './workspace-notifications.ts';
import type { DashboardNotification } from './dashboard-data.ts';

const monitor: DashboardNotification = { id: 'monitor', type: 'monitor_match', title: '', body: '', data_json: '{"videoId":"video-1"}', created_at: 0 };
const billing: DashboardNotification = { ...monitor, id: 'billing', type: 'billing_attention', data_json: '{}' };

test('billing attention remains visible when monitor alerts are disabled', () => {
  assert.deepEqual(visibleWorkspaceNotifications([monitor, billing], false), [billing]);
  assert.deepEqual(visibleWorkspaceNotifications([monitor, billing], true), [monitor, billing]);
});
test('billing notifications open settings while monitor notifications retain their destination', () => {
  assert.equal(workspaceNotificationPath(billing), '/dashboard/settings');
  assert.equal(workspaceNotificationPath(monitor), '/dashboard/sources?type=video&id=video-1');
  assert.equal(workspaceNotificationPath({ ...monitor, data_json: 'broken' }), '/dashboard/monitors');
});
