import { clientIp, json, readBody, parseHops, errMsg } from "./helpers.js";
import { DEFAULT_MAX_HOPS } from "../peers.js";
import { enqueueRelay, dequeueRelayForPoll, resolveRelay } from "./relay-queue.js";

export async function heartbeatHandler({ req, res, groups, bus, logs }) {
  const auth = /^Bearer (.+)$/.exec(req.headers["authorization"] || "");
  if (!auth) return json(res, 401, { error: "bearer token required" });
  let body;
  try { body = await readBody(req); } catch { return json(res, 400, { error: "Invalid JSON body" }); }
  const groupName = body?.name || body?.group;
  if (!groupName) return json(res, 400, { error: "group name is required" });
  const hit = groups?.membersForToken(groupName, auth[1]);
  if (!hit) return json(res, 403, { error: "invalid member token" });
  const ip = clientIp(req);
  try {
    const memberUrl = hit.member?.url;
    const members = groups.list()[groupName]?.members || {};
    const targetId = Object.keys(members).find((k) => members[k].url === memberUrl) || hit.member?.url;
    if (hit.member?.kind === "broadband" || String(memberUrl).startsWith("relay://")) {
      const m = members[targetId] || hit.member;
      if (m) {
        m.publicIp = ip;
        m.lastSeen = Date.now();
        try { groups.upsertMember(groupName, { memberName: targetId, url: m.url, token: m.token, kind: "broadband", publicIp: ip, lastSeen: m.lastSeen }); } catch {}
      }
      const evtData = { ts: Date.now(), type: "relay-heartbeat", member: targetId, ip, lastSeen: m?.lastSeen, group: groupName };
      if (bus) bus.emit(evtData);
      logs?.appendEvent?.(evtData);
    }
    return json(res, 200, { object: "heartbeat", ok: true, ip, lastSeen: Date.now() });
  } catch (err) {
    return json(res, 400, { error: errMsg(err) });
  }
}

export async function pollHandler({ req, res, groups }) {
  const auth = /^Bearer (.+)$/.exec(req.headers["authorization"] || "");
  if (!auth) return json(res, 401, { error: "bearer token required" });
  let body;
  try { body = await readBody(req); } catch { return json(res, 400, { error: "Invalid JSON body" }); }
  const groupName = body?.name || body?.group;
  if (!groupName) return json(res, 400, { error: "group name is required" });
  const hit = groups?.membersForToken(groupName, auth[1]);
  if (!hit) return json(res, 403, { error: "invalid member token" });
  const targetUrl = hit.member?.url;
  if (!targetUrl) return json(res, 400, { error: "member url not found" });
  const batch = dequeueRelayForPoll({ group: groupName, target: targetUrl, limit: 10 });
  return json(res, 200, { object: "poll", data: batch });
}

export async function resultHandler({ req, res, groups }) {
  const auth = /^Bearer (.+)$/.exec(req.headers["authorization"] || "");
  if (!auth) return json(res, 401, { error: "bearer token required" });
  let body;
  try { body = await readBody(req); } catch { return json(res, 400, { error: "Invalid JSON body" }); }
  const groupName = body?.name || body?.group;
  const reqId = body?.reqId;
  if (!groupName || !reqId) return json(res, 400, { error: "group and reqId required" });
  const hit = groups?.membersForToken(groupName, auth[1]);
  if (!hit) return json(res, 403, { error: "invalid member token" });
  const ok = resolveRelay(reqId, body.result || body);
  if (!ok) return json(res, 404, { error: "pending request not found or timed out" });
  return json(res, 200, { object: "result", ok: true });
}

export async function forwardHandler({ req, res, groups, bus, logs }) {
  let body;
  try { body = await readBody(req); } catch { return json(res, 400, { error: "Invalid JSON body" }); }
  const groupName = body?.group || body?.name;
  const target = body?.target || body?.url;
  const hops = parseHops(req.headers["x-mslxdff-hops"] || body?.hops);
  if (!groupName || !target) return json(res, 400, { error: "group and target required" });
  if (hops >= DEFAULT_MAX_HOPS) return json(res, 429, { error: "max hops exceeded" });
  const members = groups?.list()[groupName]?.members || {};
  const targetMember = Object.values(members).find((m) => m.url === target) || Object.entries(members).find(([id]) => id === target)?.[1];
  if (!targetMember) return json(res, 404, { error: `target ${target} not found in group ${groupName}` });
  const isBb = targetMember.kind === "broadband" || String(targetMember.url).startsWith("relay://");
  if (!isBb) {
    try {
      const fwdBody = body.body || body;
      const r = await fetch(`${targetMember.url}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${targetMember.token || ""}`, "x-mslxdff-hops": String(hops + 1), "x-mslxdff-model-lock": fwdBody.model || "", "Accept": "text/event-stream" },
        body: JSON.stringify(fwdBody),
      });
      const evtData = { ts: Date.now(), type: "relay-forward", target, via: "direct", group: groupName, hops };
      if (bus) bus.emit(evtData);
      logs?.appendEvent?.(evtData);
      res.statusCode = r.status;
      if (r.headers.get("content-type")?.includes("text/event-stream")) {
        res.setHeader("Content-Type", "text/event-stream");
        if (r.body) for await (const c of r.body) res.write(c);
        res.end();
      } else {
        const txt = await r.text();
        res.setHeader("Content-Type", r.headers.get("content-type") || "application/json");
        res.end(txt);
      }
      return;
    } catch (err) {
      return json(res, 502, { error: errMsg(err) });
    }
  }
  const reqId = body.reqId || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const fwdBody = body.body || { model: body.model, messages: body.messages, stream: body.stream };
  const evtData = { ts: Date.now(), type: "relay-forward", target, via: "leader", group: groupName, hops, reqId, model: fwdBody.model };
  if (bus) bus.emit(evtData);
  logs?.appendEvent?.(evtData);
  const staleMs = Number(process.env.MSLXDFF_BROADBAND_STALE_MS) > 0 ? Number(process.env.MSLXDFF_BROADBAND_STALE_MS) : 90_000;
  if (typeof targetMember.lastSeen === "number" && Date.now() - targetMember.lastSeen > staleMs) {
    return json(res, 502, { error: "broadband member stale (no heartbeat)" });
  }
  try {
    const resultPromise = enqueueRelay({ group: groupName, target: targetMember.url, reqId, body: fwdBody, hops });
    const result = await resultPromise;
    if (result && typeof result.status === "number") {
      res.statusCode = result.status;
      if (result.headers) for (const [k, v] of Object.entries(result.headers)) res.setHeader(k, v);
      if (result.body) {
        if (typeof result.body === "string") res.end(result.body);
        else res.end(JSON.stringify(result.body));
      } else res.end();
      return;
    }
    return json(res, 200, result);
  } catch (err) {
    return json(res, 504, { error: errMsg(err) || "relay timeout" });
  }
}
