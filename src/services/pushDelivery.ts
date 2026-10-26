/**
 * Push delivery for stored notifications — the one place a push is sent from.
 *
 * ── The inbox is the source of truth ────────────────────────────────────────
 * A notification exists because its Notification document exists. A push is a
 * best-effort announcement of a document that is already stored; when push
 * fails, is disabled, or the device has no token, the inbox is still right.
 *
 * ── Once per notification ───────────────────────────────────────────────────
 * Each document is CLAIMED before it is pushed (`pushedAt` set atomically where
 * it was unset). A producer that runs twice over the same documents — a retried
 * job, a second call — pushes nothing the second time.
 *
 * ── Where it goes ───────────────────────────────────────────────────────────
 * The recipient's registered installations (PushDevice — organization apps)
 * and, unchanged, the legacy app's single `User.pushToken`. Duplicates are
 * removed, so a token present in both places is sent one message.
 *
 * ── What it may say ─────────────────────────────────────────────────────────
 * A push travels through Expo and FCM and lands on a lock screen. It carries the
 * notification's title, a body with marks withheld (homework grades, …), and
 * only the ids the app needs to open the right screen — which then loads the
 * protected detail through the authenticated API.
 *
 * ── When Expo says no ───────────────────────────────────────────────────────
 * DeviceNotRegistered: the token is dead — removed from PushDevice and cleared
 * from User.pushToken. InvalidCredentials: the organization's build has no FCM
 * key attached in EAS — recorded on its devices so the console can say so.
 */

import {
  Expo,
  type ExpoPushMessage,
  type ExpoPushTicket,
} from 'expo-server-sdk';
import mongoose from 'mongoose';
import Notification from '../models/Notification';
import PushDevice from '../models/PushDevice';
import User from '../models/User';
import { withoutTenantScope } from '../core/tenancy/context';

let expo = new Expo();

/** Tests swap the Expo client for a recorder; nothing else should. */
export function __setExpoClient(
  client: Pick<
    Expo,
    'sendPushNotificationsAsync' | 'chunkPushNotifications'
  > | null,
): void {
  expo = (client as Expo) ?? new Expo();
}

/** Payload keys the apps route on. Anything else stays in the authenticated inbox. */
const ROUTING_KEYS = [
  'type',
  'role',
  'screen',
  'examId',
  'attemptId',
  'testId',
  'date',
  'doubtId',
  'homeworkId',
  'materialId',
  'leaveId',
] as const;

/** Events whose text carries a mark: the push says something is ready, not what it is. */
const WITHHELD_BODY: Record<string, string> = {
  homework_graded: 'Your homework has been graded. Open the app to see it.',
};

export interface StoredNotification {
  _id: unknown;
  userId: unknown;
  title: string;
  message?: string | null;
  data?: Record<string, unknown> | null;
}

/** Pure: the push for one stored notification. */
export function pushContentFor(doc: StoredNotification): {
  title: string;
  body: string;
  data: Record<string, string>;
} {
  const source = (doc.data ?? {}) as Record<string, unknown>;
  const data: Record<string, string> = { notificationId: String(doc._id) };
  for (const key of ROUTING_KEYS) {
    const value = source[key];
    if (value === null || value === undefined || value === '') continue;
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      value instanceof mongoose.Types.ObjectId
    ) {
      data[key] = String(value);
    }
  }
  const event = data.type ?? '';
  const body = WITHHELD_BODY[event] ?? String(doc.message ?? '');
  return { title: String(doc.title ?? ''), body, data };
}

/** Pure: one message per (notification, token), never the same token twice for one notification. */
export function messagesFor(
  docs: StoredNotification[],
  tokensByUser: Map<string, string[]>,
): Array<{ message: ExpoPushMessage; token: string; notificationId: string }> {
  const out: Array<{
    message: ExpoPushMessage;
    token: string;
    notificationId: string;
  }> = [];
  for (const doc of docs) {
    const tokens = [
      ...new Set(tokensByUser.get(String(doc.userId)) ?? []),
    ].filter((t) => Expo.isExpoPushToken(t));
    const content = pushContentFor(doc);
    for (const token of tokens) {
      out.push({
        token,
        notificationId: String(doc._id),
        message: {
          to: token,
          sound: 'default',
          priority: 'high',
          channelId: 'default',
          ...content,
        },
      });
    }
  }
  return out;
}

