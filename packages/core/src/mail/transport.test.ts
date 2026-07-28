import { afterEach, describe, expect, it } from 'vitest';
import { DevConsoleTransport, organizerLoginEmail, setMailTransport } from './transport';

afterEach(() => {
  setMailTransport(undefined);
  delete process.env['NODE_ENV'];
});

describe('DevConsoleTransport', () => {
  it('logs the address and the link, and never the body', async () => {
    const lines: string[] = [];
    const transport = new DevConsoleTransport((line) => lines.push(line));
    const message = organizerLoginEmail({
      to: 'anne@example.test',
      decedentName: 'Ruth Kelleher',
      url: 'https://example.test/auth/tok',
    });

    const result = await transport.send(message);

    expect(result.delivered).toBe(true);
    expect(lines.join('\n')).toContain('anne@example.test');
    expect(lines.join('\n')).toContain('https://example.test/auth/tok');
    expect(lines.join('\n')).not.toContain('Nothing you have added is lost');
  });

  it('hands the link back for the screen, so the flow is walkable without an inbox', async () => {
    const transport = new DevConsoleTransport(() => {});
    const result = await transport.send({
      to: 'anne@example.test',
      subject: 'Your link',
      body: 'body',
      link: 'https://example.test/auth/tok',
    });
    expect(result.devPreviewLink).toBe('https://example.test/auth/tok');
  });

  it('never hands the link back in production', async () => {
    process.env['NODE_ENV'] = 'production';
    const transport = new DevConsoleTransport(() => {});
    const result = await transport.send({
      to: 'anne@example.test',
      subject: 'Your link',
      body: 'body',
      link: 'https://example.test/auth/tok',
    });
    expect(result.devPreviewLink).toBeUndefined();
  });
});

describe('the login email', () => {
  it('names the person it is about and says the link resumes where they left off', () => {
    const message = organizerLoginEmail({
      to: 'anne@example.test',
      decedentName: 'Ruth Kelleher',
      url: 'https://example.test/auth/tok',
    });
    expect(message.subject).toBe('Your link for Ruth Kelleher');
    expect(message.body).toContain('https://example.test/auth/tok');
    expect(message.body).toMatch(/nothing you have added is lost/i);
    expect(message.body).not.toMatch(/sorry for your loss|condolences/i);
  });
});
