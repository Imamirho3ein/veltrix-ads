import { readFileSync } from "node:fs";

const env = readFileSync(".env", "utf8");
const line = env.split(/\r?\n/).find((l) => l.startsWith("ADS_BOT_TOKEN="));
if (!line) throw new Error("ADS_BOT_TOKEN not found in .env");
const token = line.split("=").slice(1).join("=").trim();

const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
const data = await res.json();
if (!data.ok) throw new Error(JSON.stringify(data));
console.log(`ADS BOT: @${data.result.username} — "${data.result.first_name}" — token valid ✓`);
