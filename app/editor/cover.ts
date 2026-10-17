// Cover designs are a flat stack of image and text layers on a solid background.
// Positions and sizes are fractions of the canvas so a design survives a ratio change.

export type CoverImage = {
  id: string;
  kind: "image";
  src: string;
  /** Box in canvas fractions; the picture fills it and is centre-cropped ("cover") or letterboxed ("contain"). */
  x: number;
  y: number;
  w: number;
  h: number;
  fit: "cover" | "contain";
  /** Width / height of the source picture, used to keep proportions while resizing. */
  aspect: number;
  /** Fills the whole canvas under everything else (a picked video frame or uploaded backdrop). */
  background?: boolean;
  /** Timeline time the picture was taken from, when it is a video frame. */
  frameTime?: number;
};

export type CoverText = {
  id: string;
  kind: "text";
  text: string;
  /** Top-left of the text block in canvas fractions. */
  x: number;
  y: number;
  /** Font size as a fraction of the canvas height. */
  size: number;
  font: string;
  color: string;
  bold: boolean;
  italic: boolean;
  align: "left" | "center" | "right";
  stroke: string | null;
  /** Stroke width as a fraction of the font size. */
  strokeWidth: number;
  shadow: boolean;
  /** Fill colour of a box behind the text, or null for none. */
  box: string | null;
};

export type CoverLayer = CoverImage | CoverText;
export type CoverDesign = { background: string; layers: CoverLayer[] };
export type Rect = { x: number; y: number; w: number; h: number };

export const emptyCover = (): CoverDesign => ({ background: "#10141d", layers: [] });

export const coverFonts: Array<{ label: string; value: string }> = [
  { label: "苹方 / 雅黑", value: "\"PingFang SC\", \"Microsoft YaHei\", \"Noto Sans CJK SC\", sans-serif" },
  { label: "宋体", value: "\"Songti SC\", \"SimSun\", \"Noto Serif CJK SC\", serif" },
  { label: "楷体", value: "\"Kaiti SC\", \"KaiTi\", \"STKaiti\", serif" },
  { label: "黑体（粗）", value: "\"Hiragino Sans GB\", \"SimHei\", \"Heiti SC\", sans-serif" },
  { label: "Helvetica", value: "\"Helvetica Neue\", Helvetica, Arial, sans-serif" },
  { label: "Georgia", value: "Georgia, \"Times New Roman\", serif" },
  { label: "Impact", value: "Impact, \"Arial Black\", sans-serif" },
  { label: "Courier", value: "\"Courier New\", Courier, monospace" },
];

let counter = 0;
export const layerId = () => `cover-${Date.now().toString(36)}-${(counter += 1)}`;

export function newText(text = ""): CoverText {
  return { id: layerId(), kind: "text", text, x: 0.08, y: 0.4, size: 0.1, font: coverFonts[0].value, color: "#ffffff", bold: true, italic: false, align: "left", stroke: null, strokeWidth: 0.08, shadow: true, box: null };
}

/** An image placed at its own proportions, as large as fits in about half the canvas. */
export function newImage(src: string, aspect: number, canvasAspect: number, index = 0): CoverImage {
  const maxW = 0.5;
  const maxH = 0.6;
  let w = maxW;
  let h = (w * canvasAspect) / aspect;
  if (h > maxH) {
    h = maxH;
    w = (h * aspect) / canvasAspect;
  }
  const offset = (index % 5) * 0.04;
  return { id: layerId(), kind: "image", src, x: (1 - w) / 2 + offset, y: (1 - h) / 2 + offset, w, h, fit: "cover", aspect };
}

export function backgroundImage(src: string, aspect: number, frameTime?: number): CoverImage {
  return { id: layerId(), kind: "image", src, x: 0, y: 0, w: 1, h: 1, fit: "cover", aspect, background: true, ...(frameTime === undefined ? {} : { frameTime }) };
}

