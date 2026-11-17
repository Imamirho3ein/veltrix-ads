import type { Bot, InlineKeyboard } from "grammy";
import { env } from "./config.js";
import { PROMOS, promoKeyboard } from "./promos.js";
import { getState, saveState, type AdsState } from "./store.js";
import { broadcast } from "./broadcast.js";

type AdsBot = Bot;

function log(message: string): void {
  console.log(`[ads] ${new Date().toISOString()} ${message}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Primary channel from env + dynamically registered channels/groups. */
export async function resolveTargets(state: AdsState): Promise<string[]> {
  const ids = [env.channelId, ...state.targets.map((target) => target.id)];
  return [...new Set(ids.filter((id): id is string => Boolean(id)))];
}

/**
 * Posts the next promo in the rotation to every registered target
 * (channels and groups). One shared rotation keeps campaigns consistent.
 */
export async function postNextPromo(bot: AdsBot, manual = false): Promise<boolean> {
  const state = await getState();
  const promo = PROMOS[state.nextIndex % PROMOS.length]!;
  const nextIndex = (state.nextIndex + 1) % PROMOS.length;
  const targets = await resolveTargets(state);

  if (targets.length === 0) {
    log("no targets configured — set ADS_CHANNEL_ID or add the bot as admin to a channel/group.");
    return false;
  }

  let sent = 0;
  for (const [index, target] of targets.entries()) {
    if (index > 0) await sleep(800); // polite spacing between chats
    try {
      await bot.api.sendMessage(target, promo.text, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        reply_markup: promoKeyboard(promo),
      });
      sent += 1;
    } catch (error) {
      log(`could not post promo ${promo.id} to ${target}: ${String(error).slice(0, 160)}`);
    }
  }

  if (sent > 0) {
    await saveState({
      nextIndex,
      postsSent: state.postsSent + sent,
      lastPostAt: new Date().toISOString(),
    });
    log(`posted promo ${promo.id} (${promo.label}) to ${sent}/${targets.length} target(s)${manual ? " [manual]" : ""}`);
  }
  return sent > 0;
}

/** Sends one rotating promo as a DM to every subscriber. */
export async function dmPromoToSubscribers(bot: AdsBot): Promise<number> {
  const state = await getState();
  const promo = PROMOS[state.nextIndex % PROMOS.length]!;
  const keyboard = promoKeyboard(promo);
  const result = await broadcast(bot, promo.text, undefined, keyboard);
  log(`DM campaign "${promo.id}": sent=${result.sent} failed=${result.failed}`);
  return result.sent;
}

function effectiveIntervalMinutes(stateInterval: number): number {
  return stateInterval > 0 ? stateInterval : env.intervalMinutes;
}

/** Sleep in 60s slices so SIGTERM and config changes are noticed quickly. */
async function sleepSliced(totalMinutes: number, stopping: () => boolean): Promise<void> {
  const end = Date.now() + totalMinutes * 60_000;
  while (Date.now() < end && !stopping()) {
    await sleep(Math.min(60_000, end - Date.now()));
  }
}

/**
 * Two concurrent loops: channel/group posting and periodic DM campaigns.
 */
export async function runScheduler(bot: AdsBot): Promise<void> {
  let stopping = false;
  const isStopping = () => stopping;
  const stop = () => {
    stopping = true;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  const postLoop = async (): Promise<void> => {
    for (;;) {
      if (stopping) return;
      const state = await getState();
      if (!state.enabled) {
        await sleepSliced(5, isStopping);
        continue;
      }
      await postNextPromo(bot);
      const minutes = effectiveIntervalMinutes(state.intervalMinutes);
      log(`next auto post in ${minutes} minute(s)`);
      await sleepSliced(minutes, isStopping);
    }
  };

  const dmLoop = async (): Promise<void> => {
    // Wait a bit after boot so the first DM campaign is not merged with deploys.
    for (;;) {
      if (stopping) return;
      const state = await getState();
      const interval = state.dmIntervalMinutes;
      if (state.dmEnabled && interval > 0) {
        const last = state.lastDmAt ? Date.parse(state.lastDmAt) : 0;
        const due = Date.now() - last >= interval * 60_000;
        // Also fire the very first campaign ~1 minute after boot.
        const firstRun = last === 0 && Date.now() - processStartTime >= 60_000;
        if (due || firstRun) {
          await dmPromoToSubscribers(bot);
          await saveState({ lastDmAt: new Date().toISOString() });
        }
      }
      await sleepSliced(1, isStopping);
    }
  };

  await Promise.all([postLoop(), dmLoop()]);
}

const processStartTime = Date.now();
