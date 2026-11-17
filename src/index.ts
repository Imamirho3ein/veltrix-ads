import { Bot, InlineKeyboard } from "grammy";
import { assertConfig, env } from "./config.js";
import { startHealthServer } from "./health.js";
import { PROMOS, findPromo, promoKeyboard } from "./promos.js";
import { postNextPromo, runScheduler, resolveTargets, dmPromoToSubscribers } from "./scheduler.js";
import { broadcast } from "./broadcast.js";
import {
  getState,
  saveState,
  saveSubscriber,
  listSubscribers,
  addTarget,
  removeTarget,
  type AdsState,
} from "./store.js";

function isAdmin(userId?: number): boolean {
  return userId !== undefined && env.adminIds.includes(userId);
}

function adminOnly(): string {
  return "⛔️ این دستور فقط برای مدیران است.";
}

function fmtMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} دقیقه`;
  const hours = minutes / 60;
  return Number.isInteger(hours) ? `${hours} ساعت` : `${hours.toFixed(1)} ساعت`;
}

function welcomeText(name?: string): string {
  return `سلام${name ? ` ${name}` : ""} 👋
به ربات تبلیغات <b>${env.brandName}</b> خوش آمدید.

🎉 پیشنهادهای ویژه، نمونه‌کارهای جدید و خدماتی که کسب‌وکارت را چند برابر
می‌کنند، همین‌جا به تو اعلام می‌شود.

برای دیدن خدمات و ثبت سفارش، ربات اصلی ما: @${env.mainBotUsername}`;
}

// ---------------------------------------------------------------------------
// Pending broadcast confirmations (admin → quick in-memory state).
// ---------------------------------------------------------------------------

const pendingBroadcast = new Map<number, string>();

async function statusText(): Promise<string> {
  const state = await getState();
  const subscribers = await listSubscribers();
  const minutes = state.intervalMinutes > 0 ? state.intervalMinutes : env.intervalMinutes;
  const nextPromo = PROMOS[state.nextIndex % PROMOS.length]!;
  const lastPost = state.lastPostAt
    ? new Date(state.lastPostAt).toLocaleString("fa-IR")
    : "—";

  return `📊 <b>وضعیت تبلیغات</b>

🟢 خودکار: <b>${state.enabled ? "روشن" : "خاموش"}</b>
⏱ فاصلهٔ پست‌ها: <b>${fmtMinutes(minutes)}</b>
📤 پست‌های ارسال‌شده: <b>${state.postsSent}</b>
🕐 آخرین پست: <b>${lastPost}</b>
➡️ پست بعدی: <b>${nextPromo.label}</b> (${nextPromo.id})
👥 مشترکین ربات: <b>${subscribers.length}</b>
📣 کانال اصلی: <code>${env.channelId || "تنظیم نشده"}</code>
🎯 همهٔ تارگت‌ها: <b>${(await resolveTargets(state)).length}</b> (کانال/گروه)
📬 DM دوره‌ای: <b>${state.dmEnabled && state.dmIntervalMinutes > 0 ? fmtMinutes(state.dmIntervalMinutes) : "خاموش"}</b>
🕐 آخرین کمپین DM: <b>${state.lastDmAt ? new Date(state.lastDmAt).toLocaleString("fa-IR") : "—"}</b>