/** Puts a background picture at the bottom of the stack, replacing any previous one. */
export function setBackground(design: CoverDesign, layer: CoverImage): CoverDesign {
  return { ...design, layers: [layer, ...design.layers.filter((item) => !(item.kind === "image" && item.background))] };
}

export type CollageLayout = "row" | "column" | "grid" | "feature";

/** Cells for `count` pictures, `gap` in canvas-width fractions so gutters look equal both ways. */
export function collageCells(layout: CollageLayout, count: number, gap: number, canvasAspect: number): Rect[] {
  if (count <= 0) return [];
  const gx = gap;
  const gy = gap * canvasAspect;
  const grid = (cols: number, rows: number, x0 = 0, y0 = 0, width = 1, height = 1): Rect[] => {
    const w = (width - gx * (cols + 1)) / cols;
    const h = (height - gy * (rows + 1)) / rows;
    const cells: Rect[] = [];
    for (let row = 0; row < rows; row += 1) for (let col = 0; col < cols; col += 1) cells.push({ x: x0 + gx + col * (w + gx), y: y0 + gy + row * (h + gy), w, h });
    return cells;
  };
  if (layout === "row") return grid(count, 1);
  if (layout === "column") return grid(1, count);
  if (layout === "grid") {
    const cols = Math.ceil(Math.sqrt(count));
    return grid(cols, Math.ceil(count / cols)).slice(0, count);
  }
  // One large picture on the left, the rest stacked in a column on the right.
  if (count === 1) return grid(1, 1);
  const bigW = (1 - gx * 3) * (2 / 3);
  const big = { x: gx, y: gy, w: bigW, h: 1 - gy * 2 };
  const right = grid(1, count - 1, gx + bigW, 0, 1 - gx - bigW, 1);
  return [big, ...right];
}

/** Arranges every non-background picture into a collage, in stacking order. */
export function applyCollage(design: CoverDesign, layout: CollageLayout, gap: number, canvasAspect: number): CoverDesign {
  const pictures = design.layers.filter((layer): layer is CoverImage => layer.kind === "image" && !layer.background);
  const cells = collageCells(layout, pictures.length, gap, canvasAspect);
  const placed = new Map(pictures.map((layer, index) => [layer.id, { ...layer, ...cells[index], fit: "cover" as const }]));
  return { ...design, layers: design.layers.map((layer) => placed.get(layer.id) ?? layer) };
}

export function normalizeCover(input: unknown): CoverDesign {
  const value = input as Partial<CoverDesign> | null | undefined;
  const fallback = emptyCover();
  if (!value || typeof value !== "object" || !Array.isArray(value.layers)) return fallback;
  const layers = value.layers.filter((layer): layer is CoverLayer => Boolean(layer) && typeof layer === "object" && (layer.kind === "image" ? typeof layer.src === "string" : layer.kind === "text" && typeof layer.text === "string"))
    .map((layer) => layer.kind === "text" ? { ...newText(), ...layer } : layer);
  return { background: typeof value.background === "string" ? value.background : fallback.background, layers };
}

/* ---------------------------------------------------------------- rendering */

const lineHeight = 1.25;

function fontString(layer: CoverText, height: number) {
  return `${layer.italic ? "italic " : ""}${layer.bold ? 800 : 500} ${Math.max(4, layer.size * height)}px ${layer.font}`;
}

/** Pixel bounds of a layer on a `width × height` canvas (text boxes include their padding). */
export function layerBounds(ctx: CanvasRenderingContext2D, layer: CoverLayer, width: number, height: number): Rect {
  if (layer.kind === "image") return { x: layer.x * width, y: layer.y * height, w: layer.w * width, h: layer.h * height };
  const px = layer.size * height;
  ctx.font = fontString(layer, height);
  const lines = (layer.text || " ").split("\n");
  const textWidth = Math.max(px * 0.5, ...lines.map((line) => ctx.measureText(line).width));
  const pad = layer.box ? px * 0.3 : 0;
  return { x: layer.x * width, y: layer.y * height, w: textWidth + pad * 2, h: lines.length * px * lineHeight + pad * 2 };
}

