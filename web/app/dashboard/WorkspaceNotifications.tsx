'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAccountResource } from './DashboardDataProvider';
import { DEFAULT_NOTIFICATION_PREFERENCES, type DashboardNotification } from '../../lib/dashboard-data';
import { platformRequest as api } from '../../lib/platform-request';
import { Icon } from './DashboardSidebar';
export function WorkspaceNotifications() {
  const router = useRouter();
  const { data: notifications, setData: setNotifications } = useAccountResource('notifications', []);
  const { data: preferences } = useAccountResource('notificationPreferences', DEFAULT_NOTIFICATION_PREFERENCES);
  const read = async (id: string) => {
    const before = notifications.find((n) => n.id === id)?.read_at;
    setNotifications((items) => items.map((n) => (n.id === id ? { ...n, read_at: Date.now() } : n)));
    try {
      await api(`/v1/notifications/${encodeURIComponent(id)}/read`, { method: 'POST' });
    } catch {
      setNotifications((items) => items.map((n) => (n.id === id ? { ...n, read_at: before } : n)));
    }
  };
  return (
    <NotificationMenu
      notifications={notifications}
      enabled={preferences.inApp}
      onSettings={() => router.push('/dashboard/settings')}
      onMarkAll={() => void Promise.all(notifications.filter((n) => !n.read_at).map((n) => read(n.id)))}
      onOpen={(n) => {
        if (!n.read_at) void read(n.id);
        let data: { videoId?: string } = {};
        try {
          data = JSON.parse(n.data_json);
        } catch {}
        router.push(
          data.videoId ? `/dashboard/sources?type=video&id=${encodeURIComponent(data.videoId)}` : '/dashboard/monitors',
        );
      }}
    />
  );
}
function NotificationMenu({
  notifications,
  enabled,
  onOpen,
  onMarkAll,
  onSettings,
}: {
  notifications: DashboardNotification[];
  enabled: boolean;
  onOpen: (notification: DashboardNotification) => void;
  onMarkAll: () => void;
  onSettings: () => void;
}) {
  const [open, setOpen] = useState(false);
  const unread = enabled ? notifications.filter((notification) => !notification.read_at).length : 0;

  return (
    <div className='notification-menu'>
      <button
        className='notification-trigger'
        aria-label={unread ? `${unread} unread notifications` : 'Notifications'}
        aria-expanded={open}
        aria-haspopup='dialog'
        onClick={() => setOpen((current) => !current)}
      >
        <Icon name='bell' size={17} />
        {unread > 0 && <span>{unread > 9 ? '9+' : unread}</span>}
      </button>
      {open && (
        <section className='notification-popover' role='dialog' aria-label='Notifications'>
          <header>
            <div>
              <strong>Notifications</strong>
              <small>
                {enabled ? (unread ? `${unread} unread` : 'You’re all caught up') : 'In-app alerts are off'}
              </small>
            </div>
            {enabled && unread > 0 && <button onClick={onMarkAll}>Mark all read</button>}
          </header>
          {!enabled ? (
            <div className='notification-empty'>
              <p>Turn on in-app alerts to see new monitor matches here.</p>
              <button
                onClick={() => {
                  setOpen(false);
                  onSettings();
                }}
              >
                Open settings
              </button>
            </div>
          ) : notifications.length ? (
            <div className='notification-list'>
              {notifications.slice(0, 8).map((notification) => (
                <button
                  key={notification.id}
                  data-unread={!notification.read_at}
                  onClick={() => {
                    setOpen(false);
                    onOpen(notification);
                  }}
                >
                  <i aria-hidden='true' />
                  <span>
                    <strong>{notification.title}</strong>
                    <small>{notification.body}</small>
                    <time>{relativeNotificationTime(notification.created_at)}</time>
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <div className='notification-empty'>
              <p>New videos found by your monitors will appear here.</p>
            </div>
          )}
          <footer>
            <button
              onClick={() => {
                setOpen(false);
                onSettings();
              }}
            >
              Notification settings
            </button>
          </footer>
        </section>
      )}
    </div>
  );
}

function relativeNotificationTime(timestamp: number) {
  const elapsed = Math.max(0, Date.now() - timestamp);
  if (elapsed < 60_000) return 'Just now';
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  return `${Math.floor(elapsed / 86_400_000)}d ago`;
}
