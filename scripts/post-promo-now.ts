import "dotenv/config";
import { Bot } from "grammy";
import { env } from "../src/config.js";
import { postNextPromo } from "../src/scheduler.js";

const bot = new Bot(env.token);
const posted = await postNextPromo(bot, true);
console.log(posted ? "✅ First promo posted to the channel." : "❌ Post failed — check logs above.");
process.exit(0);