function drawPicture(ctx: CanvasRenderingContext2D, image: CanvasImageSource & { width: number; height: number }, box: Rect, fit: "cover" | "contain") {
  const scale = fit === "cover" ? Math.max(box.w / image.width, box.h / image.height) : Math.min(box.w / image.width, box.h / image.height);
  const w = image.width * scale;
  const h = image.height * scale;
  ctx.save();
  ctx.beginPath();
  ctx.rect(box.x, box.y, box.w, box.h);
  ctx.clip();
  ctx.drawImage(image, box.x + (box.w - w) / 2, box.y + (box.h - h) / 2, w, h);
  ctx.restore();
}

function drawText(ctx: CanvasRenderingContext2D, layer: CoverText, width: number, height: number) {
  const bounds = layerBounds(ctx, layer, width, height);
  const px = layer.size * height;
  const pad = layer.box ? px * 0.3 : 0;
  if (layer.box) {
    ctx.fillStyle = layer.box;
    const radius = Math.min(px * 0.25, bounds.h / 2);
    ctx.beginPath();
    ctx.roundRect(bounds.x, bounds.y, bounds.w, bounds.h, radius);
    ctx.fill();
  }
  ctx.font = fontString(layer, height);
  ctx.textBaseline = "middle";
  ctx.textAlign = layer.align;
  ctx.lineJoin = "round";
  const inner = bounds.w - pad * 2;
  const anchor = bounds.x + pad + (layer.align === "center" ? inner / 2 : layer.align === "right" ? inner : 0);
  layer.text.split("\n").forEach((line, index) => {
    const y = bounds.y + pad + (index + 0.5) * px * lineHeight;
    ctx.save();
    if (layer.shadow) {
      ctx.shadowColor = "rgba(0,0,0,.55)";
      ctx.shadowBlur = px * 0.18;
      ctx.shadowOffsetY = px * 0.05;
    }
    if (layer.stroke && layer.strokeWidth > 0) {
      ctx.strokeStyle = layer.stroke;
      ctx.lineWidth = px * layer.strokeWidth * 2;
      ctx.strokeText(line, anchor, y);
      ctx.shadowColor = "transparent";
    }
    ctx.fillStyle = layer.color;
    ctx.fillText(line, anchor, y);
    ctx.restore();
  });
}

/** Draws the design; pictures that have not loaded yet are skipped and drawn on the next pass. */
export function drawCover(ctx: CanvasRenderingContext2D, design: CoverDesign, width: number, height: number, images: Map<string, HTMLImageElement>) {
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = design.background;
  ctx.fillRect(0, 0, width, height);
  const ordered = [...design.layers.filter((layer) => layer.kind === "image" && layer.background), ...design.layers.filter((layer) => !(layer.kind === "image" && layer.background))];
  for (const layer of ordered) {
    if (layer.kind === "image") {
      const image = images.get(layer.src);
      if (image?.complete && image.naturalWidth) drawPicture(ctx, image, layerBounds(ctx, layer, width, height), layer.fit);
    } else if (layer.text) drawText(ctx, layer, width, height);
  }
}

/** Renders a design off-screen once its pictures have loaded; returns "" for an empty design. */
export async function renderCoverImage(design: CoverDesign, width: number, height: number, type = "image/png") {
  if (!design.layers.length) return "";
  const sources = [...new Set(design.layers.flatMap((layer) => layer.kind === "image" ? [layer.src] : []))];
  const images = new Map(await Promise.all(sources.map((src) => new Promise<[string, HTMLImageElement]>((resolve) => {
    const image = new Image();
    image.onload = image.onerror = () => resolve([src, image]);
    image.src = src;
  }))));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  drawCover(ctx, design, width, height, images);
  return canvas.toDataURL(type, 0.85);
}
