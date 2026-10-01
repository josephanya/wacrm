import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  sendNotification: vi.fn(),
  setVapidDetails: vi.fn(),
  deleteIds: [] as string[],
  conversation: { assigned_agent_id: null as string | null },
  profiles: [{ user_id: 'agent-1' }, { user_id: 'viewer-filtered-upstream' }],
  subscriptions: [
    {
      id: 'sub-1',
      user_id: 'agent-1',
      endpoint: 'https://push.example/1',
      p256dh: 'p256dh',
      auth: 'auth',
    },
  ],
}));

vi.mock('web-push', () => ({
  default: {
    sendNotification: h.sendNotification,
    setVapidDetails: h.setVapidDetails,
  },
}));

vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: () => ({
    from(table: string) {
      if (table === 'conversations') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: () =>
                  Promise.resolve({ data: h.conversation, error: null }),
              }),
            }),
          }),
        };
      }

      if (table === 'profiles') {
        return {
          select: () => ({
            eq: () => ({
              in: () => Promise.resolve({ data: h.profiles, error: null }),
            }),
          }),
        };
      }

      if (table === 'push_subscriptions') {
        return {
          select: () => ({
            eq: () => ({
              in: () => Promise.resolve({ data: h.subscriptions, error: null }),
            }),
          }),
          delete: () => ({
            eq: (_column: string, id: string) => {
              h.deleteIds.push(id);
              return Promise.resolve({ error: null });
            },
          }),
        };
      }

      throw new Error(`unexpected table ${table}`);
    },
  }),
}));

async function loadModule() {
  vi.resetModules();
  return import('./web-push-server');
}

describe('web push server notifications', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.deleteIds = [];
    h.conversation = { assigned_agent_id: null };
    h.profiles = [{ user_id: 'agent-1' }];
    h.subscriptions = [
      {
        id: 'sub-1',
        user_id: 'agent-1',
        endpoint: 'https://push.example/1',
        p256dh: 'p256dh',
        auth: 'auth',
      },
    ];
    delete process.env.NEXT_PUBLIC_WEB_PUSH_VAPID_PUBLIC_KEY;
    delete process.env.WEB_PUSH_VAPID_PRIVATE_KEY;
    delete process.env.WEB_PUSH_CONTACT_EMAIL;
  });

  it('no-ops when VAPID is missing', async () => {
    const { sendInboundMessagePush } = await loadModule();

    await sendInboundMessagePush({
      accountId: 'acc-1',
      conversationId: 'conv-1',
      contactName: 'Ada',
      contentType: 'text',
      contentText: 'Hello',
    });

    expect(h.sendNotification).not.toHaveBeenCalled();
    expect(h.setVapidDetails).not.toHaveBeenCalled();
  });

  it('formats a compact conversation payload', async () => {
    const { buildInboundMessagePushPayload } = await loadModule();

    expect(
      buildInboundMessagePushPayload({
        accountId: 'acc-1',
        conversationId: 'conv-1',
        contactName: 'Ada',
        contentType: 'image',
        contentText: 'See this',
      })
    ).toEqual({
      title: 'Ada',
      body: '📷 Photo · See this',
      tag: 'conv-1',
      url: '/inbox?c=conv-1',
    });
  });

  it('sends to matching subscriptions when configured', async () => {
    process.env.NEXT_PUBLIC_WEB_PUSH_VAPID_PUBLIC_KEY = 'public-key';
    process.env.WEB_PUSH_VAPID_PRIVATE_KEY = 'private-key';
    const { sendInboundMessagePush } = await loadModule();

    await sendInboundMessagePush({
      accountId: 'acc-1',
      conversationId: 'conv-1',
      contactName: 'Ada',
      contentType: 'text',
      contentText: 'Hello',
    });

    expect(h.setVapidDetails).toHaveBeenCalledWith(
      'mailto:admin@example.com',
      'public-key',
      'private-key'
    );
    expect(h.sendNotification).toHaveBeenCalledTimes(1);
    expect(h.sendNotification.mock.calls[0][0]).toEqual({
      endpoint: 'https://push.example/1',
      keys: { p256dh: 'p256dh', auth: 'auth' },
    });
  });

  it('deletes expired subscriptions and keeps going', async () => {
    process.env.NEXT_PUBLIC_WEB_PUSH_VAPID_PUBLIC_KEY = 'public-key';
    process.env.WEB_PUSH_VAPID_PRIVATE_KEY = 'private-key';
    h.subscriptions = [
      {
        id: 'expired',
        user_id: 'agent-1',
        endpoint: 'https://push.example/expired',
        p256dh: 'p256dh',
        auth: 'auth',
      },
      {
        id: 'ok',
        user_id: 'agent-1',
        endpoint: 'https://push.example/ok',
        p256dh: 'p256dh2',
        auth: 'auth2',
      },
    ];
    h.sendNotification
      .mockRejectedValueOnce(
        Object.assign(new Error('gone'), { statusCode: 410 })
      )
      .mockResolvedValueOnce(undefined);
    const { sendInboundMessagePush } = await loadModule();

    await sendInboundMessagePush({
      accountId: 'acc-1',
      conversationId: 'conv-1',
      contactName: null,
      contentType: 'text',
      contentText: 'Hello',
    });

    expect(h.sendNotification).toHaveBeenCalledTimes(2);
    expect(h.deleteIds).toEqual(['expired']);
  });
});
