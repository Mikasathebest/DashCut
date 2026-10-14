/* eslint-disable @typescript-eslint/no-require-imports */
const { createReadStream } = require("node:fs");
const { stat } = require("node:fs/promises");
const path = require("node:path");
const { Readable } = require("node:stream");

const scheme = "dashcut-media";
const mimeTypes = {
  ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".mkv": "video/x-matroska",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp",
  ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".aac": "audio/aac", ".wav": "audio/wav", ".ogg": "audio/ogg", ".flac": "audio/flac",
};

/** Must run before app ready: lets <video>, fetch and canvas treat project media like normal web media. */
function registerMediaScheme(protocol) {
  protocol.registerSchemesAsPrivileged([{ scheme, privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true } }]);
}

function mediaUrl(absolutePath) {
  return `${scheme}://local/${encodeURIComponent(absolutePath)}`;
}

/** Serves only files the renderer explicitly registered (imported or opened), with byte-range support for seeking. */
function handleMediaScheme(protocol) {
  const allowed = new Set();
  protocol.handle(scheme, async (request) => {
    const target = decodeURIComponent(new URL(request.url).pathname.slice(1));
    if (!allowed.has(target)) return new Response("Forbidden", { status: 403 });
    let info;
    try {
      info = await stat(target);
    } catch {
      return new Response("Not found", { status: 404 });
    }
    const headers = { "content-type": mimeTypes[path.extname(target).toLowerCase()] ?? "application/octet-stream", "accept-ranges": "bytes", "access-control-allow-origin": "*" };
    const range = /bytes=(\d*)-(\d*)/.exec(request.headers.get("range") ?? "");
    if (range && (range[1] || range[2])) {
      const start = range[1] ? Number(range[1]) : Math.max(0, info.size - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), info.size - 1) : info.size - 1;
      if (start >= info.size || end < start) return new Response(null, { status: 416, headers: { "content-range": `bytes */${info.size}` } });
      return new Response(Readable.toWeb(createReadStream(target, { start, end })), { status: 206, headers: { ...headers, "content-length": String(end - start + 1), "content-range": `bytes ${start}-${end}/${info.size}` } });
    }
    return new Response(Readable.toWeb(createReadStream(target)), { status: 200, headers: { ...headers, "content-length": String(info.size) } });
  });
  return {
    allow(paths) {
      return paths.map((item) => {
        if (typeof item !== "string" || !path.isAbsolute(item)) return "";
        allowed.add(item);
        return mediaUrl(item);
      });
    },
  };
}

module.exports = { handleMediaScheme, mediaUrl, registerMediaScheme, scheme };
