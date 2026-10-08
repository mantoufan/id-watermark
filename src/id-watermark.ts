export type Anchor =
  | "tl"
  | "tc"
  | "tr"
  | "ml"
  | "mc"
  | "mr"
  | "bl"
  | "bc"
  | "br";

export type Position =
  | { mode: "anchor"; anchor: Anchor }
  | { mode: "free"; x: number; y: number };

export interface TextSpec {
  text: string;
  fontFamily: string;
  fontWeight: string;
  fontSizeRatio: number;
  color: string;
  opacity: number;
  rotate: number;
  stroke: boolean;
  strokeColor: string;
}

export interface LogoSpec {
  image: CanvasImageSource;
  naturalWidth: number;
  naturalHeight: number;
  scale: number;
  opacity: number;
  rotate: number;
}

export type RedactMode = "mosaic" | "black";

/** A redaction box in 0–1 ratios of the image, so it survives preview and export scaling. */
export interface Redaction {
  x: number;
  y: number;
  w: number;
  h: number;
  mode: RedactMode;
}

export interface WatermarkSpec {
  redactions?: Redaction[];
  /** Mosaic cell as a ratio of the image's shorter side. */
  mosaicRatio?: number;
  text: TextSpec | null;
  logo: LogoSpec | null;
  position: Position;
  tiled: boolean;
  tileGapRatio: number;
}

export const MAX_PIXELS = 25_000_000;

export function boxAtAnchor(
  anchor: Anchor,
  canvasW: number,
  canvasH: number,
  boxW: number,
  boxH: number,
  pad: number,
): { x: number; y: number } {
  const maxX = Math.max(pad, canvasW - boxW - pad);
  const maxY = Math.max(pad, canvasH - boxH - pad);
  const cx = (canvasW - boxW) / 2;
  const cy = (canvasH - boxH) / 2;
  const x =
    anchor.endsWith("l") ? pad : anchor.endsWith("r") ? maxX : cx;
  const y =
    anchor.startsWith("t") ? pad : anchor.startsWith("b") ? maxY : cy;
  return { x, y };
}

export function boxAtFree(
  xRatio: number,
  yRatio: number,
  canvasW: number,
  canvasH: number,
  boxW: number,
  boxH: number,
): { x: number; y: number } {
  const x = xRatio * canvasW - boxW / 2;
  const y = yRatio * canvasH - boxH / 2;
  return { x, y };
}

export function fitExportSize(
  width: number,
  height: number,
  maxPixels = MAX_PIXELS,
): { width: number; height: number; scaled: boolean } {
  const pixels = width * height;
  if (pixels <= maxPixels || pixels <= 0) {
    return { width, height, scaled: false };
  }
  const scale = Math.sqrt(maxPixels / pixels);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    scaled: true,
  };
}

export function renderWatermark(
  source: CanvasImageSource,
  sourceW: number,
  sourceH: number,
  spec: WatermarkSpec,
  targetW = sourceW,
  targetH = sourceH,
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(targetW));
  canvas.height = Math.max(1, Math.round(targetH));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas");
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  for (const r of spec.redactions ?? []) {
    redact(ctx, canvas.width, canvas.height, r, spec.mosaicRatio ?? 0.03);
  }
  if (spec.logo) drawLogo(ctx, canvas.width, canvas.height, spec, spec.logo);
  if (spec.text && spec.text.text.trim()) {
    drawText(ctx, canvas.width, canvas.height, spec, spec.text);
  }
  return canvas;
}

