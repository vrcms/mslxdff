function hedgeDelayMs() {
  const raw = process.env.MSLXDFF_HEDGE_DELAY_MS;
  if (raw === undefined || raw === null || raw === "") return 1000;
  const s = String(raw).trim().toLowerCase();
  if (s === "0" || s === "off" || s === "false" || s === "no" || s === "disable" || s === "disabled") return 0;
  const n = Number(s);
  if (Number.isInteger(n) && n >= 0) return n;
  return 1000;
}

function isFastFailStatus(status) {
  const s = Number(status);
  return s === 429 || s === 502 || s === 503 || s === 504;
}

function shouldHedge({ isStream, canForwardPeers, hedgeDelayMs: d, hasPeers }) {
  if (!isStream) return false;
  if (!canForwardPeers) return false;
  if (!hasPeers) return false;
  if (!d || d <= 0) return false;
  return true;
}

function withTimeout(promise, ms) {
  if (ms <= 0) return promise;
  let timer;
  const timeout = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error("hedge-timeout")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function makeBufferedBody(chunk, handle, kind) {
  if (kind === "web") {
    const reader = handle;
    return (async function* () {
      yield chunk;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        yield value;
      }
    })();
  }
  const it = handle;
  return (async function* () {
    yield chunk;
    for await (const c of { [Symbol.asyncIterator]: () => it }) {
      yield c;
    }
  })();
}

async function cancelBody(body, handle, kind) {
  try {
    if (body && typeof body.cancel === "function") await body.cancel().catch(() => {});
    if (kind === "web" && handle && typeof handle.cancel === "function") await handle.cancel().catch(() => {});
    else if (handle && typeof handle.return === "function") await handle.return().catch(() => {});
  } catch {}
}

function getFirstChunkPromise(body) {
  if (!body) throw new Error("no-body");
  if (typeof body.getReader === "function") {
    const reader = body.getReader();
    const p = reader.read().then((r) => {
      if (r.done) throw new Error("no-chunk");
      return { chunk: r.value, handle: reader, kind: "web", reader };
    });
    return { promise: p, handle: reader, kind: "web" };
  }
  const it = body[Symbol.asyncIterator]?.();
  if (!it) throw new Error("no-iterator");
  const p = it.next().then((r) => {
    if (r.done) throw new Error("no-chunk");
    return { chunk: r.value, handle: it, kind: "node", it };
  });
  return { promise: p, handle: it, kind: "node" };
}

export { hedgeDelayMs, isFastFailStatus, shouldHedge };

