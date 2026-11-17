import "dotenv/config";

function clean(value: string | undefined): string {
  return (value ?? "").trim();
}

function num(value: string | undefined, fallback: number): number {
  const parsed = Number(clean(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const env = {
  token: clean(process.env.ADS_BOT_TOKEN ?? process.env.TELEGRAM_BOT_TOKEN),
  adminIds: clean(process.env.ADMIN_TELEGRAM_IDS)
    .split(/[,\s]+/)
    .map((item) => Number(item))
    .filter((id) => Number.isSafeInteger(id) && id > 0),
  channelId: clean(process.env.ADS_CHANNEL_ID ?? process.env.TELEGRAM_CHANNEL_ID),
  /** Minutes between automatic promo posts (default: every 3 hours). */
  intervalMinutes: num(process.env.ADS_INTERVAL_MINUTES, 180),
  /** Main order bot that promo buttons deep-link into. */
  mainBotUsername: clean(process.env.MAIN_BOT_USERNAME) || "VeltrixStudio_bot",
  channelUrl: clean(process.env.TELEGRAM_CHANNEL_URL) || "https://t.me/VeeltrixStudio",
  supportUrl: clean(process.env.TELEGRAM_SUPPORT_URL) || "https://t.me/ImAmirh3ein",
  siteUrl: (clean(process.env.SITE_URL) || "https://veltrixstudio.com").replace(/\/+$/, ""),
  instagramUrl: clean(process.env.INSTAGRAM_URL) || "https://instagram.com/veltrixstudio",
  email: clean(process.env.CONTACT_EMAIL) || "hello@veltrixstudio.com",
  brandName: clean(process.env.BRAND_NAME) || "VELTRIX STUDIO",
};

export function assertConfig(): void {
  if (!env.token) {
    throw new Error(
      "ADS_BOT_TOKEN is missing. Create a bot with @BotFather and put its token in .env.",
    );
  }
}

/** Deep-link into the main bot carrying the promo id as the start payload. */
export function mainBotLink(payload: string): string {
  return `https://t.me/${env.mainBotUsername}?start=${payload}`;
}
