/**
 * The message the organiser sends.
 *
 * Writing "hello everyone, we are collecting photos for Mum's service" is a
 * small task that a grieving person can stall on for two days, because it means
 * telling forty people that their mother died. So we write it for them, in two
 * lengths — one that fits a text message, one that reads as an email — and they
 * copy it. Every word is theirs to change; none of it has to be.
 */
import { formatDeadline } from './asks';

export type MessageDraft = {
  id: 'sms' | 'email';
  label: string;
  /** Only the email draft has one. */
  subject?: string;
  body: string;
};

export type MessageInput = {
  decedentName: string;
  /** What the family calls them, if that differs. Used as the warmer form. */
  knownAs?: string | null;
  link: string;
  organizerName?: string | null;
  deadlineAt?: number | null;
  timezone?: string;
};

function familiarName(input: MessageInput): string {
  const known = (input.knownAs ?? '').trim();
  if (known) return known;
  // First name only: "Ruth", not "Ruth Margaret Kelleher".
  return input.decedentName.trim().split(/\s+/)[0] ?? input.decedentName.trim();
}

function byWhen(input: MessageInput): string {
  return input.deadlineAt ? ` by ${formatDeadline(input.deadlineAt, input.timezone)}` : '';
}

/**
 * Two drafts, both short. The SMS draft is kept under about 300 characters so
 * it does not arrive as four separate messages on an older phone.
 */
export function messageDrafts(input: MessageInput): MessageDraft[] {
  const name = familiarName(input);
  const when = byWhen(input);
  const from = (input.organizerName ?? '').trim();
  const signature = from ? `\n\n${from}` : '';

  return [
    {
      id: 'sms',
      label: 'Short message (text or WhatsApp)',
      body:
        `We're gathering photos for ${name}'s celebration of life. ` +
        `Could you add 5–10 favourites${when}? Old photos are welcome — a snap of a print is fine. ` +
        `No sign-up, just the link: ${input.link}`,
    },
    {
      id: 'email',
      label: 'Email',
      subject: `Photos for ${name}'s celebration of life`,
      body:
        `Hello,\n\n` +
        `We're putting together photos and memories for ${name}'s celebration of life, ` +
        `and we'd love a few from you.\n\n` +
        `Five or ten favourites would be perfect${when} — and older photos are especially welcome. ` +
        `If they're prints, a photo of the print works well.\n\n` +
        `There's nothing to sign up for. This link opens straight to it, and it keeps working, ` +
        `so you can add more whenever something turns up:\n${input.link}\n\n` +
        `If you'd rather write something than send a photo, there's a place for that too. ` +
        `Thank you.${signature}`,
    },
  ];
}

/** The one-line explanation shown beside the link itself. */
export const COLLECTION_LINK_HELP =
  'Anyone with this link can add photos and memories. They will not need an account.';

export const REVOKE_LINK_HELP = 'This stops the link from working; photos already shared stay.';
