/**
 * The arithmetic half of an SCRFD face detector.
 *
 * A detector is two things: a neural network, and a pile of index arithmetic
 * that turns its output tensors into rectangles. The network needs a runtime
 * and a 3 MB file; the arithmetic needs neither, so it lives here on its own
 * where it can be unit-tested with hand-written tensors. When the ONNX engine
 * is misdecoding boxes — which is the failure this code exists to prevent — the
 * tests here are what tell you so, on a machine with no model on it.
 *
 * SCRFD (and the InsightFace family generally) emits, per stride, a score per
 * anchor and four *distances* from the anchor centre to the box edges, in
 * units of the stride. Everything below is that, plus letterboxing and
 * non-maximum suppression.
 */

export type ScoredBox = {
  /** Pixel coordinates in the letterboxed network input. */
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  score: number;
};

/** How a picture is fitted into a square network input without distorting it. */
export type Letterbox = {
  scale: number;
  padX: number;
  padY: number;
  width: number;
  height: number;
};

export function letterbox(sourceWidth: number, sourceHeight: number, target: number): Letterbox {
  const scale = Math.min(target / sourceWidth, target / sourceHeight);
  const width = Math.round(sourceWidth * scale);
  const height = Math.round(sourceHeight * scale);
  return {
    scale,
    padX: Math.floor((target - width) / 2),
    padY: Math.floor((target - height) / 2),
    width,
    height,
  };
}

export type DecodeStrideInput = {
  /** Flat [N] or [N,1] score tensor for this stride. */
  scores: ArrayLike<number>;
  /** Flat [N,4] distance tensor: left, top, right, bottom, in stride units. */
  distances: ArrayLike<number>;
  stride: number;
  inputWidth: number;
  inputHeight: number;
  /** SCRFD's 500m/10g models use two anchors per position. */
  numAnchors?: number;
  threshold?: number;
};

/**
 * One stride's tensors → boxes in network-input pixels.
 *
 * The anchor order is the one every InsightFace export uses: row-major over the
 * feature map, with the anchors of a position adjacent. Getting this wrong does
 * not crash — it puts boxes in plausible-looking wrong places, which is exactly
 * why it is tested.
 */
export function decodeScrfdStride(input: DecodeStrideInput): ScoredBox[] {
  const { scores, distances, stride, inputWidth, inputHeight } = input;
  const numAnchors = input.numAnchors ?? 2;
  const threshold = input.threshold ?? 0.5;

  const cols = Math.ceil(inputWidth / stride);
  const rows = Math.ceil(inputHeight / stride);
  const out: ScoredBox[] = [];

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      for (let anchor = 0; anchor < numAnchors; anchor += 1) {
        const index = (row * cols + col) * numAnchors + anchor;
        if (index >= scores.length) return out;
        const score = scores[index] as number;
        if (!(score >= threshold)) continue;

        const base = index * 4;
        const cx = col * stride;
        const cy = row * stride;
        out.push({
          x1: cx - (distances[base] as number) * stride,
          y1: cy - (distances[base + 1] as number) * stride,
          x2: cx + (distances[base + 2] as number) * stride,
          y2: cy + (distances[base + 3] as number) * stride,
          score,
        });
      }
    }
  }
  return out;
}

export function intersectionOverUnion(a: ScoredBox, b: ScoredBox): number {
  const x1 = Math.max(a.x1, b.x1);
  const y1 = Math.max(a.y1, b.y1);
  const x2 = Math.min(a.x2, b.x2);
  const y2 = Math.min(a.y2, b.y2);
  const overlap = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  if (overlap <= 0) return 0;
  const areaA = Math.max(0, a.x2 - a.x1) * Math.max(0, a.y2 - a.y1);
  const areaB = Math.max(0, b.x2 - b.x1) * Math.max(0, b.y2 - b.y1);
  const union = areaA + areaB - overlap;
  return union <= 0 ? 0 : overlap / union;
}

/** Highest score wins; overlapping weaker boxes are dropped. Deterministic. */
export function nonMaximumSuppression(
  boxes: readonly ScoredBox[],
  iouThreshold = 0.4,
): ScoredBox[] {
  const ordered = [...boxes].sort((a, b) => b.score - a.score || a.x1 - b.x1 || a.y1 - b.y1);
  const kept: ScoredBox[] = [];
  for (const box of ordered) {
    if (kept.some((other) => intersectionOverUnion(box, other) > iouThreshold)) continue;
    kept.push(box);
  }
  return kept;
}

/**
 * Network-input pixels → the original photograph, as fractions of its own size.
 * Clamped, because a detector will happily predict a chin below the frame.
 */
export function boxToFraction(
  box: ScoredBox,
  frame: Letterbox,
  sourceWidth: number,
  sourceHeight: number,
): { x: number; y: number; w: number; h: number } {
  const x1 = (box.x1 - frame.padX) / frame.scale;
  const y1 = (box.y1 - frame.padY) / frame.scale;
  const x2 = (box.x2 - frame.padX) / frame.scale;
  const y2 = (box.y2 - frame.padY) / frame.scale;

  const left = clamp(x1 / sourceWidth, 0, 1);
  const top = clamp(y1 / sourceHeight, 0, 1);
  const right = clamp(x2 / sourceWidth, 0, 1);
  const bottom = clamp(y2 / sourceHeight, 0, 1);

  return {
    x: left,
    y: top,
    w: Math.max(1e-6, right - left),
    h: Math.max(1e-6, bottom - top),
  };
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}
