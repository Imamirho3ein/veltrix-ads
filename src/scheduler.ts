import type { Bot } from "grammy";
import { env } from "./config.js";
import { PROMOS, promoKeyboard } from "./promos.js";
import { getState, saveState } from "./store.js";

type AdsBot = Bot;

function log(message: string): void {
  console.log(`[ads] ${new Date().toISOString()} ${message}`);
}

/** Posts the next promo in the rotation to the configured channel. */
export async function postNextPromo(bot: AdsBot, manual = false): Promise<boolean> {
  if (!env.channelId) {
    log("ADS_CHANNEL_ID is not set — nothing to post to.");
    return false;
  }

  const state = await getState();
  const promo = PROMOS[state.nextIndex % PROMOS.length]!;
  const nextIndex = (state.nextIndex + 1) % PROMOS.length;

  try {
    await bot.api.sendMessage(env.channelId, promo.text, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: promoKeyboard(promo),
    });
  } catch (error) {
    log(`could not post promo ${promo.id} to ${env.channelId}: ${String(error)}`);
    // Do not advance the rotation on failure; retry the same promo later.
    return false;
  }

  await saveState({
    nextIndex,
    postsSent: state.postsSent + 1,
    lastPostAt: new Date().toISOString(),
  });
  log(`posted promo ${promo.id} (${promo.label})${manual ? " [manual]" : ""}`);
  return true;
}

function effectiveIntervalMinutes(stateInterval: number): number {
  return stateInterval > 0 ? stateInterval : env.intervalMinutes;
}

/**
 * Long-running scheduler loop. Uses a self-rescheduling timeout (not a bare
 * setInterval) so each tick can react to the latest on/off state and interval.
 */
export async function runScheduler(bot: AdsBot): Promise<void> {
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  for (;;) {
    const state = await getState();
    const minutes = effectiveIntervalMinutes(state.intervalMinutes);

    if (!state.enabled) {
      log("scheduler is off — sleeping 5 minutes");
      await sleep(5 * 60_000);
      if (stopping) return;
      continue;
    }

    await postNextPromo(bot);
    log(`next auto post in ${minutes} minute(s)`);
    await sleep(minutes * 60_000);
    if (stopping) return;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
