/// Gera docs/ (copia publicada no GitHub Pages) a partir de web/.
/// Uso: API_BASE=https://xxxx.trycloudflare.com node ops/build-docs.mjs
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from "node:fs";
const API_BASE = process.env.API_BASE ?? process.argv[2] ?? "";
mkdirSync("docs", { recursive: true });
for (const f of ["app.js", "style.css"]) copyFileSync(`web/${f}`, `docs/${f}`);
let html = readFileSync("web/index.html", "utf8");
if (API_BASE) html = html.replace('<meta charset="utf-8" />', `<meta charset="utf-8" />\n  <meta name="api" content="${API_BASE}" />`);
writeFileSync("docs/index.html", html);
writeFileSync("docs/.nojekyll", "");
console.log(`docs/ gerado | API_BASE=${API_BASE || "(same-origin)"}`);
if (!existsSync("docs/index.html")) process.exit(1);
