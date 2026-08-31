import { clientIp, json, readBody, errMsg } from "./helpers.js";
import { fmtShanghaiYMDHMS } from "../time.js";

export async function joinHandler({ req, res, groups, token, bans }) {
  if (!groups) return json(res, 501, { error: "Groups service not configured" });
  const ip = clientIp(req);
  const banned = bans?.isBanned(ip);
  if (banned) {
    return json(res, 403, { error: `banned until ${fmtShanghaiYMDHMS(banned.until)}` });
  }
  let body;
  try {
    body = await readBody(req);
  } catch {
    return json(res, 400, { error: "Invalid JSON body" });
  }
  if (!body?.name) return json(res, 400, { error: "group name is required" });

  const fail = (msg) => {
    try {
      if (bans) {
        const b = bans.recordFailure(ip);
        if (b) console.error(`${ip} banned (${bans.threshold} failed joins)`);
      }
    } catch {}
    return json(res, 403, { error: msg });
  };

  if (!body.key) {
    const auth = /^Bearer (.+)$/.exec(req.headers["authorization"] || "");
    const hit = auth && groups.membersForToken(body.name, auth[1]);
    if (!hit) return fail("invalid member token");
    try {
      const isBroadbandRe = String(body.url || hit.member?.url || "").startsWith("relay://") || body.kind === "broadband" || hit.member?.kind === "broadband";
      const extra = {};
      if (isBroadbandRe) {
        extra.kind = "broadband";
        extra.publicIp = ip;
        extra.lastSeen = Date.now();
        if (body.url) extra.url = String(body.url);
      }
      const refreshed = groups.upsertMember(body.name, {
        memberName: body.memberName,
        url: body.url || hit.member.url,
        token: body.token || hit.member.token,
        kind: extra.kind,
        publicIp: extra.publicIp,
        lastSeen: extra.lastSeen,
      });
      if (isBroadbandRe && refreshed) {
        const targetId = Object.keys(refreshed).find((k) => refreshed[k].url === (body.url || hit.member.url));
        if (targetId) {
          refreshed[targetId].publicIp = ip;
          refreshed[targetId].lastSeen = Date.now();
          refreshed[targetId].kind = "broadband";
        }
      }
      return json(res, 200, { object: "group", name: body.name, members: refreshed });
    } catch (err) {
      return json(res, 400, { error: errMsg(err) });
    }
  }

  try {
    const youPort = Number(body.myPort);
    const youUrl = Number.isInteger(youPort) && youPort > 0 ? `http://${ip}:${youPort}` : "";
    let memberUrl = String(body.url || youUrl);
    if (!memberUrl) throw new Error("member url is required");
    const isBroadband = String(memberUrl).startsWith("relay://") || body.kind === "broadband";
    if (isBroadband) {
      memberUrl = String(body.url || memberUrl);
    }
    const members = groups.addMember(body.name, {
      key: body.key,
      memberName: body.memberName,
      url: memberUrl,
      token: body.token,
      kind: isBroadband ? "broadband" : "static",
      publicIp: isBroadband ? ip : undefined,
      lastSeen: isBroadband ? Date.now() : undefined,
    });
    if (bans) bans.clear(ip);
    if (!members.leader) {
      const leaderUrl = String(body.leaderUrl || "").replace(/\/+$/, "");
      if (leaderUrl) {
        groups.upsertMember(body.name, { memberName: "leader", url: leaderUrl, token });
        Object.assign(members, { leader: { url: leaderUrl, token } });
      }
    }
    json(res, 200, { object: "group", name: body.name, members, you: { url: memberUrl } });
  } catch (err) {
    return fail(errMsg(err));
  }
}

export async function leaveHandler({ req, res, groups }) {
  if (!groups) return json(res, 501, { error: "Groups service not configured" });
  let body;
  try {
    body = await readBody(req);
  } catch {
    return json(res, 400, { error: "Invalid JSON body" });
  }
  if (!body?.name) return json(res, 400, { error: "group name is required" });
  const auth = /^Bearer (.+)$/.exec(req.headers["authorization"] || "");
  if (!auth) return json(res, 401, { error: "bearer token required" });
  const group = groups.list()[body.name];
  if (!group) return json(res, 404, { error: `group "${body.name}" not found` });
  const hit = groups.membersForToken(body.name, auth[1]);
  if (!hit) return json(res, 403, { error: "invalid member token" });
  try {
    const removed = groups.removeMember(body.name, { url: hit.member.url });
    return json(res, 200, {
      object: "group",
      name: body.name,
      removed: removed?.removed ?? null,
      members: groups.list()[body.name]?.members ?? {},
    });
  } catch (err) {
    return json(res, 400, { error: errMsg(err) });
  }
}
