// Alerta simples: loga e, se ALERT_URL existir (.env), empurra para o celular (ntfy.sh).
import { readFileSync, existsSync } from "node:fs";

function alertUrl() {
  if (process.env.ALERT_URL) return process.env.ALERT_URL;
  if (!existsSync(".env")) return "";
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const m = line.match(/^\s*ALERT_URL\s*=\s*"?([^"\n]+)"?\s*$/);
    if (m) return m[1];
  }
  return "";
}

const URL = alertUrl();

export async function alert(title, message, tags = "bell", priority = "default") {
  const stamp = new Date().toISOString().slice(11, 19);
  console.log(`[${stamp}] ALERTA | ${title} | ${message}`);
  if (!URL) return;
  try {
    await fetch(URL, {
      method: "POST",
      headers: { Title: title, Tags: tags, Priority: priority, Markdown: "yes" },
      body: message,
    });
  } catch {}
}

alert.configured = Boolean(URL);
alert.url = URL;
