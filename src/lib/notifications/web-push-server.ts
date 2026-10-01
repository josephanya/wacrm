import webPush from 'web-push';

import { supabaseAdmin } from '@/lib/automations/admin-client';
import {
  buildNotificationContent,
  conversationHref,
  type NotifiableMessage,
} from '@/lib/notifications/browser-notify';
import type { ContentType } from '@/types';

interface PushSubscriptionTarget {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface InboundMessagePushParams {
  accountId: string;
  conversationId: string;
  contactName: string | null;
  contentType: ContentType;
  contentText: string | null;
  excludeUserIds?: string[];
}

export interface InboundMessagePushPayload {
  title: string;
  body: string;
  tag: string;
  url: string;
}

let configured = false;

export function isWebPushConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_WEB_PUSH_VAPID_PUBLIC_KEY &&
    process.env.WEB_PUSH_VAPID_PRIVATE_KEY
  );
}

function configureWebPush(): boolean {
  if (!isWebPushConfigured()) return false;
  if (!configured) {
    webPush.setVapidDetails(
      process.env.WEB_PUSH_CONTACT_EMAIL || 'mailto:admin@example.com',
      process.env.NEXT_PUBLIC_WEB_PUSH_VAPID_PUBLIC_KEY!,
      process.env.WEB_PUSH_VAPID_PRIVATE_KEY!
    );
    configured = true;
  }
  return true;
}

export function buildInboundMessagePushPayload(
  params: InboundMessagePushParams
): InboundMessagePushPayload {
  const msg: NotifiableMessage = {
    id: params.conversationId,
    conversation_id: params.conversationId,
    sender_type: 'customer',
    content_type: params.contentType,
    content_text: params.contentText,
  };
  const content = buildNotificationContent(msg, params.contactName);

  return {
    title: content.title,
    body: content.body,
    tag: params.conversationId,
    url: conversationHref(params.conversationId),
  };
}

function isExpiredSubscriptionError(error: unknown): boolean {
  const statusCode = (error as { statusCode?: unknown })?.statusCode;
  return statusCode === 404 || statusCode === 410;
}

export async function sendInboundMessagePush(
  params: InboundMessagePushParams
): Promise<void> {
  if (!configureWebPush()) return;

  try {
    const admin = supabaseAdmin();
    const { data: conversation, error: conversationError } = await admin
      .from('conversations')
      .select('assigned_agent_id')
      .eq('id', params.conversationId)
      .eq('account_id', params.accountId)
      .maybeSingle();

    if (conversationError) {
      console.warn(
        '[web-push] failed to resolve conversation recipients:',
        conversationError
      );
      return;
    }

    const assignedAgentId = conversation?.assigned_agent_id as
      string | null | undefined;
    let recipientIds: string[] = assignedAgentId ? [assignedAgentId] : [];

    if (recipientIds.length === 0) {
      const { data: profiles, error: profileError } = await admin
        .from('profiles')
        .select('user_id')
        .eq('account_id', params.accountId)
        .in('account_role', ['owner', 'admin', 'agent']);

      if (profileError) {
        console.warn(
          '[web-push] failed to resolve account recipients:',
          profileError
        );
        return;
      }

      recipientIds = (profiles ?? [])
        .map((profile: { user_id?: string | null }) => profile.user_id)
        .filter((userId): userId is string => Boolean(userId));
    }

    const excluded = new Set(params.excludeUserIds ?? []);
    recipientIds = recipientIds.filter((userId) => !excluded.has(userId));
    if (recipientIds.length === 0) return;

    const { data: subscriptions, error: subscriptionError } = await admin
      .from('push_subscriptions')
      .select('id,user_id,endpoint,p256dh,auth')
      .eq('account_id', params.accountId)
      .in('user_id', recipientIds);

    if (subscriptionError) {
      console.warn(
        '[web-push] failed to load subscriptions:',
        subscriptionError
      );
      return;
    }
    if (!subscriptions || subscriptions.length === 0) return;

    const payload = JSON.stringify(buildInboundMessagePushPayload(params));

    await Promise.all(
      (subscriptions as PushSubscriptionTarget[]).map(async (subscription) => {
        try {
          await webPush.sendNotification(
            {
              endpoint: subscription.endpoint,
              keys: {
                p256dh: subscription.p256dh,
                auth: subscription.auth,
              },
            },
            payload
          );
        } catch (error) {
          if (isExpiredSubscriptionError(error)) {
            await admin
              .from('push_subscriptions')
              .delete()
              .eq('id', subscription.id);
            return;
          }

          console.warn('[web-push] delivery failed:', error);
        }
      })
    );
  } catch (error) {
    console.warn('[web-push] inbound push dispatch failed:', error);
  }
}
