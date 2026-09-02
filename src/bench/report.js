export function sortResults(list) {
  const arr = [...(list || [])];
  arr.sort((a, b) => {
    if (a.ok !== b.ok) return a.ok ? -1 : 1;
    if (a.ok && b.ok) {
      const at = a.ttfbMs ?? a.totalMs ?? 1e9;
      const bt = b.ttfbMs ?? b.totalMs ?? 1e9;
      if (at !== bt) return at - bt;
      const ap = a.tps ?? a.charsPerSec ?? -1;
      const bp = b.tps ?? b.charsPerSec ?? -1;
      return bp - ap;
    }
    return 0;
  });
  return arr;
}

function pad(s, n, align = "left") {
  const str = String(s ?? "");
  if (str.length >= n) return str.slice(0, n);
  const d = n - str.length;
  if (align === "right") return " ".repeat(d) + str;
  return str + " ".repeat(d);
}

function shortPeerLabel(p) {
  const raw = String(p?.name || p?.id || p?.url || String(p || "")).trim();
  if (!raw) return "peer";
  // 优先用 name；若是 url 则取 host:port 的尾段
  if (raw.startsWith("http://") || raw.startsWith("https://") || raw.startsWith("relay://")) {
    try { const u = new URL(raw); const host = u.hostname; const port = u.port ? `:${u.port}` : ""; if (host) return `${host}${port}`; } catch {}
    return raw.slice(-12);
  }
  // name 可能是 url 字符串（如 "http://141.98..." 存于 name 字段）
  if (raw.includes("://")) {
    try { const u = new URL(raw); return u.hostname + (u.port ? `:${u.port}` : ""); } catch {}
  }
  return raw;
}
export function formatViaReport(results, { peers = [], meta = {}, json = false } = {}) {
  const peerIds = (peers || []).map((p) => shortPeerLabel(p));
  const samples = meta.samples ?? 1;
  const timeout = meta.timeout ?? 30000;
  const includeOpencode = Boolean(meta.includeOpencode);
  const opencodeTag = includeOpencode ? "opencode=included" : "opencode=skipped";
  const at = meta.at || new Date().toISOString();
  // build json shape
  const jsonObj = {
    meta: { at, samples, timeout, includeOpencode, peers: peerIds, opencodeSkipped: !includeOpencode, ...meta, peers: peerIds },
    results: (results || []).map((r) => ({
      provider: r.provider,
      model: r.model || r.id,
      direct: r.direct ? { ttfb: r.direct.ttfbMs, total: r.direct.totalMs, ok: r.direct.ok, label: r.direct.label, error: r.direct.error } : null,
      via: Object.fromEntries(Object.entries(r.via || {}).map(([k, v]) => [k, v.ok ? { ttfb: v.ttfbMs, total: v.totalMs } : { error: v.label || v.error || "offline", label: v.label }])),
      best: r.best,
      deltaMs: r.deltaMs,
      opencodeSkipped: r.opencodeSkipped,
    })),
    advice: (() => {
      const viaBest = (results || []).find((r) => r.best?.startsWith("via:"));
      if (viaBest) return `${viaBest.provider}/${viaBest.model} 经 ${viaBest.best.slice(4)} 最快`;
      if ((results || []).length) return `${results[0].provider} 走 direct 即可`;
      return "无数据";
    })(),
  };
  if (json) {
    return { text: JSON.stringify(jsonObj, null, 2), json: jsonObj };
  }
  const lines = [];
  lines.push(`bench-via: direct vs via peers (samples=${samples}, timeout=${timeout / 1000}s, ${opencodeTag}) peers=${peerIds.join(",") || "(none)"}`);
  lines.push("");
  // 表头：直连 + 每个组员一列（短化为 host:port 或 name），兼容旧测试 via B 断言与用户“直连/组员B”心智
  const colW = 18;
  const header = `${pad("Provider", 12)} ${pad("Model", 24)} ${pad("direct", colW, "right")} ${peerIds.map((id) => pad(`via ${id}`, colW, "right")).join(" ")} ${pad("best", 14)}`;
  lines.push(header);
  lines.push("─".repeat(header.length));
  for (const r of results || []) {
    const provider = pad(r.provider || "", 12);
    const model = pad(r.model || r.id || "", 24);
    const directOk = r.direct?.ok;
    const directTxt = directOk ? `${r.direct.ttfbMs ?? "—"}ms` : (r.direct?.label || "—");
    // determine best ttfb for ★
    const all = [];
    if (r.direct?.ok) all.push({ key: "direct", ttfb: r.direct.ttfbMs ?? r.direct.totalMs });
    for (const pid of peerIds) {
      const v = r.via?.[pid];
      if (v?.ok) all.push({ key: `via:${pid}`, ttfb: v.ttfbMs ?? v.totalMs });
    }
    let bestKey = r.best;
    if (!bestKey && all.length) bestKey = all.sort((a, b) => a.ttfb - b.ttfb)[0].key;
    const isDirectBest = bestKey === "direct";
    const directCell = pad(`${directTxt}${isDirectBest ? "★" : ""}`, colW, "right");
    const viaCells = peerIds.map((pid) => {
      // via keys 可能存为完整 url（如 http://172...）而 peerIds 已短化，兼容两者
      let v = r.via?.[pid];
      if (!v) {
        // 尝试完整 url 变体
        const full = Object.keys(r.via || {}).find((k) => {
          try { const u = new URL(k); return (u.hostname + (u.port ? `:${u.port}` : "")) === pid; } catch { return false; }
        });
        if (full) v = r.via[full];
      }
      if (!v) return pad("—", colW, "right");
      if (v.ok) {
        const txt = `${v.ttfbMs ?? v.totalMs ?? "—"}ms`;
        const star = bestKey === `via:${pid}` ? "★" : "";
        return pad(`${txt}${star}`, colW, "right");
      }
      // 失败也展示延迟（先测延迟）：如 42ms 鉴权失败，说明网络可达但该组员未配此供应商
      const ms = v.ttfbMs != null ? `${v.ttfbMs}ms ` : "";
      const label = v.label || v.error || "offline";
      const short = label.includes("离线") ? "offline" : label.slice(0, 8);
      return pad(`${ms}— ${short}`, colW, "right");
    }).join(" ");
    let bestTxt = r.best || "direct";
    if (r.deltaMs != null && r.best?.startsWith("via:")) {
      const pct = r.direct?.ttfbMs ? Math.round((r.deltaMs / r.direct.ttfbMs) * 100) : 0;
      bestTxt = `${r.best} ${pct}%`;
    }
    lines.push(`${provider} ${model} ${directCell} ${viaCells} ${pad(bestTxt, 14)}`);
  }
  lines.push("─".repeat(header.length));
  const viaBestExample = (results || []).find((r) => r.best?.startsWith("via:"));
  if (viaBestExample) lines.push(`建议：A 经 ${viaBestExample.best.slice(4)} 打 ${viaBestExample.provider} 最快；其余走 direct。`);
  else if ((results || []).length) lines.push(`建议：${results[0].provider} 走 direct 即可。`);
  else lines.push("建议：无数据");
  lines.push(`提示：via 已跳过 opencode（省额度），需对比 opencode 请加 --include-opencode`);
  lines.push(`* via 单样本，仅作参考，多次 --samples 2 取均值更稳`);
  return { text: lines.join("\n"), json: jsonObj };
}