دستورها:
/ads_on — روشن‌کردن پست خودکار کانال/گروه‌ها
/ads_off — خاموش‌کردن پست خودکار
/ads_now — ارسال فوری پست بعدی به همهٔ تارگت‌ها
/ads_list — فهرست کمپین‌ها
/ads_post ads_5 — ارسال یک کمپین خاص
/ads_set 180 — تنظیم فاصلهٔ پست‌ها (دقیقه)
/ads_targets — فهرست کانال‌ها و گروه‌های ثبت‌شده
/ads_addtarget @channel — افزودن تارگت
/ads_removetarget @channel — حذف تارگت
/ads_dm_on / /ads_dm_off — کمپین پیوی به مشترکین
/ads_dm_set 720 — فاصلهٔ کمپین پیوی (دقیقه)
/ads_dm_now — ارسال فوری کمپین پیوی
/broadcast متن — پیام دلخواه به مشترکین
/stats — آمار کامل`;
}

async function main(): Promise<void> {
  assertConfig();
  startHealthServer();

  const bot = new Bot(env.token);

  bot.catch((error) => {
    console.error("[ads] handler error", error.error ?? error);
  });

  // Every private-chat user becomes a subscriber (opt-in) for broadcasts.
  bot.command("start", async (ctx) => {
    if (ctx.chat.type !== "private" || !ctx.from) return;
    const isNew = await saveSubscriber({
      id: ctx.from.id,
      first_name: ctx.from.first_name,
      username: ctx.from.username,
    });
    if (isAdmin(ctx.from.id)) {
      await ctx.reply(await statusText(), { parse_mode: "HTML" });
      return;
    }
    await ctx.reply(welcomeText(ctx.from.first_name), {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: new InlineKeyboard()
        .url(`🚀 سفارش پروژه در ربات اصلی`, `https://t.me/${env.mainBotUsername}`)
        .url(`📣 کانال ${env.brandName}`, env.channelUrl)
        .row()
        .url("🌐 وب‌سایت", env.siteUrl),
    });
    // Immediate promo DM (rotated by user id so different users see different ads).
    const promo = PROMOS[ctx.from.id % PROMOS.length]!;
    try {
      await ctx.reply(promo.text, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        reply_markup: promoKeyboard(promo),
      });
    } catch {
      // Best-effort; welcome message already delivered.
    }
    if (isNew) {
      console.log(`[ads] new subscriber ${ctx.from.id} (@${ctx.from.username ?? "—"})`);
    }
  });

  // Auto-register channels/groups where the bot gains posting access, and
  // unregister when kicked/left — "add the bot as admin" is the whole setup.
  bot.on("my_chat_member", async (ctx) => {
    const chat = ctx.myChatMember?.chat;
    if (!chat || chat.type === "private") return;
    const status = ctx.myChatMember.new_chat_member.status;
    const id = String(chat.id);
    const active = status === "member" || status === "administrator" || status === "creator";
    try {
      if (active) {
        const added = await addTarget(id, chat.title);
        if (added) {
          console.log(`[ads] target auto-registered: ${chat.type} ${id} (${chat.title ?? "—"})`);
        }
      } else if (status === "kicked" || status === "left") {
        const removed = await removeTarget(id);
        if (removed) {
          console.log(`[ads] target removed: ${chat.type} ${id}`);
        }
      }
    } catch (error) {
      console.warn("[ads] my_chat_member handling failed", error);
    }
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(welcomeText(ctx.from?.first_name), { parse_mode: "HTML" });
  });

  // ------------------------------------------------------------------ admin

  bot.command("ads_status", async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return void (await ctx.reply(adminOnly()));
    await ctx.reply(await statusText(), { parse_mode: "HTML" });
  });

  bot.command("ads_on", async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return void (await ctx.reply(adminOnly()));
    await saveState({ enabled: true });
    await ctx.reply("🟢 پست‌های خودکار تبلیغاتی روشن شد.");
  });

  bot.command("ads_off", async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return void (await ctx.reply(adminOnly()));
    await saveState({ enabled: false });
    await ctx.reply("🔴 پست‌های خودکار خاموش شد. (/ads_on برای روشن‌کردن)");
  });

  bot.command("ads_now", async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return void (await ctx.reply(adminOnly()));
    const posted = await postNextPromo(bot, true);
    await ctx.reply(
      posted ? "✅ پست بعدی در کانال ارسال شد." : "❌ ارسال ناموفق بود. لاگ‌ها را بررسی کن.",
    );
  });

  bot.command("ads_list", async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return void (await ctx.reply(adminOnly()));
    const state = await getState();
    const lines = PROMOS.map((promo, index) => {
      const marker = index === state.nextIndex ? "➡️" : "•";
      return `${marker} ${promo.id} — ${promo.label}`;
    });
    await ctx.reply(`📋 <b>کمپین‌های تبلیغاتی</b>\n\n${lines.join("\n")}`, {
      parse_mode: "HTML",
    });
  });

  bot.command("ads_post", async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return void (await ctx.reply(adminOnly()));
    const id = ctx.match.trim();
    const promo = findPromo(id);
    if (!promo) {
      await ctx.reply(`کمپینی با شناسهٔ <code>${id || "—"}</code> پیدا نشد. /ads_list`, {
        parse_mode: "HTML",
      });
      return;
    }
    try {
      await bot.api.sendMessage(env.channelId, promo.text, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        reply_markup: promoKeyboard(promo),
      });
      const state = await getState();
      await saveState({
        postsSent: state.postsSent + 1,
        lastPostAt: new Date().toISOString(),
      });
      await ctx.reply(`✅ کمپین ${promo.id} (${promo.label}) ارسال شد.`);
    } catch (error) {
      console.error("[ads] manual post failed", error);
      await ctx.reply("❌ ارسال ناموفق بود — احتمالاً ربات ادمین کانال نیست.");
    }
  });

  bot.command("ads_skip", async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return void (await ctx.reply(adminOnly()));
    const state = await getState();
    const nextIndex = (state.nextIndex + 1) % PROMOS.length;
    await saveState({ nextIndex });
    await ctx.reply(`⏭ رد شد؛ پست بعدی: ${PROMOS[nextIndex]!.label}`);
  });

  bot.command("ads_set", async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return void (await ctx.reply(adminOnly()));
    const raw = ctx.match.trim().toLowerCase();
    const match = raw.match(/^(\d+)\s*(m|h|دقیقه|ساعت)?$/);
    if (!match) {
      await ctx.reply("فرمت: /ads_set 180 (دقیقه) یا /ads_set 3h (ساعت)");
      return;
    }
    const value = Number(match[1]!);
    const unit = match[2] ?? "m";
    const minutes = unit === "h" || unit === "ساعت" ? value * 60 : value;
    if (minutes < 10 || minutes > 24 * 60) {
      await ctx.reply("فاصلهٔ مجاز: بین ۱۰ دقیقه تا ۲۴ ساعت.");
      return;
    }
    await saveState({ intervalMinutes: minutes });
    await ctx.reply(`✅ فاصلهٔ پست‌های خودکار روی ${fmtMinutes(minutes)} تنظیم شد.`);
  });

  // --------------------------------------------------------------- targets

  bot.command("ads_targets", async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return void (await ctx.reply(adminOnly()));
    const state: AdsState = await getState();
    const lines: string[] = [];
    if (env.channelId) lines.push(`• <code>${env.channelId}</code> — کانال اصلی (از env)`);
    for (const target of state.targets) {
      lines.push(`• <code>${target.id}</code>${target.title ? ` — ${target.title}` : ""}`);
    }
    await ctx.reply(
      `🎯 <b>تارگت‌های تبلیغات (${lines.length})</b>\n\n${lines.join("\n") || "هیچ تارگتی نیست"}\n\n💡 ربات را در هر کانال/گروهی که ادمین می‌کنی، خودکار ثبت می‌کند و تبلیغ آنجا هم ارسال می‌شود.`,
      { parse_mode: "HTML" },
    );
  });

  bot.command("ads_addtarget", async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return void (await ctx.reply(adminOnly()));
    const id = ctx.match.trim();
    if (!id) {
      await ctx.reply("فرمت: /ads_addtarget @channelname یا -1001234567890");
      return;
    }
    try {
      const chat = await bot.api.getChat(id);
      const added = await addTarget(String(chat.id), chat.title);
      await ctx.reply(
        added
          ? `✅ تارگت ثبت شد: <code>${chat.id}</code>${chat.title ? ` (${chat.title})` : ""}`
          : "این تارگت قبلاً ثبت شده است.",
        { parse_mode: "HTML" },
      );
    } catch {
      await ctx.reply("❌ پیدا نشد. مطمئن شو ربات در آن کانال/گروه ادمین (یا عضو) است و شناسه درست است.");
    }
  });

  bot.command("ads_removetarget", async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return void (await ctx.reply(adminOnly()));
    const id = ctx.match.trim();
    if (!id) {
      await ctx.reply("فرمت: /ads_removetarget @channelname یا -1001234567890");
      return;
    }
    const removed = await removeTarget(id);
    await ctx.reply(removed ? "🗑 حذف شد." : "این تارگت در لیست نبود.");
  });

  // ------------------------------------------------------------------- DMs

  bot.command("ads_dm_on", async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return void (await ctx.reply(adminOnly()));
    await saveState({ dmEnabled: true });
    await ctx.reply("📬 کمپین پیوی به مشترکین روشن شد.");
  });

  bot.command("ads_dm_off", async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return void (await ctx.reply(adminOnly()));
    await saveState({ dmEnabled: false });
    await ctx.reply("🔕 کمپین پیوی خاموش شد.");
  });

  bot.command("ads_dm_set", async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return void (await ctx.reply(adminOnly()));
    const raw = ctx.match.trim().toLowerCase();
    const match = raw.match(/^(\d+)\s*(m|h|دقیقه|ساعت)?$/);
    if (!match) {
      await ctx.reply("فرمت: /ads_dm_set 720 (دقیقه) یا /ads_dm_set 12h");
      return;
    }
    const value = Number(match[1]!);
    const unit = match[2] ?? "m";
    const minutes = unit === "h" || unit === "ساعت" ? value * 60 : value;
    if (minutes < 60 || minutes > 7 * 24 * 60) {
      await ctx.reply("فاصلهٔ مجاز DM: بین ۱ ساعت تا ۷ روز (برای جلوگیری از رپورت، هر روز یک بار توصیه می‌شود).");
      return;
    }
    await saveState({ dmIntervalMinutes: minutes });
    await ctx.reply(`✅ فاصلهٔ کمپین پیوی روی ${fmtMinutes(minutes)} تنظیم شد.`);
  });

  bot.command("ads_dm_now", async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return void (await ctx.reply(adminOnly()));
    const sent = await dmPromoToSubscribers(bot);
    await saveState({ lastDmAt: new Date().toISOString() });
    await ctx.reply(`✅ کمپین پیوی ارسال شد — موفق: ${sent}`);
  });

  bot.command("stats", async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return void (await ctx.reply(adminOnly()));
    const subscribers = await listSubscribers();
    const state = await getState();
    const withUsername = subscribers.filter((s) => s.username).length;
    await ctx.reply(
      `📈 <b>آمار جذب</b>\n\n👥 مشترکین: ${subscribers.length}\n✍️ دارای یوزرنیم: ${withUsername}\n📤 پست‌های ارسال‌شده در کانال: ${state.postsSent}\n🕐 آخرین پست: ${
        state.lastPostAt ? new Date(state.lastPostAt).toLocaleString("fa-IR") : "—"
      }`,
      { parse_mode: "HTML" },
    );
  });

  bot.command("broadcast", async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return void (await ctx.reply(adminOnly()));
    const text = ctx.match.trim();
    if (!text) {
      await ctx.reply("متن پیام را بنویس: /broadcast 🎉 تخفیف ویژهٔ زمستان…");
      return;
    }
    const subscribers = await listSubscribers();
    pendingBroadcast.set(ctx.from!.id, text);
    const keyboard = new InlineKeyboard()
      .text(`✅ ارسال به ${subscribers.length} نفر`, "broadcast:confirm")
      .row()
      .text("❌ انصراف", "broadcast:cancel");
    await ctx.reply(
      `📬 <b>پیش‌نمایش پیام همگانی</b>\n\n${text}\n\n📤 ارسال به ${subscribers.length} مشترک؟`,
      { parse_mode: "HTML", reply_markup: keyboard },
    );
  });

  bot.callbackQuery(/^broadcast:(confirm|cancel)$/, async (ctx) => {
    if (!isAdmin(ctx.from?.id)) {
      await ctx.answerCallbackQuery({ text: adminOnly(), show_alert: true });
      return;
    }
    const text = pendingBroadcast.get(ctx.from!.id);
    if (ctx.match[1] === "cancel" || !text) {
      pendingBroadcast.delete(ctx.from!.id);
      await ctx.answerCallbackQuery("لغو شد.");
      await ctx.editMessageReplyMarkup();
      return;
    }
    pendingBroadcast.delete(ctx.from!.id);
    await ctx.answerCallbackQuery("در حال ارسال…");
    await ctx.editMessageReplyMarkup();
    const notice = await ctx.reply("📤 در حال ارسال…");
    const result = await broadcast(bot, text);
    await bot.api.editMessageText(
      notice.chat.id,
      notice.message_id,
      `✅ ارسال تمام شد.\n\n📤 موفق: ${result.sent}\n⚠️ ناموفق (ریتایر/بلاک): ${result.failed}\n👥 کل مشترکین: ${result.total}`,
    );
  });

  bot.on("message:text", async (ctx) => {
    if (ctx.chat.type !== "private") return;
    await ctx.reply("برای شروع /start را بزنید یا با ربات اصلی @VeltrixStudio_bot در تماس باشید.");
  });

  // The scheduler posts the first promo right after boot and then repeats on
  // the configured interval, so the channel always has fresh content.
  void runScheduler(bot).catch((error) => console.error("[ads] scheduler crashed", error));

  console.log(`[ads] starting ${env.brandName} ads bot (long polling)…`);
  await bot.start({
    onStart: (info) => console.log(`[ads] @${info.username} is up and running.`),
  });
}

void main().catch((error) => {
  console.error("[ads] fatal error:", error);
  process.exit(1);
});
