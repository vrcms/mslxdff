import { stdout } from "node:process";
import { performance } from "node:perf_hooks";

export function createSpinner(label) {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  let t0 = performance.now();
  let timer = null;
  let active = false;
  const isTTY = stdout.isTTY;
  function start() {
    if (active) return;
    active = true;
    t0 = performance.now();
    if (!isTTY) {
      console.log(`\x1b[90m${label}…\x1b[0m`);
      return;
    }
    timer = setInterval(() => {
      const sec = ((performance.now() - t0) / 1000).toFixed(1);
      const f = frames[i++ % frames.length];
      stdout.write(`\r\x1b[90m${f} ${label}… ${sec}s\x1b[0m`);
    }, 180);
    timer.unref?.();
  }
  function stop(finalMsg) {
    if (!active) return;
    active = false;
    if (timer) { clearInterval(timer); timer = null; }
    if (isTTY) {
      stdout.write("\r\x1b[K");
      if (finalMsg) console.log(finalMsg);
    } else if (finalMsg) {
      console.log(finalMsg);
    }
  }
  return { start, stop };
}
