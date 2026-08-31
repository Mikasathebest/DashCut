import { access, stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function safeAssetPath(clientRoot, pathname) {
  const decoded = decodeURIComponent(pathname).replace(/^\/+/, "");
  const candidate = path.resolve(clientRoot, decoded || "index.html");
  return candidate.startsWith(`${path.resolve(clientRoot)}${path.sep}`) ? candidate : null;
}

async function assetResponse(clientRoot, request) {
  const url = new URL(typeof request === "string" ? request : request.url);
  const filePath = safeAssetPath(clientRoot, url.pathname);
  if (!filePath) return new Response("Not found", { status: 404 });
  try {
    await access(filePath);
    const info = await stat(filePath);
    if (!info.isFile()) return new Response("Not found", { status: 404 });
    const bytes = await import("node:fs/promises").then(({ readFile }) => readFile(filePath));
    return new Response(bytes, {
      status: 200,
      headers: {
        "content-type": MIME_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream",
        "cache-control": url.pathname.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}

async function requestBody(req) {
  if (req.method === "GET" || req.method === "HEAD") return undefined;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? Buffer.concat(chunks) : undefined;
}

export async function startAppServer({ rootDir, hostname = "127.0.0.1", port = 0 }) {
  const clientRoot = path.join(rootDir, "dist", "client");
  const workerPath = path.join(rootDir, "dist", "server", "index.js");
  const worker = (await import(`${pathToFileURL(workerPath).href}?desktop=${Date.now()}`)).default;
  const server = http.createServer(async (req, res) => {
    try {
      const origin = `http://${hostname}:${server.address()?.port ?? port}`;
      const url = new URL(req.url ?? "/", origin);
      const directAsset = await assetResponse(clientRoot, url.href);
      const isAsset = directAsset.status === 200 && url.pathname !== "/";
      const response = isAsset
        ? directAsset
        : await worker.fetch(
            new Request(url, { method: req.method, headers: req.headers, body: await requestBody(req) }),
            { ASSETS: { fetch: (assetRequest) => assetResponse(clientRoot, assetRequest) } },
            { waitUntil() {}, passThroughOnException() {} },
          );
      res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      if (req.method === "HEAD" || !response.body) return res.end();
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      console.error("DashCut desktop server error", error);
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end("DashCut failed to start");
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, hostname, resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Desktop server did not bind to a TCP port");
  return {
    server,
    url: `http://${hostname}:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}
