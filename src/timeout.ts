/**
 * Races `work` against a deadline without leaving a timer behind.
 *
 * `Promise.race([work, Bun.sleep(ms)])` keeps the process alive until the
 * sleep fires even when `work` won long ago; a 15-second preflight timeout
 * or a 30-second ACP start timeout then looks like a hang at exit. This
 * clears the timer as soon as either side settles. `expire` runs when the
 * deadline wins: return a fallback value or throw.
 */
export async function withTimeout<T, F>(work: Promise<T>, ms: number, expire: () => F): Promise<T | F> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<F>((resolve, reject) => {
    timer = setTimeout(() => {
      try { resolve(expire()); } catch (error) { reject(error); }
    }, ms);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
