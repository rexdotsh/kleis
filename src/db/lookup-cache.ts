// Turso is a network round trip away, so the proxy caches the two lookups it
// makes on every request. Any write through the repositories bumps the
// generation, which invalidates every cached entry in this process; the TTL
// bounds staleness for writes made by another process (blue/green overlap).
let generation = 0;

const MAX_ENTRIES = 1000;

type Entry<V> = { value: V; expiresAt: number; generation: number };

export const invalidateLookupCaches = (): void => {
  generation++;
};

export const lookupCacheGeneration = (): number => generation;

export const createLookupCache = <V>(ttlMs: number) => {
  const entriesByDatabase = new WeakMap<object, Map<string, Entry<V>>>();
  const pendingByDatabase = new WeakMap<object, Map<string, Promise<V>>>();

  const mapFor = <T>(
    store: WeakMap<object, Map<string, T>>,
    database: object
  ) => {
    let map = store.get(database);
    if (!map) {
      map = new Map();
      store.set(database, map);
    }
    return map;
  };

  return {
    get(database: object, key: string, load: () => Promise<V>): Promise<V> {
      const entries = mapFor(entriesByDatabase, database);
      const cached = entries.get(key);
      if (
        cached &&
        cached.generation === generation &&
        cached.expiresAt > Date.now()
      ) {
        return Promise.resolve(cached.value);
      }

      const pending = mapFor(pendingByDatabase, database);
      const pendingKey = `${generation}:${key}`;
      const inFlight = pending.get(pendingKey);
      if (inFlight) {
        return inFlight;
      }

      const loadGeneration = generation;
      const loading = load()
        .then((value) => {
          if (loadGeneration === generation) {
            if (entries.size >= MAX_ENTRIES) {
              entries.clear();
            }
            entries.set(key, {
              value,
              expiresAt: Date.now() + ttlMs,
              generation: loadGeneration,
            });
          }
          return value;
        })
        .finally(() => {
          pending.delete(pendingKey);
        });
      pending.set(pendingKey, loading);
      return loading;
    },
  };
};
