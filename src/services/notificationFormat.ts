/**
 * One shape for a notification on the way out, whatever wrote it.
 *
 * The model's text field is `message`. One producer (the attendance sync job)
 * wrote `body` instead — rejected by validation, so no such row was saved
 * through the model — but a row written another way (a script, an older
 * deploy, a direct insert) could carry only `body`. Readers on every client
 * show `message`, so a list must never hand them a notification without one.
 *
 * Pure: the list endpoint uses it and `scripts/safety/notification-format.test.ts`
 * checks it. Unread counts and the read actions key on `read` alone, so they
 * are the same for either shape.
 */
export function presentNotification<T extends Record<string, unknown>>(
  doc: T,
): T & { message: string } {
  const message =
    typeof doc.message === 'string' && doc.message.trim()
      ? doc.message
      : typeof doc.body === 'string'
        ? doc.body
        : '';
  const { body: _legacyBody, ...rest } = doc as T & { body?: unknown };
  return { ...(rest as T), message };
}
