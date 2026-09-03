import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGroupsService } from "../src/groups.js";
import { createRouter } from "../src/routes.js";
import { createUpstreamClient } from "../src/upstream.js";
import { startServer } from "../src/server.js";

function tmpStateFile() {
  const dir = mkdtempSync(join(tmpdir(), "mslxdff-bbs-"));
  return join(dir, "state.json");
}

test("stream e2e: leader enqueue -> broadband SSE receives and result resolves", async () => {
  const token = "a".repeat(64);
  const file = tmpStateFile();
  const groups = createGroupsService({ file });
  groups.create("wg");
  const homeToken = "home-stream-token";
  groups.addMember("wg", { key: "wg", memberName: "home-D", url: "relay://home-D", token: homeToken, kind: "broadband", lastSeen: Date.now() });
  const upstream = createUpstreamClient({ baseUrl: "http://127.0.0.1:1", retry: {} });
  const srv = startServer({ router: createRouter({ token, upstream, groups }) }, 0);
  await srv.ready();
  const port = srv.server.address().port;
  const leaderUrl = `http://127.0.0.1:${port}`;
  try {
    // member opens SSE stream
    const streamUrl = `${leaderUrl}/v1/groups/relay/stream?name=wg`;
    const controller = new AbortController();
    const streamRes = await fetch(streamUrl, {
      headers: { Authorization: `Bearer ${homeToken}`, Accept: "text/event-stream" },
      signal: controller.signal,
    });
    assert.equal(streamRes.status, 200);
    assert.match(streamRes.headers.get("content-type") || "", /text\/event-stream/);
    let received = null;
    let buf = "";
    const decodeChunk = (c) => (typeof c === "string" ? c : Buffer.isBuffer(c) ? c.toString("utf8") : c instanceof Uint8Array ? Buffer.from(c).toString("utf8") : String(c));
    const readerPromise = (async () => {
      for await (const chunk of streamRes.body) {
        buf += decodeChunk(chunk);
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const raw = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          if (!raw || raw.startsWith(":")) continue;
          let event = "message";
          let data = "";
          for (const line of raw.split("\n")) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) data += line.slice(5).trim();
          }
          if (event === "relay" && data) {
            received = JSON.parse(data);
            // simulate member handling: post result
            await fetch(`${leaderUrl}/v1/groups/relay/result`, {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${homeToken}` },
              body: JSON.stringify({ name: "wg", reqId: received.reqId, result: { status: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ok: 1 }) } }),
            });
          }
        }
        if (received) break;
      }
    })();
    // give stream a moment to register
    await new Promise((r) => setTimeout(r, 50));
    // leader forwards to broadband
    const fwdBody = { model: "m", messages: [{ role: "user", content: "hi" }] };
    const fwdPromise = fetch(`${leaderUrl}/v1/groups/relay/forward`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ group: "wg", target: "relay://home-D", body: fwdBody, reqId: "stream-req-1" }),
    });
    const fwdRes = await Promise.race([
      fwdPromise,
      new Promise((_, rej) => setTimeout(() => rej(new Error("forward timeout")), 5000)),
    ]);
    assert.equal(fwdRes.status, 200);
    const txt = await fwdRes.text();
    assert.match(txt, /ok/);
    await readerPromise;
    assert.ok(received, "should have received relay via SSE");
    assert.equal(received.reqId, "stream-req-1");
    controller.abort();
  } finally {
    await srv.close();
    srv.server.closeAllConnections?.();
  }
});

test("stream e2e: poll still works as fallback when no stream", async () => {
  const token = "a".repeat(64);
  const file = tmpStateFile();
  const groups = createGroupsService({ file });
  groups.create("wg2");
  const homeToken = "home-poll-token";
  groups.addMember("wg2", { key: "wg2", memberName: "home-D", url: "relay://home-D", token: homeToken, kind: "broadband", lastSeen: Date.now() });
  const upstream = createUpstreamClient({ baseUrl: "http://127.0.0.1:1", retry: {} });
  const srv = startServer({ router: createRouter({ token, upstream, groups }) }, 0);
  await srv.ready();
  const port = srv.server.address().port;
  const leaderUrl = `http://127.0.0.1:${port}`;
  try {
    // no stream opened, use poll
    const fwdBody = { model: "m", messages: [{ role: "user", content: "hi2" }] };
    const fwdPromise = fetch(`${leaderUrl}/v1/groups/relay/forward`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ group: "wg2", target: "relay://home-D", body: fwdBody, reqId: "poll-req-1" }),
    });
    await new Promise((r) => setTimeout(r, 50));
    const poll = await fetch(`${leaderUrl}/v1/groups/relay/poll`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${homeToken}` },
      body: JSON.stringify({ name: "wg2" }),
    });
    assert.equal(poll.status, 200);
    const pj = await poll.json();
    assert.equal(pj.data[0].reqId, "poll-req-1");
    await fetch(`${leaderUrl}/v1/groups/relay/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${homeToken}` },
      body: JSON.stringify({ name: "wg2", reqId: "poll-req-1", result: { status: 200, headers: {}, body: "{}" } }),
    });
    const fwdRes = await fwdPromise;
    assert.equal(fwdRes.status, 200);
  } finally {
    await srv.close();
    srv.server.closeAllConnections?.();
  }
});