export async function hedgedFirstChunkRace({
  localUpRes,
  peers,
  handlerCtx,
  hedgeDelayMs: hedgeDelay,
  evt,
}) {
  const t0 = Date.now();
  const debugHedge = process.env.MSLXDFF_DEBUG === "1";
  if (debugHedge) try { console.log(`[hedge] start delay=${hedgeDelay} peers=${peers?.ordered?.().length ?? 0} hasBody=${Boolean(localUpRes.body)} getReader=${typeof localUpRes.body?.getReader}`); } catch {}
  let localHandle = null;
  let localKind = null;
  let localBody = localUpRes.body;
  let localFirstPromise = null;
  try {
    const { promise, handle, kind } = getFirstChunkPromise(localBody);
    localHandle = handle;
    localKind = kind;
    localFirstPromise = promise;
  } catch (e) {
    evt?.("hedge-trigger", { reason: "fast-fail-no-body", hedgeDelayMs: hedgeDelay, triggerAtMs: Date.now() - t0 });
    return { needsPeer: true };
  }

  try {
    const local = await withTimeout(localFirstPromise, hedgeDelay);
    if (debugHedge) try { console.log(`[hedge] local win before hedge ttf=${Date.now() - t0}ms`); } catch {}
    evt?.("hedge-win", { via: "local", reason: "no-hedge-needed", ttfMs: Date.now() - t0, hedgeDelayMs: hedgeDelay });
    return {
      winner: "local",
      upRes: localUpRes,
      bufferedBody: makeBufferedBody(local.chunk, local.handle, local.kind),
      peerInfo: null,
      ttfMs: Date.now() - t0,
      hedged: false,
    };
  } catch (err) {
    if (err.message !== "hedge-timeout") {
      if (debugHedge) try { console.log(`[hedge] local fast-fail ${err.message}`); } catch {}
      evt?.("hedge-trigger", { reason: "fast-fail", hedgeDelayMs: hedgeDelay, triggerAtMs: Date.now() - t0, error: String(err.message).slice(0, 200) });
      return { needsPeer: true, localError: err };
    }
  }

  if (debugHedge) try { console.log(`[hedge] trigger slow hedge after ${hedgeDelay}ms`); } catch {}
  evt?.("hedge-trigger", { reason: "slow", hedgeDelayMs: hedgeDelay, triggerAtMs: Date.now() - t0 });

  const { racePeerCandidates } = await import("./peers.js");
  const candidates = handlerCtx.peers.ordered();
  let peerWin = null;
  try {
    peerWin =
      (await racePeerCandidates(candidates, handlerCtx)) ||
      (await racePeerCandidates(handlerCtx.peers.orderedByLastError(), handlerCtx));
  } catch (_) {
    peerWin = null;
  }
  if (debugHedge) try { console.log(`[hedge] peerWin=${peerWin ? peerWin.peer.url : "none"}`); } catch {}

  if (!peerWin) {
    const remaining = 25_000 - hedgeDelay;
    try {
      const local = await withTimeout(localFirstPromise, Math.max(0, remaining));
      evt?.("hedge-win", { via: "local", reason: "peer-miss", ttfMs: Date.now() - t0, hedgeDelayMs: hedgeDelay });
      if (debugHedge) try { console.log(`[hedge] local win after peer miss`); } catch {}
      return {
        winner: "local",
        upRes: localUpRes,
        bufferedBody: makeBufferedBody(local.chunk, local.handle, local.kind),
        peerInfo: null,
        ttfMs: Date.now() - t0,
        hedged: true,
      };
    } catch (e) {
      evt?.("hedge-lose", { via: "local", reason: "both-fail", error: String(e.message).slice(0, 200) });
      await cancelBody(localBody, localHandle, localKind);
      return null;
    }
  }

  let peerHandle = null;
  let peerKind = null;
  let peerBody = peerWin.res.body;
  let peerFirstPromise = null;
  try {
    const { promise, handle, kind } = getFirstChunkPromise(peerBody);
    peerHandle = handle;
    peerKind = kind;
    peerFirstPromise = promise.then((r) => ({ ...r, peer: peerWin }));
  } catch (e) {
    evt?.("hedge-lose", { via: "peer", reason: "peer-no-body", error: String(e.message).slice(0, 200) });
    try {
      const local = await localFirstPromise;
      return {
        winner: "local",
        upRes: localUpRes,
        bufferedBody: makeBufferedBody(local.chunk, local.handle, local.kind),
        peerInfo: null,
        ttfMs: Date.now() - t0,
        hedged: true,
      };
    } catch {
      return null;
    }
  }

  try {
    const winner = await Promise.race([
      localFirstPromise.then((local) => ({ via: "local", data: { ...local, kind: localKind, handle: localHandle } })),
      peerFirstPromise.then((peer) => ({ via: "peer", data: peer })),
    ]);
    if (debugHedge) try { console.log(`[hedge] race winner=${winner.via}`); } catch {}

    if (winner.via === "local") {
      await cancelBody(peerBody, peerHandle, peerKind);
      evt?.("hedge-win", { via: "local", reason: "race", ttfMs: Date.now() - t0, hedgeDelayMs: hedgeDelay, peer: peerWin.peer.url });
      evt?.("hedge-loser-cancel", { via: "peer", peer: peerWin.peer.url });
      return {
        winner: "local",
        upRes: localUpRes,
        bufferedBody: makeBufferedBody(winner.data.chunk, winner.data.handle, winner.data.kind),
        peerInfo: null,
        ttfMs: Date.now() - t0,
        hedged: true,
      };
    } else {
      await cancelBody(localBody, localHandle, localKind);
      evt?.("hedge-win", { via: "peer", reason: "race", ttfMs: Date.now() - t0, hedgeDelayMs: hedgeDelay, peer: winner.data.peer.peer.url });
      evt?.("hedge-loser-cancel", { via: "local" });
      return {
        winner: "peer",
        upRes: winner.data.peer.res,
        bufferedBody: makeBufferedBody(winner.data.chunk, winner.data.handle, winner.data.kind),
        peerInfo: winner.data.peer,
        ttfMs: Date.now() - t0,
        hedged: true,
      };
    }
  } catch (e) {
    if (debugHedge) try { console.log(`[hedge] race both failed, fallback sequential`); } catch {}
    try {
      const local = await localFirstPromise;
      await cancelBody(peerBody, peerHandle, peerKind);
      return {
        winner: "local",
        upRes: localUpRes,
        bufferedBody: makeBufferedBody(local.chunk, local.handle, local.kind),
        peerInfo: null,
        ttfMs: Date.now() - t0,
        hedged: true,
      };
    } catch {
      try {
        const peer = await peerFirstPromise;
        await cancelBody(localBody, localHandle, localKind);
        return {
          winner: "peer",
          upRes: peer.peer.res,
          bufferedBody: makeBufferedBody(peer.chunk, peer.handle, peer.kind),
          peerInfo: peer.peer,
          ttfMs: Date.now() - t0,
          hedged: true,
        };
      } catch {
        return null;
      }
    }
  }
}
