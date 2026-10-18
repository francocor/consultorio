export interface AvailabilityCache<T> {
  /** The answer for a key, computed at most once per window. A failure is not kept. */
  get(tenantId: string, key: string, compute: () => Promise<T>): Promise<T>;
  /** Forgets everything remembered for an organization (a hold or a booking just changed its slots). */
  invalidate(tenantId: string): void;
  size(): number;
}

interface Entry<T> {
  tenantId: string;
  expiresAt: number;
  value: Promise<T>;
}

/**
 * The short memory behind the public availability (design 5.3: "free slots, 30 s cache"). A public
 * page may be opened by many people at once; computing the same free slots for each would cost a
 * calendar read per visitor. The window is short on purpose: a slot someone just took may show for
 * a few more seconds, and the hold that follows says so.
 *
 * The cache belongs to one process. The link is resolved BEFORE asking it, so a disabled or
 * regenerated link stops answering at once whatever is remembered.
 */
export function createAvailabilityCache<T>(options: {
  ttlMs: number;
  maxEntries?: number;
  now?: () => number;
}): AvailabilityCache<T> {
  const now = options.now ?? Date.now;
  const maxEntries = options.maxEntries ?? 2000;
  const entries = new Map<string, Entry<T>>();

  return {
    async get(tenantId, key, compute) {
      const at = now();
      const id = `${tenantId}|${key}`;
      const known = entries.get(id);
      if (known && known.expiresAt > at) return known.value;

      const value = compute();
      const entry: Entry<T> = { tenantId, expiresAt: at + options.ttlMs, value };
      entries.delete(id);
      entries.set(id, entry);
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
      try {
        return await value;
      } catch (error) {
        if (entries.get(id) === entry) entries.delete(id);
        throw error;
      }
    },

    invalidate(tenantId) {
      for (const [id, entry] of entries) {
        if (entry.tenantId === tenantId) entries.delete(id);
      }
    },

    size: () => entries.size,
  };
}