/** Pixel box for a ratio box, clamped to the canvas. Null when it covers no pixels. */
export function redactionBox(
  r: Pick<Redaction, "x" | "y" | "w" | "h">,
  w: number,
  h: number,
): { x: number; y: number; w: number; h: number } | null {
  const x0 = clamp(Math.floor(Math.min(r.x, r.x + r.w) * w), 0, w);
  const y0 = clamp(Math.floor(Math.min(r.y, r.y + r.h) * h), 0, h);
  const x1 = clamp(Math.ceil(Math.max(r.x, r.x + r.w) * w), 0, w);
  const y1 = clamp(Math.ceil(Math.max(r.y, r.y + r.h) * h), 0, h);
  if (x1 - x0 < 1 || y1 - y0 < 1) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Mosaic cell size in pixels. Never below 6 px so text under it stays unreadable. */
export function mosaicCell(w: number, h: number, ratio: number): number {
  return Math.max(6, Math.round(minDim(w, h) * clamp(ratio, 0.005, 0.2)));
}

/** Average every cell×cell block in place. Exact mean, not a resampled guess. */
export function pixelate(data: Uint8ClampedArray, w: number, h: number, cell: number): void {
  for (let by = 0; by < h; by += cell) {
    const bh = Math.min(cell, h - by);
    for (let bx = 0; bx < w; bx += cell) {
      const bw = Math.min(cell, w - bx);
      let r = 0, g = 0, b = 0, a = 0;
      for (let y = by; y < by + bh; y++) {
        let i = (y * w + bx) * 4;
        for (let x = 0; x < bw; x++, i += 4) {
          r += data[i]; g += data[i + 1]; b += data[i + 2]; a += data[i + 3];
        }
      }
      const n = bw * bh;
      r = Math.round(r / n); g = Math.round(g / n); b = Math.round(b / n); a = Math.round(a / n);
      for (let y = by; y < by + bh; y++) {
        let i = (y * w + bx) * 4;
        for (let x = 0; x < bw; x++, i += 4) {
          data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = a;
        }
      }
    }
  }
}

function redact(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  r: Redaction,
  mosaicRatio: number,
): void {
  const box = redactionBox(r, w, h);
  if (!box) return;
  if (r.mode === "black") {
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#000";
    ctx.fillRect(box.x, box.y, box.w, box.h);
    ctx.restore();
    return;
  }
  const img = ctx.getImageData(box.x, box.y, box.w, box.h);
  pixelate(img.data, box.w, box.h, mosaicCell(w, h, mosaicRatio));
  ctx.putImageData(img, box.x, box.y);
}

function minDim(w: number, h: number): number {
  return Math.min(w, h);
}

/** Grid pitch for tiled marks. Ratio 0 is tight but not overlapping; higher is looser. */
export function tilePitch(
  boxW: number,
  boxH: number,
  ratio: number,
): { x: number; y: number } {
  const t = Math.max(0, ratio);
  return {
    x: Math.max(8, boxW * (1.08 + t * 1.6)),
    y: Math.max(8, boxH * (1.2 + t * 1.6)),
  };
}

function drawText(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  spec: WatermarkSpec,
  text: TextSpec,
): void {
  const size = Math.max(8, minDim(w, h) * text.fontSizeRatio);
  const font = `${text.fontWeight} ${size}px ${text.fontFamily}`;
  const lines = text.text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return;

  ctx.save();
  ctx.font = font;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const lineHeight = size * 1.25;
  const widths = lines.map((line) => ctx.measureText(line).width);
  const boxW = Math.max(...widths);
  const boxH = lineHeight * lines.length;
  const paint = () => {
    ctx.font = font;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = text.color;
    ctx.strokeStyle = text.strokeColor;
    ctx.lineWidth = Math.max(1, size * 0.08);
    ctx.lineJoin = "round";
    lines.forEach((line, i) => {
      const y = (i - (lines.length - 1) / 2) * lineHeight;
      if (text.stroke) ctx.strokeText(line, 0, y);
      ctx.fillText(line, 0, y);
    });
  };

  stamp(ctx, w, h, spec, boxW, boxH, text.opacity, text.rotate, paint);
  ctx.restore();
}

function drawLogo(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  spec: WatermarkSpec,
  logo: LogoSpec,
): void {
  const markW = Math.max(1, w * logo.scale);
  const ratio = logo.naturalHeight / Math.max(1, logo.naturalWidth);
  const markH = Math.max(1, markW * ratio);
  const paint = () => {
    ctx.drawImage(logo.image, -markW / 2, -markH / 2, markW, markH);
  };
  stamp(ctx, w, h, spec, markW, markH, logo.opacity, logo.rotate, paint);
}

function stamp(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  spec: WatermarkSpec,
  boxW: number,
  boxH: number,
  opacity: number,
  rotate: number,
  paint: () => void,
): void {
  ctx.save();
  ctx.globalAlpha = clamp(opacity, 0, 1);
  const rad = (rotate * Math.PI) / 180;

  if (spec.tiled) {
    const pitch = tilePitch(boxW, boxH, spec.tileGapRatio);
    const diag = Math.hypot(w, h);
    ctx.translate(w / 2, h / 2);
    ctx.rotate(rad);
    for (let y = -diag; y <= diag; y += pitch.y) {
      for (let x = -diag; x <= diag; x += pitch.x) {
        ctx.save();
        ctx.translate(x, y);
        paint();
        ctx.restore();
      }
    }
  } else {
    const pad = minDim(w, h) * 0.04;
    const topLeft =
      spec.position.mode === "anchor"
        ? boxAtAnchor(spec.position.anchor, w, h, boxW, boxH, pad)
        : boxAtFree(spec.position.x, spec.position.y, w, h, boxW, boxH);
    ctx.translate(topLeft.x + boxW / 2, topLeft.y + boxH / 2);
    ctx.rotate(rad);
    paint();
  }
  ctx.restore();
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}
