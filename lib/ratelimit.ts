// In-memory rate limiter using sliding window counters.
// Suitable for single-process or PM2 cluster (per-worker counting is acceptable for demo scale).

type WindowEntry = { count: number; resetAt: number };

const store = new Map<string, WindowEntry>();

const WINDOW_MS = 60_000; // 1 minute

// Limits per (userId, route) per minute
const LIMITS: Record<string, number> = {
  "POST:/api/meeting": 5,
  "POST:/api/meetings/ask": 20,
  "POST:/api/projects/ask": 20,
};
const DEFAULT_LIMIT = 30;

export function checkRateLimit(
  userId: string,
  method: string,
  routeKey: string, // e.g. "POST:/api/meeting"
): { allowed: boolean; remaining: number; resetAt: number } {
  const limit = LIMITS[routeKey] ?? DEFAULT_LIMIT;
  const key = `${userId}:${routeKey}`;
  const now = Date.now();

  let entry = store.get(key);
  if (!entry || now >= entry.resetAt) {
    entry = { count: 0, resetAt: now + WINDOW_MS };
    store.set(key, entry);
  }

  entry.count++;
  const remaining = Math.max(0, limit - entry.count);
  const allowed = entry.count <= limit;

  // Periodically clean up expired entries to prevent memory growth
  if (store.size > 10_000) {
    for (const [k, v] of store) {
      if (now >= v.resetAt) store.delete(k);
    }
  }

  return { allowed, remaining, resetAt: entry.resetAt };
}
