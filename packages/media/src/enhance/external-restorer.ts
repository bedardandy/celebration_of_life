/**
 * Somebody else's restorer, run as a command.
 *
 * This is the drop-in seam for Real-ESRGAN, CodeFormer, GFPGAN or whatever
 * comes next. None of them belong inside this process — they are Python, they
 * are gigabytes, and they want a GPU — so the contract is a file in and a file
 * out, which every one of them already supports:
 *
 *   RESTORER_CMD="realesrgan-ncnn-vulkan -i {in} -o {out}"
 *
 * `{in}` and `{out}` are substituted with PNG paths in a scratch directory. No
 * shell is involved: the command is split on whitespace and executed directly,
 * so nothing a filename contains can turn into a shell command.
 *
 * Two rules the wrapper enforces regardless of what the tool does:
 *
 *  1. **Geometry never changes.** Face restorers routinely return a 4× upscale;
 *     that is scaled back to the original size here. A slideshow whose photos
 *     silently changed shape is a slideshow that no longer matches the preview.
 *  2. **The original is never touched.** Input is a copy, output is a new
 *     variant, and the family can go back with one tap.
 *
 * docs/photo-enhancement.md carries the warning that matters more than any of
 * this: a face restorer *invents* detail. On a wedding photograph from 1962
 * that can produce a person the family does not recognise. CodeFormer's
 * fidelity weight (w≈0.7) exists for exactly this reason.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {
  describeEnhancement,
  type EnhanceOutcome,
  type Restorer,
  type RestorerAvailability,
  type RestoreOptions,
} from './restorer';
import { measureForEnhancement, ENHANCED_JPEG_QUALITY } from './sharp-restorer';

export type ExternalRestorerOptions = {
  /** The command line, with {in} and {out} placeholders. */
  command: string;
  timeoutMs?: number;
};

export function externalRestorerFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ExternalRestorer | undefined {
  const command = env['RESTORER_CMD']?.trim();
  if (!command) return undefined;
  const timeout = Number.parseInt(env['RESTORER_TIMEOUT_MS'] ?? '', 10);
  return new ExternalRestorer({
    command,
    ...(Number.isFinite(timeout) && timeout > 0 ? { timeoutMs: timeout } : {}),
  });
}

/** Whitespace split, with quoted segments kept whole. No shell, no globbing. */
export function splitCommand(command: string): string[] {
  const parts = command.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  return parts.map((part) =>
    (part.startsWith('"') && part.endsWith('"')) || (part.startsWith("'") && part.endsWith("'"))
      ? part.slice(1, -1)
      : part,
  );
}

export class ExternalRestorer implements Restorer {
  readonly id: string;

  constructor(private readonly options: ExternalRestorerOptions) {
    this.id = path.basename(splitCommand(options.command)[0] ?? 'external');
  }

  async available(): Promise<RestorerAvailability> {
    const argv = splitCommand(this.options.command);
    if (argv.length === 0) return { available: false, reason: 'RESTORER_CMD is empty.' };
    if (!this.options.command.includes('{in}') || !this.options.command.includes('{out}')) {
      return {
        available: false,
        reason: 'RESTORER_CMD must contain both {in} and {out} placeholders.',
      };
    }
    return { available: true, note: argv[0] as string };
  }

  async restore(input: Buffer, options: RestoreOptions = {}): Promise<EnhanceOutcome> {
    const status = await this.available();
    if (!status.available) throw new Error(status.reason);

    const before = await measureForEnhancement(input);
    const source = await sharp(input, { failOn: 'none' }).metadata();
    const width = source.width ?? 0;
    const height = source.height ?? 0;
    if (!width || !height) throw new Error('The photograph could not be read for restoration.');

    const scratch = await mkdtemp(path.join(tmpdir(), 'col-restore-'));
    try {
      const inFile = path.join(scratch, 'in.png');
      const outFile = path.join(scratch, 'out.png');
      await writeFile(inFile, await sharp(input, { failOn: 'none' }).png().toBuffer());

      const argv = splitCommand(this.options.command).map((part) =>
        part.replaceAll('{in}', inFile).replaceAll('{out}', outFile),
      );
      await run(argv, this.options.timeoutMs ?? 300_000, options.signal);

      const produced = await readFile(outFile);
      // Back to the size it came in at, whatever the tool decided to do.
      const { data, info } = await sharp(produced, { failOn: 'none' })
        .resize(width, height, { fit: 'fill' })
        .jpeg({ quality: ENHANCED_JPEG_QUALITY, mozjpeg: true })
        .toBuffer({ resolveWithObject: true });

      const after = await measureForEnhancement(data);
      return {
        data,
        width: info.width,
        height: info.height,
        before: strip(before),
        after: strip(after),
        steps: [this.id],
        summary: describeEnhancement(strip(before), strip(after)),
      };
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }
}

function strip(measurement: {
  contrastRange: number;
  saturation: number;
  meanLuma: number;
  detail: number;
}) {
  return {
    contrastRange: measurement.contrastRange,
    saturation: measurement.saturation,
    meanLuma: measurement.meanLuma,
    detail: measurement.detail,
  };
}

async function run(argv: string[], timeoutMs: number, signal?: AbortSignal): Promise<void> {
  const [command, ...args] = argv;
  if (!command) throw new Error('RESTORER_CMD is empty.');

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${command} did not finish within ${Math.round(timeoutMs / 1000)}s.`));
    }, timeoutMs);
    timer.unref?.();

    const onAbort = () => child.kill('SIGTERM');
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-2_000);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(new Error(`${command} could not be started: ${error.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code}${stderr ? `: ${stderr.trim()}` : ''}`));
    });
  });
}
