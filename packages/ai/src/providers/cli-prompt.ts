/**
 * Flattening a conversation into the single string a CLI accepts.
 *
 * `claude -p` and `codex exec` both take one prompt, so multi-turn context has
 * to be rendered rather than sent. Roles are labelled plainly so the model can
 * still tell who said what, and images become absolute paths in a scratch
 * directory — the CLIs read files, they do not take base64.
 */
import { mkdirSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { contentParts, type AiMessage, type ContentPart } from '../types';

export const SCRATCH_DIR_NAME = 'col-ai-images';

/** Where copied images go. Under $TMPDIR so a crash leaves nothing behind. */
export function scratchDir(): string {
  const dir = path.join(process.env['TMPDIR']?.trim() || tmpdir(), SCRATCH_DIR_NAME);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/heic': 'heic',
};

/**
 * Every image in the conversation, as an absolute path a CLI can open.
 * Base64 parts are materialised; path parts are copied so the CLI is never
 * pointed at the family's blob store directly.
 */
export function materializeImages(messages: readonly AiMessage[], dir = scratchDir()): string[] {
  const paths: string[] = [];
  for (const message of messages) {
    for (const part of contentParts(message) as ContentPart[]) {
      if (part.type !== 'image') continue;
      if (part.source === 'path') {
        const target = path.join(dir, `${hash(part.path)}${path.extname(part.path) || '.jpg'}`);
        if (!existsSync(target)) copyFileSync(part.path, target);
        paths.push(target);
      } else {
        const ext = MIME_EXT[part.mime] ?? 'jpg';
        const target = path.join(dir, `${hash(part.base64.slice(0, 512))}.${ext}`);
        if (!existsSync(target)) writeFileSync(target, Buffer.from(part.base64, 'base64'));
        paths.push(target);
      }
    }
  }
  return paths;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

const ROLE_LABEL: Record<string, string> = {
  system: 'System',
  user: 'Person',
  assistant: 'You (earlier)',
};

/**
 * Render a conversation as one prompt. When `imagePaths` is given, they are
 * announced at the end so the CLI knows to read them.
 */
export function flattenToPrompt(
  messages: readonly AiMessage[],
  imagePaths: readonly string[] = [],
): string {
  const blocks: string[] = [];
  for (const message of messages) {
    const text = contentParts(message)
      .filter((part): part is Extract<ContentPart, { type: 'text' }> => part.type === 'text')
      .map((part) => part.text)
      .join('\n')
      .trim();
    if (text.length === 0) continue;
    // A single user message needs no scaffolding; a conversation does.
    blocks.push(
      messages.length === 1 ? text : `${ROLE_LABEL[message.role] ?? message.role}:\n${text}`,
    );
  }
  if (imagePaths.length > 0) {
    blocks.push(
      `Analyze the images at these paths:\n${imagePaths.map((p) => `- ${p}`).join('\n')}`,
    );
  }
  return blocks.join('\n\n');
}
