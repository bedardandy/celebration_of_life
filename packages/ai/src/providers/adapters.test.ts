/**
 * The parts of each adapter that can be tested without a binary, a key or a
 * network — which is deliberately most of them. Argument construction and
 * output parsing are where adapters actually go wrong; the spawn in the middle
 * is the boring part.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AiCallError } from '../types';
import { buildClaudeArgs, parseClaudeOutput, claudeBinary, claudeTimeoutMs } from './claude-cli';
import {
  buildCodexArgs,
  parseCodexJsonl,
  probeCodexImageSupport,
  setCodexImageSupport,
} from './codex-cli';
import {
  EMIT_TOOL_NAME,
  anthropicModel,
  buildAnthropicBody,
  extractAnthropicText,
} from './anthropic-api';
import {
  buildOpenAiBody,
  extractOpenAiText,
  openaiBaseUrl,
  openaiModel,
  openaiSupportsJsonSchema,
} from './openai-api';
import { flattenToPrompt, materializeImages } from './cli-prompt';
import { createMutex, firstStderrLine, runCommand } from './process';

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'col-ai-adapter-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  setCodexImageSupport(undefined);
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

/* -------------------------------------------------------------------------- */

describe('process helpers', () => {
  it('runs a command and captures both streams', async () => {
    const result = await runCommand('node', [
      '-e',
      'process.stdout.write("hi");console.error("uh")',
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('hi');
    expect(result.stderr).toContain('uh');
    expect(result.timedOut).toBe(false);
  });

  it('kills a command that overruns its timeout instead of hanging', async () => {
    const result = await runCommand('node', ['-e', 'setTimeout(()=>{},10000)'], { timeoutMs: 200 });
    expect(result.timedOut).toBe(true);
  });

  it('serialises calls through the mutex, one at a time', async () => {
    const mutex = createMutex();
    const order: string[] = [];
    const slow = () =>
      mutex(async () => {
        order.push('start-a');
        await new Promise((r) => setTimeout(r, 20));
        order.push('end-a');
      });
    const fast = () =>
      mutex(async () => {
        order.push('start-b');
      });
    await Promise.all([slow(), fast()]);
    expect(order).toEqual(['start-a', 'end-a', 'start-b']);
  });

  it('keeps running after a rejection rather than wedging the queue', async () => {
    const mutex = createMutex();
    await expect(mutex(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(mutex(async () => 'still here')).resolves.toBe('still here');
  });

  it('picks the first useful line of stderr', () => {
    expect(firstStderrLine('\n\n  something went wrong\nand more\n')).toBe('something went wrong');
    expect(firstStderrLine('   ')).toBe('');
  });
});

/* -------------------------------------------------------------------------- */

describe('cli prompt flattening', () => {
  it('renders a single message with no scaffolding', () => {
    expect(flattenToPrompt([{ role: 'user', content: 'hello' }])).toBe('hello');
  });

  it('labels roles when there is a conversation to keep straight', () => {
    const prompt = flattenToPrompt([
      { role: 'system', content: 'be kind' },
      { role: 'user', content: 'the dahlias' },
      { role: 'assistant', content: 'which ones?' },
    ]);
    expect(prompt).toContain('System:\nbe kind');
    expect(prompt).toContain('Person:\nthe dahlias');
    expect(prompt).toContain('You (earlier):\nwhich ones?');
  });

  it('announces image paths for a CLI that reads files', () => {
    const prompt = flattenToPrompt([{ role: 'user', content: 'look' }], ['/tmp/a.jpg']);
    expect(prompt).toContain('Analyze the images at these paths:');
    expect(prompt).toContain('- /tmp/a.jpg');
  });

  it('copies images into a scratch directory rather than exposing the blob store', () => {
    const source = tempDir();
    const scratch = tempDir();
    const original = path.join(source, 'family-photo.jpg');
    writeFileSync(original, 'not-really-a-jpeg');

    const paths = materializeImages(
      [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'look' },
            { type: 'image', source: 'path', path: original },
            {
              type: 'image',
              source: 'base64',
              base64: Buffer.from('x').toString('base64'),
              mime: 'image/png',
            },
          ],
        },
      ],
      scratch,
    );

    expect(paths).toHaveLength(2);
    for (const p of paths) expect(p.startsWith(scratch)).toBe(true);
    // The original name does not travel; the scratch copy is hashed.
    expect(paths[0]).not.toContain('family-photo');
    expect(readdirSync(scratch)).toHaveLength(2);
  });
});

/* -------------------------------------------------------------------------- */

describe('claude-cli adapter', () => {
  it('asks for JSON, allows Read and nothing else', () => {
    const args = buildClaudeArgs({ prompt: 'hello' });
    expect(args).toEqual(['-p', 'hello', '--output-format', 'json', '--allowedTools', 'Read']);
  });

  it('resumes a session when one is supplied', () => {
    expect(buildClaudeArgs({ prompt: 'hi', sessionId: 'abc' })).toContain('--resume');
    expect(buildClaudeArgs({ prompt: 'hi', sessionId: 'abc' })).toContain('abc');
  });

  it('reads the answer and the session id out of the envelope', () => {
    const parsed = parseClaudeOutput({
      code: 0,
      stdout: JSON.stringify({ result: 'the answer', session_id: 'sess-1' }),
      stderr: '',
      durationMs: 5,
      timedOut: false,
    });
    expect(parsed.text).toBe('the answer');
    expect(parsed.sessionId).toBe('sess-1');
  });

  it('falls back to plain stdout when the envelope is not JSON', () => {
    const parsed = parseClaudeOutput({
      code: 0,
      stdout: 'just some text',
      stderr: '',
      durationMs: 1,
      timedOut: false,
    });
    expect(parsed.text).toBe('just some text');
  });

  it('turns a reported error into a readable AiCallError', () => {
    expect(() =>
      parseClaudeOutput({
        code: 0,
        stdout: JSON.stringify({ is_error: true, subtype: 'rate_limit', result: 'slow down' }),
        stderr: '',
        durationMs: 1,
        timedOut: false,
      }),
    ).toThrow(AiCallError);
  });

  it('complains about empty output rather than returning nothing', () => {
    expect(() =>
      parseClaudeOutput({ code: 0, stdout: '  ', stderr: 'boom', durationMs: 1, timedOut: false }),
    ).toThrow(/returned no output/);
  });

  it('takes the binary and timeout from the environment', () => {
    expect(claudeBinary({ CLAUDE_CLI_PATH: '/opt/claude' })).toBe('/opt/claude');
    expect(claudeBinary({})).toBe('claude');
    expect(claudeTimeoutMs({ AI_CLI_TIMEOUT_MS: '5000' })).toBe(5000);
    expect(claudeTimeoutMs({})).toBe(120_000);
  });
});

/* -------------------------------------------------------------------------- */

describe('codex-cli adapter', () => {
  it('runs read-only and streams JSON', () => {
    expect(buildCodexArgs({ prompt: 'hello' })).toEqual([
      'exec',
      '--json',
      '--sandbox',
      'read-only',
      'hello',
    ]);
  });

  it('resumes by session id', () => {
    const args = buildCodexArgs({ prompt: 'hi', sessionId: 'sess-9' });
    expect(args.slice(0, 3)).toEqual(['exec', 'resume', 'sess-9']);
  });

  it('passes images with -i when it has them', () => {
    const args = buildCodexArgs({ prompt: 'hi', imagePaths: ['/tmp/a.jpg', '/tmp/b.jpg'] });
    expect(args.filter((a) => a === '-i')).toHaveLength(2);
    expect(args[args.length - 1]).toBe('hi');
  });

  it('takes the last assistant message out of the JSONL stream', () => {
    const stdout = [
      JSON.stringify({ type: 'session.created', session_id: 'sess-3' }),
      'not json at all',
      JSON.stringify({ type: 'agent_message', message: 'first thought' }),
      JSON.stringify({ type: 'tool_call', message: 'reading a file' }),
      JSON.stringify({ type: 'agent_message', message: 'the real answer' }),
    ].join('\n');
    const parsed = parseCodexJsonl(stdout);
    expect(parsed.text).toBe('the real answer');
    expect(parsed.sessionId).toBe('sess-3');
  });

  it('finds a session id nested inside a msg envelope', () => {
    const parsed = parseCodexJsonl(
      JSON.stringify({ type: 'agent_message', msg: { thread_id: 'sess-7', message: 'hi' } }),
    );
    expect(parsed.sessionId).toBe('sess-7');
  });

  it('lets the environment settle the vision question either way', () => {
    setCodexImageSupport(undefined);
    expect(probeCodexImageSupport({ AI_CODEX_VISION: '1' })).toBe(true);
    setCodexImageSupport(undefined);
    expect(probeCodexImageSupport({ AI_CODEX_VISION: '0' })).toBe(false);
  });

  it('reports no vision when the binary is not there to probe', () => {
    setCodexImageSupport(undefined);
    expect(probeCodexImageSupport({ CODEX_CLI_PATH: 'codex-not-installed' })).toBe(false);
  });

  it('drops vision out of its capabilities when the probe says no', async () => {
    setCodexImageSupport(false);
    const { codexCliProvider } = await import('./codex-cli');
    expect(codexCliProvider.capabilities.vision).toBe(false);
    expect(codexCliProvider.capabilities.visionInput).toBe('none');
    setCodexImageSupport(true);
    expect(codexCliProvider.capabilities.vision).toBe(true);
    expect(codexCliProvider.capabilities.visionInput).toBe('file-path');
  });
});

/* -------------------------------------------------------------------------- */

describe('anthropic-api adapter', () => {
  it('lifts system messages out and keeps the rest in order', async () => {
    const body = await buildAnthropicBody(
      {
        messages: [
          { role: 'system', content: 'be kind' },
          { role: 'user', content: 'the dahlias' },
          { role: 'assistant', content: 'which ones?' },
        ],
      },
      {},
    );
    expect(body.system).toBe('be kind');
    expect(body.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('forces the emit tool when a schema is supplied', async () => {
    const body = await buildAnthropicBody(
      { messages: [{ role: 'user', content: 'hi' }], jsonSchema: { $schema: 'x', properties: {} } },
      {},
    );
    expect(body.tool_choice).toEqual({ type: 'tool', name: EMIT_TOOL_NAME });
    // $schema is not accepted by the API and has to be dropped.
    expect(body.tools?.[0]?.input_schema).not.toHaveProperty('$schema');
  });

  it('sends images as base64 blocks', async () => {
    const body = await buildAnthropicBody(
      {
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'look' },
              { type: 'image', source: 'base64', base64: 'AAAA', mime: 'image/png' },
            ],
          },
        ],
      },
      {},
    );
    expect(body.messages[0]?.content[1]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
    });
  });

  it('prefers the tool result over any accompanying prose', () => {
    const text = extractAnthropicText({
      content: [
        { type: 'text', text: 'Here you go!' },
        { type: 'tool_use', name: EMIT_TOOL_NAME, input: { a: 1 } },
      ],
    });
    expect(text).toBe('{"a":1}');
  });

  it('falls back to text blocks when no tool was used', () => {
    expect(extractAnthropicText({ content: [{ type: 'text', text: 'plain answer' }] })).toBe(
      'plain answer',
    );
  });

  it('takes the model from the environment', () => {
    expect(anthropicModel({ AI_MODEL_ANTHROPIC: 'claude-x' })).toBe('claude-x');
    expect(anthropicModel({})).toBe('claude-opus-5');
  });
});

