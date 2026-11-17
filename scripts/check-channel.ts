import { readFileSync } from "node:fs";

const envFile = readFileSync(".env", "utf8");
const tokenLine = envFile.split(/\r?\n/).find((l) => l.startsWith("ADS_BOT_TOKEN="));
const channelLine = envFile.split(/\r?\n/).find((l) => l.startsWith("ADS_CHANNEL_ID="));
if (!tokenLine || !channelLine) throw new Error("missing env vars");
const token = tokenLine.split("=").slice(1).join("=").trim();
const channel = channelLine.split("=").slice(1).join("=").trim().replace(/^"|"$/g, "");

const res = await fetch(
  `https://api.telegram.org/bot${token}/getChatMember?chat_id=${encodeURIComponent(channel)}&user_id=8677999670`,
);
const data = await res.json();
console.log(JSON.stringify(data, null, 2));
if (data.ok) {
  console.log(`BOT ROLE IN CHANNEL: ${data.result.status}`);
}
