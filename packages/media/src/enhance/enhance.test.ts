/**
 * Restoration, measured rather than admired.
 *
 * A faded print is synthesised here — flat histogram, drained colour — because
 * "does this look better" is not a thing a test can answer, but "is there more
 * of the picture visible than there was" is. The assertions are the promises
 * the screen makes to a family: more light, a little more colour, the same
 * photograph, the same shape, and the original still on disk.
 */
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import {
  SharpRestorer,
  measureForEnhancement,
  planEnhancement,
  lumaPercentiles,
} from './sharp-restorer';
import { ExternalRestorer, splitCommand, externalRestorerFromEnv } from './external-restorer';
import { describeEnhancement } from './restorer';
import { makeEnhancedCopy, resolveRestorer, ENHANCED_VARIANT } from './index';

const WIDTH = 480;
const HEIGHT = 360;

/**
 * A photograph as it comes off a shoebox print: a real scene, then squashed
 * into a narrow band of greys and drained of colour.
 */
async function fadedPrint(): Promise<Buffer> {
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">` +
      `<rect width="${WIDTH}" height="${HEIGHT}" fill="rgb(150,120,90)"/>` +
      `<circle cx="150" cy="140" r="80" fill="rgb(210,170,140)"/>` +
      `<rect x="240" y="80" width="180" height="200" fill="rgb(90,80,70)"/>` +
      `<rect x="40" y="270" width="400" height="40" fill="rgb(190,180,160)"/>` +
      `</svg>`,
    'utf8',
  );
  const full = await sharp(svg).png().toBuffer();
  // linear(a, b): squeeze the range into ~[95, 165] and pull the colour out.
  return sharp(full)
    .linear(0.28, 95)
    .modulate({ saturation: 0.35 })
    .jpeg({ quality: 92 })
    .toBuffer();
}

/** A photograph that needs nothing: full range of light, colour intact. */
async function crisp(): Promise<Buffer> {
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">` +
      `<rect width="${WIDTH}" height="${HEIGHT}" fill="rgb(4,4,4)"/>` +
      `<rect x="0" y="0" width="${WIDTH}" height="120" fill="rgb(252,252,252)"/>` +
      `<circle cx="120" cy="240" r="100" fill="rgb(250,40,40)"/>` +
      `<rect x="260" y="150" width="200" height="200" fill="rgb(20,240,90)"/>` +
      `</svg>`,
    'utf8',
  );
  return sharp(svg).jpeg({ quality: 95 }).toBuffer();
}

/* -------------------------------------------------------------------------- */

describe('measuring a photograph', () => {
  it('finds the histogram flat and the colour gone on a faded print', async () => {
    const stats = await measureForEnhancement(await fadedPrint());
    expect(stats.contrastRange).toBeLessThan(0.5);
    expect(stats.saturation).toBeLessThan(0.25);
  });

  it('takes the centiles rather than the extremes, so one white speck is not the range', () => {
    const gray = new Uint8Array(1000).fill(100);
    gray[0] = 0;
    gray[1] = 255;
    const { low, high } = lumaPercentiles(gray);
    expect(low).toBe(100);
    expect(high).toBe(100 + 1);
  });
});

describe('planning', () => {
  it('stretches a flat picture and leaves a contrasty one alone', async () => {
    const faded = planEnhancement(await measureForEnhancement(await fadedPrint()));
    expect(faded.map((s) => s.kind)).toContain('levels');
    expect(faded.map((s) => s.kind)).toContain('colour');

    const good = planEnhancement(await measureForEnhancement(await crisp()));
    expect(good.map((s) => s.kind)).not.toContain('levels');
    expect(good.map((s) => s.kind)).not.toContain('colour');
  });

  it('never pushes further than 1.8× however faded the print', async () => {
    const measurement = await measureForEnhancement(await fadedPrint());
    const plan = planEnhancement({ ...measurement, contrastRange: 0.02 }, 1);
    const levels = plan.find((step) => step.kind === 'levels');
    expect(levels && levels.kind === 'levels' ? levels.slope : 0).toBeLessThanOrEqual(1.8);
  });
});

