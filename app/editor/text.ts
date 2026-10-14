// Title/text rendering shared by preview and export so both show the same pixels.
import type { TextStyle } from "./model";

export const defaultTextStyle: TextStyle = {
  content: "双击编辑文字",
  fontFamily: '"PingFang SC", "Microsoft YaHei", Arial, sans-serif',
  fontSize: 72,
  color: "#ffffff",
  bold: true,
  italic: false,
  align: "center",
  strokeColor: "#000000",
  strokeWidth: 0,
  backgroundColor: "#000000",
  backgroundOpacity: 0,
  shadow: true,
};

export const textPresets: Array<{ id: string; label: string; style: Partial<TextStyle> }> = [
  { id: "title", label: "大标题", style: { content: "大标题", fontSize: 110, bold: true, shadow: true } },
  { id: "subtitle", label: "副标题", style: { content: "副标题文字", fontSize: 56, bold: false, color: "#e8ecf5" } },
  { id: "outline", label: "描边大字", style: { content: "描边大字", fontSize: 96, color: "#ffe14d", strokeColor: "#1a1a1a", strokeWidth: 8, shadow: false } },
  { id: "banner", label: "字幕条", style: { content: "这里是一段说明文字", fontSize: 48, bold: false, backgroundColor: "#101318", backgroundOpacity: 0.72, shadow: false } },
  { id: "tag", label: "标签", style: { content: "#关键词", fontSize: 44, color: "#101318", backgroundColor: "#ffcc45", backgroundOpacity: 1, shadow: false } },
  { id: "serif", label: "衬线", style: { content: "章节标题", fontFamily: 'Georgia, "Songti SC", serif', fontSize: 84, bold: false, italic: true } },
];

const paddingRatio = 0.35;

function font(style: TextStyle, scale: number) {
  return `${style.italic ? "italic " : ""}${style.bold ? "700" : "400"} ${style.fontSize * scale}px ${style.fontFamily}`;
}

/** Box size in px at 1080p reference (before any canvas scaling). */
export function measureText(style: TextStyle, context?: CanvasRenderingContext2D) {
  const ctx = context ?? document.createElement("canvas").getContext("2d")!;
  ctx.font = font(style, 1);
  const lines = (style.content || " ").split("\n");
  const width = Math.max(...lines.map((line) => ctx.measureText(line || " ").width));
  const lineHeight = style.fontSize * 1.25;
  const padding = style.fontSize * paddingRatio + style.strokeWidth;
  return { width: Math.ceil(width + padding * 2), height: Math.ceil(lineHeight * lines.length + padding * 2), lines, lineHeight, padding };
}

/** Draws the text box at `scale` (canvas px per 1080p px) into a new transparent canvas. */
export function renderText(style: TextStyle, scale: number) {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;
  const box = measureText(style, ctx);
  canvas.width = Math.max(1, Math.round(box.width * scale));
  canvas.height = Math.max(1, Math.round(box.height * scale));
  ctx.scale(scale, scale);
  if (style.backgroundOpacity > 0) {
    ctx.globalAlpha = style.backgroundOpacity;
    ctx.fillStyle = style.backgroundColor;
    const radius = Math.min(style.fontSize * 0.2, box.height / 2);
    ctx.beginPath();
    ctx.roundRect(0, 0, box.width, box.height, radius);
    ctx.fill();
    ctx.globalAlpha = 1;
  }
  ctx.font = font(style, 1);
  ctx.textBaseline = "middle";
  ctx.textAlign = style.align;
  ctx.lineJoin = "round";
  const x = style.align === "left" ? box.padding : style.align === "right" ? box.width - box.padding : box.width / 2;
  box.lines.forEach((line, index) => {
    const y = box.padding + box.lineHeight * (index + 0.5);
    if (style.strokeWidth > 0) {
      ctx.strokeStyle = style.strokeColor;
      ctx.lineWidth = style.strokeWidth * 2;
      ctx.strokeText(line, x, y);
    }
    if (style.shadow) {
      ctx.shadowColor = "rgba(0,0,0,.55)";
      ctx.shadowBlur = style.fontSize * 0.12;
      ctx.shadowOffsetY = style.fontSize * 0.04;
    }
    ctx.fillStyle = style.color;
    ctx.fillText(line, x, y);
    ctx.shadowColor = "transparent";
  });
  return { canvas, box };
}

/** Raw RGBA bytes for the exporter, rendered at the export canvas height. */
export function rasterizeText(style: TextStyle, canvasHeight: number) {
  const { canvas, box } = renderText(style, canvasHeight / 1080);
  const data = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
  return { bytes: new Uint8Array(data.buffer.slice(0)), width: canvas.width, height: canvas.height, boxWidth: box.width, boxHeight: box.height };
}
