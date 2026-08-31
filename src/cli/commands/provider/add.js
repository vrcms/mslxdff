import { join } from "node:path";

export async function handleProviderAdd(id, sub, rest) {
  if (id !== "add") return false;
  const gid = sub;
  const gBase = rest[1];
  const gKey = rest[2];
  if (!gid || !gBase || !gKey) {
    console.error("usage: mslxdff -provider add <id> <baseUrl> <key> [allowedModel...] [--models-path <path>] [--chat-path <path>]");
    console.error("       e.g. mslxdff -provider add myapi https://api.example.com/v1 sk-xxx");
    console.error("            mslxdff -provider add myapi https://api.example.com/v1 sk-xxx gpt-4 gpt-3.5");
    console.error("            mslxdff -provider add myapi https://api.example.com/v1 sk-xxx --models-path /v1/models --chat-path /v1/chat/completions");
    process.exit(1);
  }
  if (gid === "opencode" || gid === "oc" || gid === "openrouter") {
    console.error(`provider "${gid}" is built-in — use: mslxdff -provider ${gid} add <key>  or  mslxdff -provider ${gid} set-url <url>`);
    process.exit(1);
  }
  const { saveProviderConfig, loadProviderConfig, loadProviderShareKeys } = await import("../../../state.js");
  const { normalizeProviderId } = await import("../../../providers/model-id.js");
  const nid = normalizeProviderId(gid);
  if (!nid) { console.error(`invalid provider id: ${gid}`); process.exit(1); }
  if (!/^https?:\/\/.+/.test(String(gBase).trim())) { console.error(`invalid baseUrl: ${gBase} (must start with http:// or https://)`); process.exit(1); }
  const cur = loadProviderConfig(nid) || { baseUrl: "", keys: [], allowedModels: [], auths: [], modelsPath: "", chatPath: "" };
  let keys, auths, baseUrl;
  baseUrl = String(gBase).trim();
  let parsedModelsPath = null;
  let parsedChatPath = null;
  const extraTokens = [];
  for (let _i = 3; _i < rest.length; _i++) {
    const tok = String(rest[_i] || "");
    if (tok === "--models-path" || tok === "--modelsPath" || tok === "--models_path") { parsedModelsPath = String(rest[_i + 1] || "").trim() || null; _i++; }
    else if (tok.startsWith("--models-path=")) { parsedModelsPath = tok.slice("--models-path=".length).trim() || null; }
    else if (tok === "--chat-path" || tok === "--chatPath" || tok === "--chat_path") { parsedChatPath = String(rest[_i + 1] || "").trim() || null; _i++; }
    else if (tok.startsWith("--chat-path=")) { parsedChatPath = tok.slice("--chat-path=".length).trim() || null; }
    else extraTokens.push(tok);
  }
  if (parsedModelsPath && !String(parsedModelsPath).startsWith("/")) { console.error(`invalid --models-path: ${parsedModelsPath} (must start with /)`); process.exit(1); }
  if (parsedChatPath && !String(parsedChatPath).startsWith("/")) { console.error(`invalid --chat-path: ${parsedChatPath} (must start with /)`); process.exit(1); }
  const extraModels = extraTokens.filter((x) => x && !String(x).startsWith("-")).map((m) => String(m).trim()).filter(Boolean);
  const allowedModels = extraModels.length ? [...new Set([...(cur.allowedModels || []), ...extraModels])] : (cur.allowedModels || []);
  if (nid === "workbuddy") {
    const token = String(gKey).trim();
    let uid = "";
    try { const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64").toString()); uid = payload.uid || payload.sub || payload.userId || payload.user_id || ""; } catch {}
    if (!uid) uid = "manual-" + token.slice(-8);
    const curKeys = Array.isArray(cur.keys) ? [...cur.keys] : [];
    const curAuths = Array.isArray(cur.auths) ? [...cur.auths] : [];
    let idx2 = curAuths.findIndex(a => a.uid === uid);
    if (idx2 < 0) idx2 = curKeys.findIndex(k => k === token);
    let newKeys, newAuths;
    if (idx2 >= 0) {
      newKeys = [...curKeys]; newKeys[idx2] = token;
      newAuths = [...curAuths]; newAuths[idx2] = { uid, domain: "www.codebuddy.cn", enterpriseId: "", refreshToken: "" };
      while (newAuths.length < newKeys.length) newAuths.push({ uid: `manual-${newKeys[newAuths.length].slice(-8)}`, domain: "www.codebuddy.cn", enterpriseId: "", refreshToken: "" });
    } else {
      newKeys = [...new Set([...curKeys, token].filter(Boolean))];
      newAuths = [...curAuths, { uid, domain: "www.codebuddy.cn", enterpriseId: "", refreshToken: "" }];
      while (newAuths.length < newKeys.length) newAuths.push({ uid: `manual-${newKeys[newAuths.length].slice(-8)}`, domain: "www.codebuddy.cn", enterpriseId: "", refreshToken: "" });
      while (newKeys.length < newAuths.length) newKeys.push(token);
    }
    keys = newKeys; auths = newAuths;
    const cfgToSave = { baseUrl, keys, auths, allowedModels };
    if (parsedModelsPath) cfgToSave.modelsPath = parsedModelsPath;
    else if (cur.modelsPath) cfgToSave.modelsPath = cur.modelsPath;
    if (parsedChatPath) cfgToSave.chatPath = parsedChatPath;
    else if (cur.chatPath) cfgToSave.chatPath = cur.chatPath;
    saveProviderConfig(nid, cfgToSave);
    try {
      const { writeFileSync, mkdirSync } = await import("node:fs");
      const { join } = await import("node:path");
      const dir = process.env.WORKBUDDY_AUTH_DIR || join(process.cwd(), "auths");
      mkdirSync(dir, { recursive: true });
      const fp = join(dir, `workbuddy-${uid}.json`);
      const doc = { account: { uid, enterpriseId: "", nickname: "" }, auth: { accessToken: token, refreshToken: "", expiresAt: Math.floor(Date.now()/1000)+3600, domain: "www.codebuddy.cn" } };
      writeFileSync(fp + ".tmp", JSON.stringify(doc, null, 2), { mode: 0o600 });
      try { const { renameSync, unlinkSync, existsSync } = await import("node:fs"); if (existsSync(fp)) unlinkSync(fp); renameSync(fp + ".tmp", fp); } catch { writeFileSync(fp, JSON.stringify(doc, null, 2), { mode: 0o600 }); }
    } catch {}
  } else {
    const trimmed = String(gKey).trim();
    const already = (cur.keys || []).some((k) => String(k).trim() === trimmed);
    if (already) {
      console.log(`key already exists for ${nid} (${trimmed.slice(0, 4)}…${trimmed.slice(-4)}), skipped — still ${cur.keys.length} key(s)`);
      console.log(`  use: mslxdff -provider ${nid} list  to see keys`);
      process.exit(0);
    }
    keys = [...new Set([...(cur.keys || []), trimmed].filter(Boolean))];
    auths = undefined;
    const cfgToSave2 = { baseUrl, keys, allowedModels };
    if (parsedModelsPath) cfgToSave2.modelsPath = parsedModelsPath;
    else if (cur.modelsPath) cfgToSave2.modelsPath = cur.modelsPath;
    if (parsedChatPath) cfgToSave2.chatPath = parsedChatPath;
    else if (cur.chatPath) cfgToSave2.chatPath = cur.chatPath;
    saveProviderConfig(nid, cfgToSave2);
  }
  console.log(`added generic provider: ${nid}`);
  console.log(`  baseUrl: ${String(gBase).trim().replace(/\/+$/, "")}`);
  console.log(`  keys: ${keys.length} (${keys.map((k) => `${k.slice(0, 4)}…${k.slice(-4)}`).join(", ")})`);
  if (allowedModels.length) console.log(`  allowedModels: ${allowedModels.length} (${allowedModels.join(", ")})`);
  else console.log(`  allowedModels: (none — BLOCKED, otherwise unusable)  → mslxdff -provider ${nid} allowlist set <model...>  OR  mslxdff -provider ${nid} allowAny on (allow all)`);
  console.log(`  share: ${loadProviderShareKeys(nid) ? "ON" : "off"}   (mslxdff -provider ${nid} share on|off)`);
  console.log(`  allowAny: OFF (secure, empty allowlist = 403 block before upstream) — enable via: mslxdff -provider ${nid} allowAny on`);
  console.log(`  use as: ${nid}/<model-id>  — restart daemon to activate`);
  console.log(`  NOTE: empty allowlist = 403 before upstream, no cost — must set allowlist to use`);
  process.exit(0);
}
