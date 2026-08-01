/**
 * The production mail path, with the network replaced by a spy.
 *
 * Nothing in this suite may ever send a real message: the `fetch` handed to the
 * transport is always a local function, and the one test that touches
 * `getMailTransport` asserts on the *shape* of the failure rather than making a
 * request.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, jobs, listWhere } from '@col/db';
import { MailSendError, RESEND_ENDPOINT, ResendTransport, resendFromEnv } from './resend';
import {
  getMailTransport,
  mailTransportName,
  organizerLoginEmail,
  setMailTransport,
} from './transport';
import { deliverEmail, renderMailTemplate, shouldQueueMail } from './deliver';

const message = organizerLoginEmail({
  to: 'anne@example.test',
  decedentName: 'Ruth Kelleher',
  url: 'https://example.test/auth/tok',
});

afterEach(() => {
  setMailTransport(undefined);
  delete process.env['MAIL_TRANSPORT'];
  delete process.env['RESEND_API_KEY'];
  delete process.env['MAIL_FROM'];
  delete process.env['NODE_ENV'];
});

function okResponse() {
  return new Response(JSON.stringify({ id: 'msg_123' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/* -------------------------------------------------------------------------- */

describe('ResendTransport', () => {
  it('posts plain text to the send endpoint, with the key in the header', async () => {
    const fetchImpl = vi.fn(async () => okResponse());
    const transport = new ResendTransport({
      apiKey: 'test-key',
      from: 'Celebration of Life <hello@example.test>',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await transport.send(message);

    expect(result).toEqual({ transport: 'resend', delivered: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(RESEND_ENDPOINT);
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer test-key');

    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body['from']).toBe('Celebration of Life <hello@example.test>');
    expect(body['to']).toEqual(['anne@example.test']);
    expect(body['subject']).toBe('Your link for Ruth Kelleher');
    expect(body['text']).toContain('https://example.test/auth/tok');
    // Plain text only: an HTML link is a link a mail client may rewrite.
    expect(body['html']).toBeUndefined();
  });

  it('never claims delivery when the service refused the message', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('domain not verified', { status: 403 }),
    ) as unknown as typeof fetch;
    const transport = new ResendTransport({
      apiKey: 'k',
      from: 'a@example.test',
      fetchImpl,
    });

    await expect(transport.send(message)).rejects.toBeInstanceOf(MailSendError);
    await expect(transport.send(message)).rejects.toThrow(/403/);
  });

  it('turns a dead network into a sentence rather than a stack trace', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const transport = new ResendTransport({ apiKey: 'k', from: 'a@example.test', fetchImpl });

    await expect(transport.send(message)).rejects.toThrow(/could not reach the mail service/i);
  });

  it('refuses to exist without a key or a from address', () => {
    expect(() => new ResendTransport({ apiKey: '  ', from: 'a@example.test' })).toThrow(
      /RESEND_API_KEY/,
    );
    expect(() => new ResendTransport({ apiKey: 'k', from: '' })).toThrow(/MAIL_FROM/);
  });
});

describe('choosing a transport', () => {
  it('defaults to the console, so a developer needs no domain', () => {
    expect(mailTransportName({})).toBe('console');
    expect(getMailTransport().name).toBe('dev-console');
  });

  it('rejects a value that is neither, by name', () => {
    expect(() => mailTransportName({ MAIL_TRANSPORT: 'sendgrid' })).toThrow(/console, resend/);
  });

  it('says exactly what is missing when resend is asked for and not configured', () => {
    expect(() => resendFromEnv({ MAIL_TRANSPORT: 'resend' })).toThrow(
      /RESEND_API_KEY and MAIL_FROM/,
    );
    expect(() => resendFromEnv({ MAIL_TRANSPORT: 'resend', RESEND_API_KEY: 'k' })).toThrow(
      /MAIL_FROM/,
    );
  });

  it('builds a resend transport when the environment is complete', () => {
    process.env['MAIL_TRANSPORT'] = 'resend';
    process.env['RESEND_API_KEY'] = 'k';
    process.env['MAIL_FROM'] = 'Celebration of Life <hello@example.test>';
    expect(getMailTransport().name).toBe('resend');
  });
});

/* -------------------------------------------------------------------------- */

describe('composing a queued message', () => {
  it('turns a template name and its facts back into the same words', () => {
    const composed = renderMailTemplate({
      type: 'send-email',
      to: 'anne@example.test',
      subject: 'Your link for Ruth Kelleher',
      template: 'organizer-login',
      data: { decedentName: 'Ruth Kelleher', url: 'https://example.test/auth/tok' },
    });
    expect(composed.body).toBe(message.body);
    expect(composed.link).toBe('https://example.test/auth/tok');
  });

  it('refuses a template it does not know rather than sending an empty email', () => {
    expect(() =>
      renderMailTemplate({
        type: 'send-email',
        to: 'a@example.test',
        subject: 's',
        template: 'invented',
        data: {},
      }),
    ).toThrow(/no mail template/i);
  });
});

describe('sending or queueing', () => {
  it('sends inline in development and hands the link to the screen', async () => {
    const db = createTestDb();
    const sent: string[] = [];
    setMailTransport({
      name: 'spy',
      send: async (m) => {
        sent.push(m.subject);
        return { transport: 'spy', delivered: true, devPreviewLink: m.link as string };
      },
    });

    const result = await deliverEmail(db, {
      template: 'organizer-login',
      to: 'anne@example.test',
      data: { decedentName: 'Ruth Kelleher', url: 'https://example.test/auth/tok' },
    });

    expect(result.queued).toBe(false);
    expect(result.devPreviewLink).toBe('https://example.test/auth/tok');
    expect(sent).toEqual(['Your link for Ruth Kelleher']);
    expect(listWhere(db, jobs)).toHaveLength(0);
  });

  it('queues in production, so a mail outage is a delay and not a 500', async () => {
    process.env['NODE_ENV'] = 'production';
    process.env['MAIL_TRANSPORT'] = 'resend';
    process.env['RESEND_API_KEY'] = 'k';
    process.env['MAIL_FROM'] = 'a@example.test';
    const db = createTestDb();

    expect(shouldQueueMail()).toBe(true);
    const result = await deliverEmail(db, {
      template: 'organizer-login',
      to: 'anne@example.test',
      data: { decedentName: 'Ruth Kelleher', url: 'https://example.test/auth/tok' },
    });

    expect(result.queued).toBe(true);
    const queued = listWhere(db, jobs);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.type).toBe('send-email');
    // The words are composed by the worker; the row holds facts, not prose.
    expect(JSON.stringify(queued[0]?.payload)).not.toContain('Nothing you have added is lost');
  });

  it('does not queue a production deployment still on the console transport', () => {
    process.env['NODE_ENV'] = 'production';
    expect(shouldQueueMail()).toBe(false);
  });
});
