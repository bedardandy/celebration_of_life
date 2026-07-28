/**
 * The prompt for looking at a family's photographs.
 *
 * Two things matter here. The model is describing someone's mother, so the tone
 * rules are not decoration: no guessing at identities, no inventing occasions,
 * no sentimental narration. And every image has to come back tied to the row it
 * belongs to, which is what the asset lines are for — the batch job writes them
 * and the mock provider reads them back, so the two can never drift apart.
 */

export const ASSET_LINE_SEPARATOR = ' :: ';

/** One line per photo: the id we need back, and the file to look at. */
export function assetLine(assetId: string, filePath: string): string {
  return `- ${assetId}${ASSET_LINE_SEPARATOR}${filePath}`;
}

export type ParsedAssetLine = {
  assetId: string;
  path: string;
  /** File name only — how canned fixture analyses are keyed. */
  basename: string;
};

const ASSET_LINE_RE = /^-\s*(\S+)\s::\s(.+)$/;

export function parseAssetLines(text: string): ParsedAssetLine[] {
  const out: ParsedAssetLine[] = [];
  for (const line of text.split('\n')) {
    const match = ASSET_LINE_RE.exec(line.trim());
    if (!match) continue;
    const assetId = match[1];
    const filePath = match[2]?.trim();
    if (!assetId || !filePath) continue;
    out.push({
      assetId,
      path: filePath,
      basename: filePath.split(/[\\/]/).pop() ?? filePath,
    });
  }
  return out;
}

export const PHOTO_ANALYSIS_SYSTEM_PROMPT = [
  'You are helping a family choose photographs for a memorial slideshow.',
  '',
  'For each photograph, describe only what is visibly there. Do not guess at',
  'names or relationships, do not invent an occasion, and do not narrate feeling',
  'into a picture that does not show it — a plain description is more useful to',
  'this family than a moving one.',
  '',
  'Rate slideSuitability on how well the image carries a full screen for four',
  'seconds: framing, focus, whether the faces are large enough to read from the',
  'back of a room. A blurry or badly cropped photo can still be precious, so',
  'score it honestly and let the family decide.',
  '',
  'suggestedCaption, if you offer one, must be a short factual line the family',
  'could edit — never a sentiment they did not express.',
].join('\n');

export type PhotoAnalysisSubject = {
  fullName: string;
  knownAs?: string;
  birthYear?: number;
  deathYear?: number;
};

export type PhotoAnalysisAsset = {
  assetId: string;
  path: string;
  /** EXIF capture year, when the file had one. Suppresses the era guess. */
  capturedYear?: number;
};

export function buildPhotoAnalysisPrompt(input: {
  subject: PhotoAnalysisSubject;
  assets: readonly PhotoAnalysisAsset[];
}): string {
  const { subject, assets } = input;
  const lines: string[] = [];
  const years =
    subject.birthYear && subject.deathYear
      ? ` (${subject.birthYear}–${subject.deathYear})`
      : subject.birthYear
        ? ` (born ${subject.birthYear})`
        : '';

  lines.push(`These photographs belong to a memorial for ${subject.fullName}${years}.`);
  if (subject.knownAs) lines.push(`Most people called them ${subject.knownAs}.`);
  lines.push(
    '',
    'Analyse the images at these paths. Return one entry per id, using exactly',
    'the ids given here:',
    '',
  );
  for (const asset of assets) lines.push(assetLine(asset.assetId, asset.path));

  const dated = assets.filter((a) => a.capturedYear !== undefined);
  if (dated.length > 0) {
    lines.push(
      '',
      'Known capture years (use these instead of guessing an era for them):',
      ...dated.map((a) => `- ${a.assetId}: ${a.capturedYear}`),
    );
  }
  lines.push('', 'Leave eraGuess out entirely when you genuinely cannot tell.');
  return lines.join('\n');
}