/** Every token a set of users can be reached on: their installations, plus the legacy single token. */
async function tokensFor(userIds: string[]): Promise<Map<string, string[]>> {
  const ids = [...new Set(userIds)].filter((id) =>
    mongoose.isValidObjectId(id),
  );
  const map = new Map<string, string[]>();
  if (!ids.length) return map;
  const add = (uid: string, token: unknown) => {
    if (typeof token !== 'string' || !token) return;
    const list = map.get(uid) ?? [];
    list.push(token);
    map.set(uid, list);
  };
  const [devices, users] = await Promise.all([
    PushDevice.find({ userId: { $in: ids } })
      .select('userId token')
      .lean(),
    User.find({ _id: { $in: ids } })
      .select('_id pushToken')
      .lean(),
  ]);
  for (const d of devices) add(String(d.userId), d.token);
  for (const u of users)
    add(String(u._id), (u as { pushToken?: string }).pushToken);
  return map;
}

/** What Expo said about each token, acted on. */
async function handleTickets(
  sent: Array<{ token: string; ticket: ExpoPushTicket | undefined }>,
): Promise<void> {
  const dead: string[] = [];
  const noCredentials: string[] = [];
  for (const { token, ticket } of sent) {
    if (!ticket || ticket.status !== 'error') continue;
    const code = (ticket as { details?: { error?: string } }).details?.error;
    if (code === 'DeviceNotRegistered') dead.push(token);
    else if (code === 'InvalidCredentials') noCredentials.push(token);
  }
  // Cleanup is about a physical token, wherever it is registered — not a read
  // of anybody's data — so it runs outside any one organization's scope.
  await withoutTenantScope('push:ticket-cleanup', async () => {
    if (dead.length) {
      await PushDevice.deleteMany({ token: { $in: dead } });
      await User.updateMany(
        { pushToken: { $in: dead } },
        { $unset: { pushToken: '' } },
      );
    }
    if (noCredentials.length) {
      await PushDevice.updateMany(
        { token: { $in: noCredentials } },
        { $set: { lastError: 'InvalidCredentials', lastErrorAt: new Date() } },
      );
      console.warn(
        `[push] Expo reported InvalidCredentials for ${noCredentials.length} device(s): the organization build's EAS project has no FCM key attached.`,
      );
    }
  });
}

/**
 * Push each stored notification once. Never throws: a push problem must not
 * fail the request or job that stored the notification.
 */
export async function pushNotifications(
  docs: StoredNotification[],
): Promise<{ claimed: number; sent: number }> {
  try {
    if (!docs.length) return { claimed: 0, sent: 0 };
    const ids = docs.map((d) => d._id);
    // Claim: one update stamps every document nobody has pushed, with this
    // call's own claim id; a concurrent or repeated call stamps none of them
    // (the condition is evaluated atomically per document), so reading back
    // our claim id yields exactly the documents this call may push.
    const claimId = new mongoose.Types.ObjectId().toHexString();
    await Notification.updateMany(
      { _id: { $in: ids }, pushedAt: null },
      { $set: { pushedAt: new Date(), pushClaim: claimId } },
    );
    const claimed = await Notification.find({
      _id: { $in: ids },
      pushClaim: claimId,
    })
      .select('_id')
      .lean();
    if (!claimed.length) return { claimed: 0, sent: 0 };
    const mine = new Set(claimed.map((c) => String(c._id)));
    const ours = docs.filter((d) => mine.has(String(d._id)));

    const tokens = await tokensFor(ours.map((d) => String(d.userId)));
    const outgoing = messagesFor(ours, tokens);
    if (!outgoing.length) return { claimed: ours.length, sent: 0 };

    const sent: Array<{ token: string; ticket: ExpoPushTicket | undefined }> =
      [];
    let offset = 0;
    for (const chunk of expo.chunkPushNotifications(
      outgoing.map((o) => o.message),
    )) {
      const slice = outgoing.slice(offset, offset + chunk.length);
      offset += chunk.length;
      try {
        const tickets = await expo.sendPushNotificationsAsync(chunk);
        slice.forEach((o, i) =>
          sent.push({ token: o.token, ticket: tickets[i] }),
        );
      } catch (error) {
        console.error(
          '[push] chunk failed:',
          (error as Error)?.message ?? error,
        );
      }
    }
    await handleTickets(sent);
    return {
      claimed: ours.length,
      sent: sent.filter((s) => s.ticket?.status === 'ok').length,
    };
  } catch (error) {
    console.error(
      '[push] delivery failed:',
      (error as Error)?.message ?? error,
    );
    return { claimed: 0, sent: 0 };
  }
}
