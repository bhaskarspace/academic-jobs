// The per-source watchdog. On expiry it aborts the source's requests (queued and in flight, via
// http.withSignal) as well as giving up on the result, so a hung host can't keep working after.
export function withWatchdog(run, ms, what) {
  const ctl = new AbortController();
  let timer;
  return Promise.race([
    run(ctl.signal),
    new Promise((_, rej) => {
      timer = setTimeout(() => { ctl.abort(); rej(Object.assign(new Error(`${what} exceeded ${ms / 60000} min`), { code: 'WATCHDOG' })); }, ms);
      timer.unref();
    }),
  ]).finally(() => clearTimeout(timer));
}
