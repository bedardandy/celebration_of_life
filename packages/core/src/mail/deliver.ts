/**
 * Getting a message out of the request and into somebody's inbox.
 *
 * In development the action sends it there and then, and hands the link back so
 * the screen can show it — nobody should need a mailbox to walk the product.
 *
 * In production the message goes on the durable queue instead. Not for
 * throughput: because the mail service will be down one afternoon, and when it
 * is, an organiser pressing "send me my link again" should see the same calm
 * screen and get the email a minute later — rather than a 500 on the day of a
 * funeral. The queue retries; the request does not have to.
 *
 * The queued payload carries a template name and its data, never a rendered
 * body, so the worker composes the words with the same code the action would
 * have used and a message never sits in the database as prose about somebody.
 */
import { enqueue, type Db } from '@col/db';
import type { JobPayloadFor } from '@col/schemas';
import { isProduction } from '../env';
import {
  getMailTransport,
  mailTransportName,
  organizerLoginEmail,
  type MailMessage,
  type MailSendResult,
} from './transport';

/** The queued form of a message: a template name and the facts it needs. */
export type SendEmailPayload = JobPayloadFor<'send-email'>;

/* -------------------------------------------------------------------------- */
/* templates                                                                   */
/* -------------------------------------------------------------------------- */

export type MailTemplateName = 'organizer-login';

/**
 * Composers the worker can run from a queued payload. Each takes the small,
 * boring set of facts the message needs and returns the whole message.
 */
export const MAIL_TEMPLATES: Record<
  MailTemplateName,
  (to: string, data: Record<string, unknown>) => MailMessage
> = {
  'organizer-login': (to, data) =>
    organizerLoginEmail({
      to,
      decedentName: String(data['decedentName'] ?? 'your memorial'),
      url: String(data['url'] ?? ''),
    }),
};

export function isMailTemplate(value: string): value is MailTemplateName {
  return Object.prototype.hasOwnProperty.call(MAIL_TEMPLATES, value);
}

export function renderMailTemplate(payload: SendEmailPayload): MailMessage {
  if (!isMailTemplate(payload.template)) {
    throw new Error(`No mail template named ${JSON.stringify(payload.template)}.`);
  }
  const message = MAIL_TEMPLATES[payload.template](payload.to, payload.data);
  // The queued subject wins if it was set deliberately; otherwise the template's.
  return payload.subject ? { ...message, subject: payload.subject } : message;
}

/* -------------------------------------------------------------------------- */
/* sending                                                                     */
/* -------------------------------------------------------------------------- */

export type DeliverEmailInput = {
  template: MailTemplateName;
  to: string;
  data: Record<string, unknown>;
  memorialId?: string;
};

export type DeliverEmailResult = MailSendResult & {
  /** True when the message went on the queue instead of down the wire now. */
  queued: boolean;
};

/**
 * Send it, or queue it. The caller does not have to know which, and gets a
 * `devPreviewLink` in development either way.
 */
export async function deliverEmail(db: Db, input: DeliverEmailInput): Promise<DeliverEmailResult> {
  const message = renderMailTemplate({
    type: 'send-email',
    to: input.to,
    subject: MAIL_TEMPLATES[input.template](input.to, input.data).subject,
    template: input.template,
    data: input.data,
  });

  if (shouldQueueMail()) {
    enqueue(
      db,
      {
        type: 'send-email',
        to: input.to,
        subject: message.subject,
        template: input.template,
        data: input.data,
      },
      {
        ...(input.memorialId ? { memorialId: input.memorialId } : {}),
        // Above analysis, below renders: a login link is time-sensitive but is
        // not the thing with a funeral at the end of it.
        priority: 5,
        maxAttempts: 5,
      },
    );
    return { transport: 'queue', delivered: false, queued: true };
  }

  const sent = await getMailTransport().send(message);
  return { ...sent, queued: false };
}

/**
 * Queue in production with a real transport; send inline otherwise.
 *
 * A production deployment still on the console transport is a deployment where
 * the "email" is a line in a log file — queueing that would only delay it.
 */
export function shouldQueueMail(): boolean {
  return isProduction() && mailTransportName() !== 'console';
}
