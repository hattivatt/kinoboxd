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
