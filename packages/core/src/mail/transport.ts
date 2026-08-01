/**
 * Sending mail.
 *
 * Phase 1 ships one transport: the console. It prints the link to the server
 * log and hands it back to the caller so the page that just submitted a form
 * can show it on screen. That means the whole product is walkable in
 * development without an inbox, and the real transport later only has to
 * implement `send`.
 *
 * The dev preview link is returned **only** outside production. In production a
 * transport that cannot really deliver must fail loudly rather than quietly
 * showing a login link to whoever is looking at the screen.
 */
import { isProduction } from '../env';
import { resendFromEnv } from './resend';

export type MailMessage = {
  to: string;
  subject: string;
  /** Plain text. Every message in this product reads fine without HTML. */
  body: string;
  /** The one link the message is about, if it has one. */
  link?: string;
};

export type MailSendResult = {
  transport: string;
  delivered: boolean;
  /** Present in development only: show this on screen so the flow is walkable. */
  devPreviewLink?: string;
};

export interface MailTransport {
  readonly name: string;
  send(message: MailMessage): Promise<MailSendResult>;
}

export class DevConsoleTransport implements MailTransport {
  readonly name = 'dev-console';

  constructor(private readonly write: (line: string) => void = defaultWrite) {}

  async send(message: MailMessage): Promise<MailSendResult> {
    // Log the address and the link, never the body: bodies carry names.
    this.write(`[mail:dev-console] to=${message.to} subject=${JSON.stringify(message.subject)}`);
    if (message.link) this.write(`[mail:dev-console] link=${message.link}`);
    return {
      transport: this.name,
      delivered: true,
      ...(message.link && !isProduction() ? { devPreviewLink: message.link } : {}),
    };
  }
}

// Deliberately not `console.log`: logging in this repo goes through explicit
// writers so it can be levelled and scrubbed later.
function defaultWrite(line: string): void {
  process.stdout.write(`${line}\n`);
}

let transport: MailTransport | undefined;

export type MailTransportName = 'console' | 'resend';

/** What `MAIL_TRANSPORT` may say. Anything else is a typo worth failing on. */
export const MAIL_TRANSPORTS: MailTransportName[] = ['console', 'resend'];

export function mailTransportName(env: NodeJS.ProcessEnv = process.env): MailTransportName {
  const configured = env['MAIL_TRANSPORT']?.trim().toLowerCase();
  if (!configured) return 'console';
  if ((MAIL_TRANSPORTS as string[]).includes(configured)) return configured as MailTransportName;
  throw new Error(
    `MAIL_TRANSPORT=${JSON.stringify(configured)} is not one of: ${MAIL_TRANSPORTS.join(', ')}.`,
  );
}

/**
 * The transport this process should use.
 *
 * Console stays the default so a developer never has to own a domain to walk
 * the product. Production sets `MAIL_TRANSPORT=resend`; a misconfigured
 * production transport throws here, at the first send, rather than silently
 * printing somebody's login link into a server log.
 */
export function getMailTransport(): MailTransport {
  if (transport) return transport;
  transport = mailTransportName() === 'resend' ? resendFromEnv() : new DevConsoleTransport();
  return transport;
}

/** Tests and future adapters swap the transport here. */
export function setMailTransport(next: MailTransport | undefined): void {
  transport = next;
}

/* -------------------------------------------------------------------------- */
/* Messages                                                                    */
/* -------------------------------------------------------------------------- */

export function organizerLoginEmail(input: {
  to: string;
  decedentName: string;
  url: string;
}): MailMessage {
  return {
    to: input.to,
    subject: `Your link for ${input.decedentName}`,
    body: [
      `Here is your link back to the pages you are keeping for ${input.decedentName}:`,
      '',
      input.url,
      '',
      'It opens straight to where you left off. Nothing you have added is lost.',
      'If you need another link later, ask for one from the front page.',
    ].join('\n'),
    link: input.url,
  };
}
