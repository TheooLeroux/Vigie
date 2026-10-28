import { AsyncLocalStorage } from "node:async_hooks";

// A planning session belongs to one update, including its parallel services and
// retries. Never share registry metadata or failed searches between executions.
type Entry = { pending: Promise<unknown>; expires: number; bytes: number };
type Session = { catalogs: Map<typeof fetch, Map<string, Entry>>; bytes: number; active: number; waiting: (() => void)[] };
const sessions = new AsyncLocalStorage<Session>();
const maxBytes = 32 * 1024 * 1024;

export function withPlanningSession<T>(work: () => Promise<T>): Promise<T> {
  return sessions.getStore() ? work() : sessions.run({ catalogs: new Map(), bytes: 0, active: 0, waiting: [] }, work);
}

export async function mapConcurrent<T, R>(items: T[], limit: number, work: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let next = 0, failed = false, failure: unknown;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!failed && next < items.length) {
      const index = next++;
      try { results[index] = await work(items[index], index); }
      catch (error) { if (!failed) failure = error; failed = true; }
    }
  }));
  // In-flight work must finish before the caller removes its temporary files.
  if (failed) throw failure;
  return results;
}

export async function planningCatalog<T>(key: string, transport: typeof fetch, read: () => Promise<{ value: T; bytes: number }>): Promise<T> {
  const session = sessions.getStore();
  if (!session) return (await read()).value;
  let entries = session.catalogs.get(transport);
  if (!entries) session.catalogs.set(transport, entries = new Map());
  const previous = entries.get(key);
  if (previous && previous.expires > Date.now()) return previous.pending as Promise<T>;
  if (previous) { session.bytes -= previous.bytes; entries.delete(key); }
  const entry: Entry = { pending: Promise.resolve(), expires: Infinity, bytes: 0 };
  // Reserve the promise before yielding, so two services issue just one read.
  entry.pending = (async () => {
    if (session.active >= 8) await new Promise<void>(resolve => session.waiting.push(resolve));
    else session.active++;
    try {
      const { value, bytes } = await read();
      if (bytes <= maxBytes) {
        for (const catalog of session.catalogs.values()) for (const [name, cached] of catalog) {
          if (session.bytes + bytes <= maxBytes) break;
          if (cached.bytes) { session.bytes -= cached.bytes; catalog.delete(name); }
        }
        entry.bytes = bytes;
        entry.expires = Date.now() + 5 * 60_000;
        session.bytes += bytes;
      } else entries.delete(key);
      return value;
    } catch (error) { entries.delete(key); throw error; }
    finally {
      const resume = session.waiting.shift();
      if (resume) resume(); else session.active--;
    }
  })();
  entries.set(key, entry);
  return entry.pending as Promise<T>;
}
