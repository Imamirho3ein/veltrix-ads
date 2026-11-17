import type { Bot } from "grammy";
import { listSubscribers } from "./store.js";

const SEND_GAP_MS = 60; // ≈16 msg/s, well inside Telegram's 30 msg/s budget

export interface BroadcastResult {
  sent: number;
  failed: number;
  total: number;
}

/**
 * Sends one text message to every subscriber with polite rate limiting.
 * Blocks (fails silently for) users who stopped the bot.
 */
export async function broadcast(
  bot: Bot,
  text: string,
  onProgress?: (sent: number, total: number) => void,
): Promise<BroadcastResult> {
  const subscribers = await listSubscribers();
  let sent = 0;
  let failed = 0;

  for (const [index, subscriber] of subscribers.entries()) {
    try {
      await bot.api.sendMessage(subscriber.id, text, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
      sent += 1;
    } catch {
      // 403 (blocked bot), 400 (chat not found) … — count and continue.
      failed += 1;
    }
    onProgress?.(index + 1, subscribers.length);
    await new Promise((resolve) => setTimeout(resolve, SEND_GAP_MS));
  }

  return { sent, failed, total: subscribers.length };
}
