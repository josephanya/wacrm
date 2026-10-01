'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import { Bell, BellRing, CircleAlert, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { useBrowserNotifyPref } from '@/hooks/use-browser-notifications';
import {
  BROWSER_NOTIFY_CHANGE_EVENT,
  getNotificationPermission,
  writeBrowserNotifyPref,
  type BrowserNotifyPermission,
} from '@/lib/notifications/browser-notify';
import {
  getExistingPushSubscription,
  getWebPushAvailability,
  subscribeToWebPush,
  unsubscribeFromWebPush,
  type WebPushAvailability,
} from '@/lib/notifications/web-push-client';

// `Notification.permission` has no change event of its own. Re-read it
// whenever the tab regains focus (the user may have flipped the site
// setting in the browser UI) and whenever our own preference changes
// (right after requestPermission resolves).
function subscribePermission(onChange: () => void): () => void {
  window.addEventListener('focus', onChange);
  document.addEventListener('visibilitychange', onChange);
  window.addEventListener(BROWSER_NOTIFY_CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener('focus', onChange);
    document.removeEventListener('visibilitychange', onChange);
    window.removeEventListener(BROWSER_NOTIFY_CHANGE_EVENT, onChange);
  };
}

const serverPermission = (): BrowserNotifyPermission => 'unsupported';
const SERVER_PUSH_UNSUPPORTED: WebPushAvailability = {
  supported: false,
  reason: 'unsupported',
};
const serverPushAvailability = (): WebPushAvailability =>
  SERVER_PUSH_UNSUPPORTED;

type PushStatus =
  'checking' | 'enabled' | 'disabled' | 'not-configured' | 'unsupported';

/**
 * "Browser notifications" card — device-scoped opt-in for desktop
 * alerts about new customer messages (issue #516). Persistence is
 * localStorage; the browser's own permission grant is the real gate,
 * so the switch reads as off whenever that grant is missing.
 */
export function BrowserNotificationsCard({
  className,
}: {
  className?: string;
}) {
  const t = useTranslations('Settings.browserNotifications');
  const enabled = useBrowserNotifyPref();
  const permission = useSyncExternalStore(
    subscribePermission,
    getNotificationPermission,
    serverPermission
  );
  const pushAvailability = useSyncExternalStore(
    subscribePermission,
    getWebPushAvailability,
    serverPushAvailability
  );
  const [requesting, setRequesting] = useState(false);
  const [pushStatus, setPushStatus] = useState<PushStatus>('checking');

  const supported = permission !== 'unsupported';
  const checked = enabled && permission === 'granted';

  useEffect(() => {
    let cancelled = false;

    if (!pushAvailability.supported) {
      setPushStatus(pushAvailability.reason);
      return;
    }

    getExistingPushSubscription()
      .then((subscription) => {
        if (!cancelled) setPushStatus(subscription ? 'enabled' : 'disabled');
      })
      .catch(() => {
        if (!cancelled) setPushStatus('disabled');
      });

    return () => {
      cancelled = true;
    };
  }, [pushAvailability]);

  const onToggle = async (next: boolean) => {
    if (!next) {
      writeBrowserNotifyPref(false);
      await unsubscribeFromWebPush();
      setPushStatus(
        pushAvailability.supported ? 'disabled' : pushAvailability.reason
      );
      return;
    }
    if (permission === 'granted') {
      writeBrowserNotifyPref(true);
      if (pushAvailability.supported) {
        try {
          await subscribeToWebPush();
          setPushStatus('enabled');
        } catch {
          setPushStatus('disabled');
          toast.error(t('pushSubscribeFailed'));
        }
      }
      return;
    }
    if (permission === 'denied') {
      toast.error(t('statusDenied'), { description: t('deniedHint') });
      return;
    }
    setRequesting(true);
    try {
      const result = await Notification.requestPermission();
      // Also dispatches the change event, which refreshes `permission`.
      writeBrowserNotifyPref(result === 'granted');
      if (result === 'granted' && pushAvailability.supported) {
        try {
          await subscribeToWebPush();
          setPushStatus('enabled');
        } catch {
          setPushStatus('disabled');
          toast.error(t('pushSubscribeFailed'));
        }
      }
      if (result === 'denied') {
        toast.error(t('permissionDeniedToast'), {
          description: t('deniedHint'),
        });
      }
    } finally {
      setRequesting(false);
    }
  };

  const sendTest = () => {
    try {
      new Notification(t('testTitle'), {
        body: t('testBody'),
        icon: '/icon',
        tag: 'wacrm-test-notification',
      });
    } catch {
      toast.error(t('unsupported'));
    }
  };

  const statusKey =
    permission === 'granted'
      ? 'statusGranted'
      : permission === 'denied'
        ? 'statusDenied'
        : 'statusDefault';

  const pushStatusKey =
    pushStatus === 'enabled'
      ? 'pushEnabled'
      : pushStatus === 'not-configured'
        ? 'pushNotConfigured'
        : pushStatus === 'unsupported'
          ? 'pushUnsupported'
          : 'pushDisabled';

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle className="text-foreground flex items-center gap-2">
          <Bell className="text-muted-foreground size-4" />
          {t('title')}
        </CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!supported ? (
          <p className="text-muted-foreground flex items-center gap-2 text-sm">
            <CircleAlert className="size-4 shrink-0" />
            {t('unsupported')}
          </p>
        ) : (
          <>
            <div className="border-border flex items-center justify-between gap-4 rounded-md border p-3">
              <div className="min-w-0">
                <p className="text-foreground text-sm font-medium">
                  {t('toggleLabel')}
                </p>
                <p className="text-muted-foreground text-xs">
                  {t('toggleDesc')}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {requesting && (
                  <Loader2 className="text-muted-foreground size-4 animate-spin" />
                )}
                <Switch
                  checked={checked}
                  onCheckedChange={(next) => void onToggle(next)}
                  disabled={requesting || permission === 'denied'}
                  aria-label={t('toggleLabel')}
                />
              </div>
            </div>

            <p className="text-muted-foreground text-xs">{t(statusKey)}</p>
            <p className="text-muted-foreground text-xs">{t(pushStatusKey)}</p>

            {permission === 'denied' && (
              <p className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
                <span>{t('deniedHint')}</span>
              </p>
            )}

            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={sendTest}
              disabled={!checked}
            >
              <BellRing className="size-4" />
              {t('sendTest')}
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}
