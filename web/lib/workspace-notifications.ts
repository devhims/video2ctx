import type { DashboardNotification } from './dashboard-data';

export function visibleWorkspaceNotifications(notifications: DashboardNotification[], monitorAlertsEnabled: boolean) {
  return notifications.filter((notification) => monitorAlertsEnabled || notification.type === 'billing_attention');
}

export function workspaceNotificationPath(notification: DashboardNotification): string {
  if (notification.type === 'billing_attention') return '/dashboard/settings';
  try {
    const data = JSON.parse(notification.data_json);
    if (typeof data?.videoId === 'string') return `/dashboard/sources?type=video&id=${encodeURIComponent(data.videoId)}`;
  } catch {}
  return '/dashboard/monitors';
}
