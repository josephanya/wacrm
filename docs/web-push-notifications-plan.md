# Web Push Notifications Implementation Plan

## Task

Add Web Push support so agents can receive notifications for new inbound WhatsApp customer messages even when the browser tab is closed, while preserving the existing realtime/open-tab notification behavior.

## Context

This app is `wacrm`, a self-hosted WhatsApp CRM built with Next.js 16, React 19, TypeScript, Supabase, and Tailwind.

Current behavior:

- Inbound WhatsApp messages are processed in `src/app/api/whatsapp/webhook/route.ts`.
- New customer messages are inserted into the `messages` table.
- The app updates `conversations.unread_count` through the `bump_conversation_on_inbound` RPC.
- Open dashboard tabs receive changes through Supabase Realtime.
- Browser desktop notifications currently come from:
  - `src/hooks/use-browser-notifications.ts`
  - `src/lib/notifications/browser-notify.ts`
  - `src/components/notifications/browser-notifications-listener.tsx`
  - `src/components/settings/browser-notifications-card.tsx`
- Current browser notifications only work while a signed-in dashboard tab is open.
- There is no service worker, no Web Push subscription persistence, and no closed-browser notification delivery.

Important: read `AGENTS.md` first. This repo uses Next.js 16 and may differ from older Next.js conventions. Inspect `node_modules/next/dist/docs/` before changing Next-specific behavior if needed.

## Product Requirements

1. Agents can opt into push notifications from the existing profile notification settings.
2. When an inbound customer WhatsApp message arrives, eligible subscribed agents receive a Web Push notification.
3. Clicking the push notification opens the related conversation: `/inbox?c=<conversation_id>`.
4. Existing open-tab realtime notifications must continue working.
5. Avoid duplicate push sends caused by Meta webhook retries.
6. Expired or invalid push subscriptions must be cleaned up automatically.
7. The feature must be account-scoped and respect the app's multi-user account model.
8. Push must be optional and disabled unless VAPID env vars are configured.
9. Do not send pushes for outbound agent/bot messages.
10. Do not send pushes for WhatsApp reaction events, because those are not inserted into `messages`.
11. Keep implementation minimal and consistent with current code style.

## Architecture

Use the standard Web Push stack:

- Browser service worker receives push events.
- Client registers a push subscription using `PushManager`.
- Subscription is stored in Supabase.
- Server sends push notifications using VAPID credentials.
- On inbound WhatsApp message insert, server sends push to matching subscriptions.

Recommended npm package:

```bash
npm install web-push
npm install -D @types/web-push
```

## Environment Variables

Add to `.env.local.example`:

```env
# ------------------------------------------------------------------
# Web Push notifications (optional)
# ------------------------------------------------------------------
# Enables closed-browser push notifications for new inbound customer
# messages. Generate a VAPID keypair with:
#   npx web-push generate-vapid-keys
#
# The public key is exposed to the browser so agents can create push
# subscriptions. The private key stays server-side.
NEXT_PUBLIC_WEB_PUSH_VAPID_PUBLIC_KEY=
WEB_PUSH_VAPID_PRIVATE_KEY=
WEB_PUSH_CONTACT_EMAIL=mailto:admin@example.com
```

Behavior:

- If either `NEXT_PUBLIC_WEB_PUSH_VAPID_PUBLIC_KEY` or `WEB_PUSH_VAPID_PRIVATE_KEY` is missing, subscription UI should explain that push is unavailable.
- Server push sending should no-op safely when env vars are missing.

## Database Migration

Create a new Supabase migration, for example `supabase/migrations/0XX_push_subscriptions.sql`.

Suggested schema:

```sql
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, endpoint)
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_account
  ON push_subscriptions(account_id);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user
  ON push_subscriptions(user_id);

ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY push_subscriptions_select_own
  ON push_subscriptions FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY push_subscriptions_insert_own
  ON push_subscriptions FOR INSERT
  WITH CHECK (
    auth.uid() = user_id
    AND account_id = (
      SELECT account_id FROM profiles WHERE user_id = auth.uid()
    )
  );

CREATE POLICY push_subscriptions_update_own
  ON push_subscriptions FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (
    auth.uid() = user_id
    AND account_id = (
      SELECT account_id FROM profiles WHERE user_id = auth.uid()
    )
  );

CREATE POLICY push_subscriptions_delete_own
  ON push_subscriptions FOR DELETE
  USING (auth.uid() = user_id);
```

Also add or reuse an `updated_at` trigger if the repo already has a shared helper for that. Inspect existing migrations first and follow local patterns.

## Types

Update `src/types/index.ts` with a `PushSubscriptionRow` type, or use local typed shapes if this project does not centrally type every table.

Suggested type:

