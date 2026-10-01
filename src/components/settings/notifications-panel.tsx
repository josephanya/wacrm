'use client';

import { useTranslations } from 'next-intl';

import { BrowserNotificationsCard } from './browser-notifications-card';
import { SettingsPanelHead } from './settings-panel-head';

export function NotificationsPanel() {
  const t = useTranslations('Settings.notifications');

  return (
    <section className="animate-in fade-in-50 max-w-2xl duration-200">
      <SettingsPanelHead title={t('title')} description={t('description')} />
      <BrowserNotificationsCard />
    </section>
  );
}
