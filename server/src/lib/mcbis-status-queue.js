/**
 * Serialize status reads only. Wallet and dispatch requests are not changed.
 * Coalesce queued/in-flight checks for the same reference, never cache results.
 */
function createStatusQueue({ spacingMs = 2000, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const pending = new Map();
  let tail = Promise.resolve();
  let nextStartAt = 0;

  function run(reference, check) {
    if (pending.has(reference)) return pending.get(reference);
    const request = tail.then(async () => {
      const wait = nextStartAt - now();
      if (wait > 0) await sleep(wait);
      nextStartAt = now() + spacingMs;
      return check();
    });
    pending.set(reference, request);
    tail = request.then(() => undefined, () => undefined);
    const clear = () => {
      if (pending.get(reference) === request) pending.delete(reference);
    };
    request.then(clear, clear);
    return request;
  }

  return { run };
}

module.exports = { createStatusQueue };