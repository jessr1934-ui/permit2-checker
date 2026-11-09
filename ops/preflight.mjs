/// Pre-flight de um alvo ANTES de pedir assinatura.
/// Uso: node ops/preflight.mjs 0xALVO [0xALVO2 ...]
/// Diz: EOA/contrato/delegado, se aceita ERC-1271, o que tem saldo E aprovacao ao Permit2, e o veredito.
import { getAddress, JsonRpcProvider, Contract, Interface, formatUnits } from "ethers";
import { loadEnv, TOKENS } from "./lib.mjs";

const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const BLOCKSCOUT = "https://eth.blockscout.com/api/v2";
const provider = new JsonRpcProvider(process.env.RPC_URL || "https://ethereum-rpc.publicnode.com", 1, { staticNetwork: true });
const erc20 = new Interface(["function allowance(address,address) view returns (uint256)"]);
const erc1271 = new Interface(["function isValidSignature(bytes32,bytes) view returns (bytes4)"]);

async function discover(owner) {
  const out = new Map();
  for (const [symbol, meta] of Object.entries(TOKENS)) out.set(meta.address.toLowerCase(), { symbol, ...meta });
  try {
    const r = await fetch(`${BLOCKSCOUT}/addresses/${owner}/token-balances`);
    if (r.ok) {
      for (const x of (await r.json()) ?? []) {
        const t = x?.token;
        if (!t || t.type !== "ERC-20" || !t.address_hash) continue;
        try {
          if (BigInt(x.value) === 0n) continue;
        } catch { continue; }
        out.set(t.address_hash.toLowerCase(), { symbol: (t.symbol || "?").slice(0, 12), address: t.address_hash, decimals: Number(t.decimals ?? 18) });
      }
    }
  } catch {}
  return [...out.values()];
}

const targets = process.argv.slice(2).map((a) => getAddress(a));
if (!targets.length) throw new Error("uso: node ops/preflight.mjs 0xALVO");

for (const target of targets) {
  console.log(`\n=== ${target} ===`);
  const code = await provider.getCode(target);
  const kind = code === "0x" ? "EOA" : code.startsWith("0xef0100") ? "delegado-7702 -> 0x" + code.slice(8, 48) : "contrato";

  let r1271 = "n/a";
  if (code !== "0x") {
    try {
      const ret = await provider.call({
        to: target,
        data: erc1271.encodeFunctionData("isValidSignature", ["0x" + "ab".repeat(32), "0x" + "00".repeat(65)]),
      });
      r1271 = ret && ret.length >= 10 ? `implementa (${ret.slice(0, 10)})` : "responde vazio";
    } catch {
      r1271 = "revert";
    }
  }
  console.log(`tipo        : ${kind}`);
  if (code !== "0x") console.log(`isValidSignature: ${r1271}`);

  const tokens = await discover(target);
  const prontos = [];
  const saldoSemApproval = [];
  for (const t of tokens) {
    try {
      const bal = await new Contract(t.address, ["function balanceOf(address) view returns (uint256)"], provider).balanceOf(target);
      if (bal === 0n) continue;
      const allow = await provider.call({ to: t.address, data: erc20.encodeFunctionData("allowance", [target, PERMIT2]) });
      const allowWei = BigInt(allow);
      (allowWei > 0n ? prontos : saldoSemApproval).push(`${t.symbol} ${formatUnits(bal, t.decimals)}`);
    } catch {}
  }

  console.log(`com saldo E aprovacao ao Permit2 : ${prontos.join(", ") || "-"}`);
  if (saldoSemApproval.length) console.log(`com saldo SEM aprovacao          : ${saldoSemApproval.join(", ")}`);

  let veredito;
  if (!prontos.length) veredito = "NADA A LEVAR (pedir assinatura nao paga o gas)";
  else if (code === "0x") veredito = "PRONTO (ECDSA)";
  else if (/implementa/.test(r1271)) veredito = "PRONTO via ERC-1271 (assinatura do dono e validada pela conta)";
  else veredito = "RISCO: conta com code sem isValidSignature -> assinatura ECDSA falha; usar o caminho 7702";
  console.log(`veredito    : ${veredito}`);
}
void loadEnv;