/* -------------------------------------------------------------------------- */

describe('openai-api adapter', () => {
  it('honours OPENAI_BASE_URL so a local server works unchanged', () => {
    expect(openaiBaseUrl({ OPENAI_BASE_URL: 'http://localhost:11434/' })).toBe(
      'http://localhost:11434',
    );
    expect(openaiBaseUrl({})).toBe('https://api.openai.com');
    expect(openaiModel({})).toBe('gpt-5');
  });

  it('keeps json_schema opt-in, because compatible servers vary', async () => {
    expect(openaiSupportsJsonSchema({})).toBe(false);
    const off = await buildOpenAiBody(
      { messages: [{ role: 'user', content: 'hi' }], jsonSchema: {} },
      {},
    );
    expect(off.response_format).toBeUndefined();

    const on = await buildOpenAiBody(
      { messages: [{ role: 'user', content: 'hi' }], jsonSchema: { $schema: 'x', type: 'object' } },
      { OPENAI_JSON_SCHEMA: '1' },
    );
    expect(on.response_format?.type).toBe('json_schema');
    expect(on.response_format?.json_schema.schema).not.toHaveProperty('$schema');
  });

  it('sends images as data URLs', async () => {
    const body = await buildOpenAiBody(
      {
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'look' },
              { type: 'image', source: 'base64', base64: 'AAAA', mime: 'image/jpeg' },
            ],
          },
        ],
      },
      {},
    );
    expect(JSON.stringify(body.messages[0]?.content)).toContain('data:image/jpeg;base64,AAAA');
  });

  it('reads the first choice', () => {
    expect(extractOpenAiText({ choices: [{ message: { content: ' hi ' } }] })).toBe('hi');
    expect(extractOpenAiText({})).toBe('');
  });
});
