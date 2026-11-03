/* One poller for the three tab controllers (U12, P8).
 *
 * `books.js`, `games.js` and `main.js` each had their own
 * `startPolling`/`stopPolling` pair around a `setTimeout` chain. The chains
 * differ in *what* they poll, not in *how*: a sequence guard (stop must
 * invalidate an in-flight tick), a "still on screen?" predicate, and a fixed
 * interval between ticks. That mechanic lives here once.
 *
 * `tick` may return `false` to stop the chain after the current tick (a
 * terminal state such as a failed job); anything else keeps it running.
 * `stop()` bumps the sequence, so an `await` already in flight cannot
 * schedule a new tick.
 */

export function createPoller({
  intervalMs,
  tick,
  shouldContinue = () => true,
  delay = 0,
}) {
  let timer = 0;
  let seq = 0;

  const stop = () => {
    if (timer) window.clearTimeout(timer);
    timer = 0;
    seq += 1;
  };

  const run = async (id) => {
    if (id !== seq) return;
    if (!shouldContinue()) {
      timer = 0;
      return;
    }
    const again = await tick();
    if (id !== seq) return;
    if (again === false || !shouldContinue()) {
      timer = 0;
      return;
    }
    timer = window.setTimeout(() => { run(id); }, intervalMs);
  };

  const start = (startDelay = delay) => {
    stop();
    const id = seq;
    timer = window.setTimeout(() => { run(id); }, Math.max(0, startDelay));
  };

  return { start, stop, isRunning: () => Boolean(timer) };
}
