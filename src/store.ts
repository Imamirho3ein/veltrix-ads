import { promises as fs } from "node:fs";
import path from "node:path";

export const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(process.cwd(), "data");

const SUBSCRIBERS_FILE = path.join(DATA_DIR, "subscribers.json");
const STATE_FILE = path.join(DATA_DIR, "state.json");

let lock: Promise<unknown> = Promise.resolve();

function serialize<T>(task: () => Promise<T>): Promise<T> {
  const run = lock.then(task, task);
  lock = run.catch(() => undefined);
  return run;
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value, null, 2), "utf8");
  await fs.rename(temp, file);
}

// ---------------------------------------------------------------------------
// Subscribers: private-chat users who have /started this bot. They opted in,
// so admin broadcasts can reach them.
// ---------------------------------------------------------------------------

export interface Subscriber {
  id: number;
  firstName?: string;
  username?: string;
  joinedAt: string;
}

export async function listSubscribers(): Promise<Subscriber[]> {
  return readJson<Subscriber[]>(SUBSCRIBERS_FILE, []);
}

export async function saveSubscriber(
  user: { id: number; first_name?: string; username?: string },
): Promise<boolean> {
  return serialize(async () => {
    const subscribers = await readJson<Subscriber[]>(SUBSCRIBERS_FILE, []);
    if (subscribers.some((subscriber) => subscriber.id === user.id)) return false;
    subscribers.push({
      id: user.id,
      firstName: user.first_name,
      username: user.username,
      joinedAt: new Date().toISOString(),
    });
    await writeJson(SUBSCRIBERS_FILE, subscribers);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Scheduler state: rotation index, enabled flag and interval override.
// ---------------------------------------------------------------------------

export interface AdsTarget {
  id: string;
  title?: string;
}

export interface AdsState {
  /** Index into PROMOS for the next automatic post. */
  nextIndex: number;
  enabled: boolean;
  /** Effective posting interval in minutes (0 = use env default). */
  intervalMinutes: number;
  postsSent: number;
  lastPostAt?: string;
  /** Extra channels/groups where promos are posted (auto-registered via my_chat_member). */
  targets: AdsTarget[];
  /** Periodic promo DM to subscribers. */
  dmEnabled: boolean;
  /** Minutes between DM campaigns (0 = disabled). */
  dmIntervalMinutes: number;
  lastDmAt?: string;
}

const DEFAULT_STATE: AdsState = {
  nextIndex: 0,
  enabled: true,
  intervalMinutes: 0,
  postsSent: 0,
  targets: [],
  dmEnabled: true,
  dmIntervalMinutes: 1440,
};

export async function getState(): Promise<AdsState> {
  return { ...DEFAULT_STATE, ...(await readJson<AdsState>(STATE_FILE, {} as AdsState)) };
}

export async function saveState(update: Partial<AdsState>): Promise<AdsState> {
  return serialize(async () => {
    const current = await getState();
    const next = { ...current, ...update };
    await writeJson(STATE_FILE, next);
    return next;
  });
}

export async function addTarget(id: string, title?: string): Promise<boolean> {
  return serialize(async () => {
    const state = await getState();
    if (state.targets.some((target) => target.id === id)) return false;
    await writeJson(STATE_FILE, {
      ...state,
      targets: [...state.targets, { id, title }],
    });
    return true;
  });
}

export async function removeTarget(id: string): Promise<boolean> {
  return serialize(async () => {
    const state = await getState();
    const targets = state.targets.filter((target) => target.id !== id);
    if (targets.length === state.targets.length) return false;
    await writeJson(STATE_FILE, { ...state, targets });
    return true;
  });
}
