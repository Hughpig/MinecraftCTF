const { monitorEventLoopDelay } = require('node:perf_hooks');

module.exports = function startLoopDiagnostics() {
  if (process.env.CTF_DEBUG_LOOP !== '1') return { stop() {} };
  const loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable();
  let worst = 0;
  let stopped = false;
  function report() {
    const max = loop.max / 1e6;
    worst = Math.max(worst, max);
    console.error(`[${new Date().toISOString()}] [loop] max=${max.toFixed(1)}ms p99=${(loop.percentile(99) / 1e6).toFixed(1)}ms worst=${worst.toFixed(1)}ms`);
    loop.reset();
  }
  const timer = setInterval(report, 2000);
  timer.unref();
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      report();
      loop.disable();
    }
  };
};