```ts
export interface PushSubscriptionRow {
  id: string;
  account_id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  user_agent: string | null;
  created_at: string;
  updated_at: string;
  last_seen_at: string;
}
```

## Service Worker

Add `public/sw.js`.

Behavior:

- Listen for `push`.
- Parse JSON payload safely.
- Show notification using `self.registration.showNotification`.
- Include `data.url`.
- On notification click:
  - close notification
  - focus an existing client matching the app origin if possible
  - otherwise open a new window to the URL

Example:

```js
self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }

  const title = payload.title || "New message";
  const options = {
    body: payload.body || "",
    icon: "/icon",
    badge: "/icon",
    tag: payload.tag || "wacrm-message",
    data: {
      url: payload.url || "/inbox",
    },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const targetUrl = new URL(
    event.notification.data?.url || "/inbox",
    self.location.origin,
  ).href;

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client && client.url.startsWith(self.location.origin)) {
          client.navigate(targetUrl);
          return client.focus();
        }
      }

      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    }),
  );
});
```

Keep this plain JavaScript because service workers are served from `public/`.

## Push Client Helpers

Add a client-side helper, for example `src/lib/notifications/web-push-client.ts`.

Responsibilities:

- Check support:
  - `serviceWorker` in `navigator`
  - `PushManager` in `window`
  - `Notification` in `window`
  - public VAPID key exists
- Register `/sw.js`.
- Convert VAPID public key from base64url to `Uint8Array`.
- Subscribe with `userVisibleOnly: true`.
- Send subscription to API route.
- Unsubscribe and tell API route to delete subscription.

Suggested functions:

- `isWebPushSupported()`
- `getWebPushAvailability()`
- `subscribeToWebPush()`
- `unsubscribeFromWebPush()`
- `getExistingPushSubscription()`

Be careful: browser `PushSubscription` JSON contains `endpoint`, `keys.p256dh`, and `keys.auth`.

## API Routes

Add `src/app/api/push/subscribe/route.ts`.

Methods:

- `POST`
- `DELETE`

Use the existing Supabase server/client auth patterns in the repo. Inspect nearby authenticated API routes before implementing.

POST behavior:

1. Require signed-in user.
2. Resolve their `account_id` from `profiles`.
3. Validate request body:
   - `endpoint`
   - `keys.p256dh`
   - `keys.auth`
4. Upsert into `push_subscriptions` on `(user_id, endpoint)`.
5. Store `user_agent` from request headers.
6. Update `last_seen_at` and `updated_at`.
7. Return success.

DELETE behavior:

1. Require signed-in user.
2. Accept `endpoint`.
3. Delete matching row where `user_id = auth.uid()` and `endpoint = endpoint`.
4. Return success.

Do not expose the private VAPID key to the client.

## Server Push Sender

Add `src/lib/notifications/web-push-server.ts`.

Responsibilities:

- Configure `web-push` with VAPID details.
- Determine if push is configured.
- Build payload.
- Send to all target subscriptions.
- Delete expired subscriptions on `404` or `410`.
- Log but do not throw for individual delivery failures.

Suggested functions:

```ts
export function isWebPushConfigured(): boolean;

export async function sendInboundMessagePush(params: {
  accountId: string;
  conversationId: string;
  contactName: string | null;
  contentType: string;
  contentText: string | null;
  excludeUserIds?: string[];
}): Promise<void>;
```

Recipient selection:

- Start conservative and predictable:
  - If `conversations.assigned_agent_id` is set, notify only that user.
  - If unassigned, notify all active account members with roles `owner`, `admin`, or `agent`.
  - Do not notify `viewer`.
- To do this, inspect the actual account membership schema in migrations/types before coding. There may be `profiles.account_id` and role fields or separate account member tables.

Payload:

```ts
{
  title: contactName || "New message",
  body: formattedBody,
  tag: conversationId,
  url: `/inbox?c=${conversationId}`,
}
```

Formatting:

- Reuse logic from `src/lib/notifications/browser-notify.ts` where possible.
- That file currently contains pure formatter functions like `buildNotificationContent`.
- Avoid duplicating notification text rules.

Important:

- Web Push payload size is limited. Keep the JSON small.
- Do not include secrets or full customer data beyond what is necessary for the alert.
- It is acceptable to include a truncated message preview.

## Hook Into WhatsApp Webhook

Modify `src/app/api/whatsapp/webhook/route.ts`.

Location: after the inbound message is successfully inserted and the duplicate replay check has passed.

There is already an idempotency boundary:

```ts
const { data: insertedRows, error: msgError } = await supabaseAdmin()
  .from('messages')
  .upsert(..., { onConflict: 'conversation_id,message_id', ignoreDuplicates: true })
  .select('id')

if (!insertedRows || insertedRows.length === 0) {
  return
}
```

