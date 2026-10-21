// Requêtes HTTP JSON avec délai maximal, réessais limités et limiteur de débit par source.

export class RateLimiter {
  constructor(perMinute, { now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    this.setRate(perMinute);
    this.next = 0;
    this.now = now;
    this.sleep = sleep;
    this.chain = Promise.resolve();
  }
  setRate(perMinute) {
    this.interval = 60_000 / Math.max(0.1, perMinute);
  }
  // Exécute fn en respectant l'espacement minimal entre deux appels (file d'attente FIFO).
  schedule(fn) {
    const run = async () => {
      const wait = this.next - this.now();
      if (wait > 0) await this.sleep(wait);
      this.next = Math.max(this.now(), this.next) + this.interval;
      return fn();
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => {});
    return p;
  }
  // Repousse les prochains appels (après un 429).
  penalize(ms) {
    this.next = Math.max(this.next, this.now() + ms);
  }
}

export class HttpError extends Error {
  constructor(status, url, body) {
    super(`HTTP ${status} sur ${url}`);
    this.status = status;
    this.body = body;
  }
}

export async function fetchJson(url, { limiter, timeoutMs = 15_000, retries = 2, headers = {}, method = "GET", body } = {}) {
  let attempt = 0;
  for (;;) {
    const exec = async () => {
      const res = await fetch(url, {
        method,
        headers: { accept: "application/json", ...(body ? { "content-type": "application/json" } : {}), ...headers },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new HttpError(res.status, url, text.slice(0, 300));
      }
      return res.json();
    };
    try {
      return limiter ? await limiter.schedule(exec) : await exec();
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 0;
      const retriable = status === 0 || status === 429 || status >= 500;
      if (!retriable || attempt >= retries) throw e;
      attempt += 1;
      const backoff = status === 429 ? 30_000 * attempt : 2_000 * attempt;
      if (status === 429 && limiter) limiter.penalize(backoff);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
}