describe('the sharp restorer', () => {
  it('brings back light and colour without changing the shape of the picture', async () => {
    const input = await fadedPrint();
    const result = await new SharpRestorer().restore(input);

    expect(result.after.contrastRange).toBeGreaterThan(result.before.contrastRange + 0.1);
    expect(result.after.saturation).toBeGreaterThan(result.before.saturation);
    expect(result.width).toBe(WIDTH);
    expect(result.height).toBe(HEIGHT);
    expect(result.summary).toMatch(/original is untouched/i);
  });

  it('leaves a photograph that is already fine almost exactly as it was', async () => {
    const result = await new SharpRestorer().restore(await crisp());
    expect(Math.abs(result.after.contrastRange - result.before.contrastRange)).toBeLessThan(0.05);
    expect(result.steps).not.toContain('levels');
  });

  it('does not enlarge a small photograph when making the render-size copy', async () => {
    const result = await makeEnhancedCopy(await fadedPrint(), new SharpRestorer());
    expect(result.width).toBe(WIDTH);
    expect(result.height).toBe(HEIGHT);
  });

  it('makes the render-size copy no bigger than the render variant', async () => {
    const big = await sharp({
      create: { width: 3600, height: 2400, channels: 3, background: { r: 120, g: 110, b: 100 } },
    })
      .jpeg()
      .toBuffer();
    const result = await makeEnhancedCopy(big, new SharpRestorer());
    expect(result.width).toBe(2400);
    expect(ENHANCED_VARIANT).toBe('enhanced2400');
  });

  it('is always available: no model, no network', async () => {
    expect(await new SharpRestorer().available()).toMatchObject({ available: true });
    expect(resolveRestorer({}).id).toBe('sharp');
  });
});

describe('an external restorer', () => {
  it('splits a command line without a shell', () => {
    expect(splitCommand('codeformer -w 0.7 -i {in} -o {out}')).toEqual([
      'codeformer',
      '-w',
      '0.7',
      '-i',
      '{in}',
      '-o',
      '{out}',
    ]);
    expect(splitCommand('"/opt/my tools/esrgan" -i {in} -o {out}')[0]).toBe('/opt/my tools/esrgan');
  });

  it('insists on both placeholders', async () => {
    const status = await new ExternalRestorer({ command: 'esrgan -i {in}' }).available();
    expect(status.available).toBe(false);
  });

  it('runs the command and scales whatever comes back to the original size', async () => {
    // `cp` stands in for Real-ESRGAN: the contract under test is the file
    // handoff, not the model. Nothing here touches a network.
    const restorer = new ExternalRestorer({ command: 'cp {in} {out}' });
    const result = await restorer.restore(await fadedPrint());
    expect(result.width).toBe(WIDTH);
    expect(result.height).toBe(HEIGHT);
    expect(result.steps).toEqual(['cp']);
  });

  it('reports a command that is not there instead of failing silently', async () => {
    const restorer = new ExternalRestorer({
      command: 'definitely-not-installed-restorer -i {in} -o {out}',
    });
    await expect(restorer.restore(await crisp())).rejects.toThrow(/could not be started/);
  });

  it('is only used when RESTORER_CMD is set', () => {
    expect(externalRestorerFromEnv({})).toBeUndefined();
    expect(resolveRestorer({ RESTORER_CMD: 'cp {in} {out}' }).id).toBe('cp');
  });
});

describe('the words next to the before and after', () => {
  it('claims nothing the numbers do not support', () => {
    const same = { contrastRange: 0.9, saturation: 0.4, meanLuma: 120, detail: 400 };
    expect(describeEnhancement(same, same)).toMatch(/already in good shape/i);

    const better = { contrastRange: 0.98, saturation: 0.45, meanLuma: 128, detail: 430 };
    const sentence = describeEnhancement(same, better);
    expect(sentence).toMatch(/brought the light back/);
    expect(sentence).toMatch(/go back to it/);
  });
});