Only send push after this check, so Meta retries do not create duplicate push alerts.

Suggested call location:

- After message insert replay check
- After conversation unread bump
- Maybe after `reopenClosedConversation`
- Before potentially slower automations if the push helper is bounded and handles errors internally

Example call:

```ts
await sendInboundMessagePush({
  accountId,
  conversationId: conversation.id,
  contactName: identityDisplayName(identity) ?? contactRecord.name ?? contactRecord.phone ?? null,
  contentType,
  contentText,
});
```

Inspect actual contact fields before writing this exact expression.

Do not let push failure break webhook handling. `sendInboundMessagePush` should catch internally, or the webhook should wrap it with `.catch(...)`.

## Settings UI

Update `src/components/settings/browser-notifications-card.tsx`.

Current behavior:

- Enables local browser notifications via localStorage.
- Requests notification permission.
- Sends test notification with `new Notification`.

New behavior:

- Keep current open-tab notification preference.
- Add Web Push subscription setup when enabling notifications.
- If Web Push is unsupported or VAPID public key is missing, fall back to current open-tab notifications and show a concise status.
- If service worker registration or subscription fails, show a toast and keep the local open-tab setting if permission was granted.

Suggested UX:

- Same card, same switch.
- Text can say notifications work while dashboard is open, and closed-browser alerts require push support/configuration.
- Add a small status line:
  - `Push enabled on this device`
  - `Browser permission denied`
  - `Push is not configured on this server`
  - `This browser does not support push notifications`

Avoid adding a separate page unless needed.

## Avoiding Duplicate Alerts

Expected behavior:

- Open dashboard tab: existing realtime browser notification can fire.
- Closed browser: Web Push fires.

Potential duplicate:

- If a tab is open and Web Push also fires, users may get two notifications.

Choose one of these strategies.

Option A, simpler:

- Accept possible duplication initially.
- Browser notification uses `tag: conversation_id`, push notification uses the same tag, so many browsers replace rather than stack.

Option B, better:

- Track presence using the existing `PresenceHeartbeat`.
- Server excludes users currently online/active from Web Push.
- Only send push to offline/away users.
- Requires inspecting `src/components/presence/presence-heartbeat.tsx`, `src/hooks/use-presence.ts`, and `src/lib/presence.ts`.

For the first implementation, use Option A unless the existing presence implementation makes Option B trivial and reliable.

## Security And RLS

- Clients may only manage their own subscriptions.
- Server-side webhook uses service role, so recipient selection and send can bypass RLS as needed.
- Never return the private VAPID key.
- Validate subscription payload shape.
- Avoid storing duplicate subscriptions.
- Do not include sensitive message metadata in push payloads.

## Tests

Add focused tests where practical.

Suggested tests:

1. `src/lib/notifications/web-push-server.test.ts`
   - no-op when env vars missing
   - formats payload correctly
   - deletes subscription on `404` or `410`
   - does not throw if one subscription fails
2. `src/lib/notifications/browser-notify.test.ts`
   - if formatter changes, preserve existing behavior
3. API route tests if this repo already tests route handlers:
   - unauthenticated subscribe returns `401`
   - malformed body returns `400`
   - valid subscribe upserts

Run:

```bash
npm run typecheck
npm run test
```

Also run lint if changes are broad:

```bash
npm run lint
```

## Documentation

Update:

- `.env.local.example`
- `README.md` or relevant docs page if deployment docs mention notifications
- Possibly `docs/docker.md` to note that Web Push requires VAPID env vars and HTTPS in production

Include how to generate VAPID keys:

```bash
npx web-push generate-vapid-keys
```

Also include:

- Which env vars to set
- Browser support caveat, especially iOS/Safari differences
- HTTPS requirement

## Acceptance Criteria

- Agent can enable notifications from profile settings.
- Browser permission is requested.
- Service worker is registered.
- Push subscription is saved in Supabase.
- New inbound WhatsApp customer message triggers push delivery after the message insert idempotency check.
- Clicking notification opens the correct inbox conversation.
- Invalid/expired subscriptions are removed.
- Existing realtime open-tab notifications still work.
- Missing VAPID config does not break the app.
- Typecheck and relevant tests pass.

## Recommended Implementation Order

1. Add VAPID env docs.
2. Add migration for `push_subscriptions`.
3. Add service worker.
4. Add client helper and subscription API route.
5. Extend the settings card so a developer can test subscription creation.
6. Add server sender helper and unit tests.
7. Wire the sender into the WhatsApp webhook after the idempotent insert check.
8. Run typecheck and tests.

Implement this in two passes if possible: first add the subscription/storage/service-worker path and a test notification path that proves closed-browser push works, then wire it into the WhatsApp webhook. This separates browser push setup problems from inbound-message recipient-selection problems.
