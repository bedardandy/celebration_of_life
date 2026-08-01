/**
 * Sending mail for real.
 *
 * One HTTP call, no SDK. Resend's send endpoint takes a small JSON body and
 * returns an id, which is the whole contract we need — adding a dependency to
 * do a POST would be a dependency we then have to keep current for the lifetime
 * of the product.
 *
 * Every message this product sends is plain text on purpose. A magic link in an
 * HTML email is a link somebody's mail client may rewrite, wrap or shorten, and
 * a link that arrives broken on the day of a funeral is not a small bug.
 */
import type { MailMessage, MailSendResult, MailTransport } from './transport';

export const RESEND_ENDPOINT = 'https://api.resend.com/emails';

export type ResendOptions = {
  apiKey: string;
  /** "Celebration of Life <hello@example.com>" — must be a verified domain. */
  from: string;
  endpoint?: string;
  /** Injectable for tests. Nothing in this repo's tests ever touches the network. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export class MailSendError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'MailSendError';
  }
}

export class ResendTransport implements MailTransport {
  readonly name = 'resend';

  constructor(private readonly options: ResendOptions) {
    if (!options.apiKey.trim()) throw new Error('ResendTransport: RESEND_API_KEY is empty');
    if (!options.from.trim()) throw new Error('ResendTransport: MAIL_FROM is empty');
  }

  async send(message: MailMessage): Promise<MailSendResult> {
    const doFetch = this.options.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 15_000);

    let response: Response;
    try {
      response = await doFetch(this.options.endpoint ?? RESEND_ENDPOINT, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          from: this.options.from,
          to: [message.to],
          subject: message.subject,
          text: message.body,
        }),
        signal: controller.signal,
      });
    } catch (error) {
      throw new MailSendError(
        `Could not reach the mail service: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      // The body may carry a useful reason ("domain not verified"); it may also
      // carry nothing. Either way the address never goes into the message, so a
      // log line about a failed send is not a log line about a bereaved family.
      const detail = await response.text().catch(() => '');
      throw new MailSendError(
        `The mail service refused the message (${response.status})${detail ? `: ${detail.slice(0, 300)}` : ''}`,
        response.status,
      );
    }

    return { transport: this.name, delivered: true };
  }
}

/** Build one from the environment, or explain exactly what is missing. */
export function resendFromEnv(env: NodeJS.ProcessEnv = process.env): ResendTransport {
  const apiKey = env['RESEND_API_KEY']?.trim();
  const from = env['MAIL_FROM']?.trim();
  const missing = [!apiKey ? 'RESEND_API_KEY' : null, !from ? 'MAIL_FROM' : null].filter(Boolean);
  if (missing.length > 0) {
    throw new Error(
      `MAIL_TRANSPORT=resend needs ${missing.join(' and ')} to be set. See docs/production.md.`,
    );
  }
  return new ResendTransport({ apiKey: apiKey as string, from: from as string });
}