export function formatReport(results, { json = false } = {}) {
  const sorted = sortResults(results);
  const winner = sorted.find((r) => r.ok) || null;
  if (json) {
    return { text: JSON.stringify(sorted, null, 2), json: sorted, winner, sorted };
  }
  const lines = [];
  lines.push("模型                          状态     TTFB   总耗时  速度        tokens  备注");
  lines.push("─".repeat(84));
  for (const r of sorted) {
    const isWin = winner && r.id === winner.id;
    const mark = isWin ? "*" : " ";
    const id = pad((isWin ? "* " : "  ") + r.id, 28);
    const label = pad(r.label || (r.ok ? "成功" : "失败"), 8);
    const ttfb = pad(r.ttfbMs != null ? `${r.ttfbMs}ms` : "—", 6, "right");
    const total = pad(r.totalMs != null ? `${r.totalMs}ms` : "—", 7, "right");
    let speed = "—";
    if (r.tps != null) speed = `${r.tps} t/s`;
    else if (r.charsPerSec != null) speed = `${r.charsPerSec} 字/秒`;
    speed = pad(speed, 11, "right");
    const tok = r.tokens?.completion != null ? String(r.tokens.completion) : r.chars != null ? String(r.chars) : "—";
    const note = r.ok ? "" : (r.error || "").slice(0, 50);
    lines.push(`${mark}${id} ${label} ${ttfb} ${total} ${speed} ${pad(tok, 6, "right")}  ${note}`);
  }
  lines.push("─".repeat(84));
  if (winner) lines.push(`最快：${winner.id}  TTFB ${winner.ttfbMs}ms  总 ${winner.totalMs}ms  ${winner.tps != null ? `${winner.tps} t/s` : `${winner.charsPerSec ?? "—"} 字/秒`}`);
  else lines.push("无可用模型（均失败）");
  const failed = sorted.filter((r) => !r.ok).length;
  lines.push(`完成：${sorted.length} 个，成功 ${sorted.length - failed}，失败 ${failed}`);
  return { text: lines.join("\n"), json: sorted, winner, sorted };
}
