import { errorCode } from './contracts';

/** Events arriving during a read require a newer snapshot. A changing paged
 * snapshot is normal under bulk writes; it is not a broken connection. */
export function createAuthoritativeLoader<T>(read: () => Promise<T>, commit: (value: T) => void, assertCurrent: () => void): () => Promise<T> {
  let requested = 0;
  let active: Promise<T> | undefined;
  return () => {
    requested++;
    active ??= (async () => {
      try {
        for (;;) {
          const ticket = requested;
          assertCurrent();
          let value: T;
          try { value = await Promise.resolve().then(read); } catch (error) {
            assertCurrent();
            if (errorCode(error) === 'CURSOR_EXPIRED') {
              await new Promise(resolve => setTimeout(resolve, 100));
              continue;
            }
            if (ticket !== requested) continue;
            throw error;
          }
          assertCurrent();
          if (ticket !== requested) continue;
          commit(value);
          if (ticket === requested) return value;
        }
      } finally { active = undefined; }
    })();
    return active;
  };
}
