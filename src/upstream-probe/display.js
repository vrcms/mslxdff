// ADR-0015 展示渲染：-group list 行缀 + -status 汇总（纯函数，输入 routes 数据）
// 四态文案：无数据→引导；有数据→摘要；坏数据→标 offline

function bestDisplay(entry) {
  if (!entry) return null;
  const best = String(entry.best || "direct");
  const ms = best === "direct" ? (entry.direct?.ttfbMs ?? entry.direct?.totalMs) : (entry.via?.[best.slice(4)]?.ttfbMs ?? entry.via?.[best.slice(4)]?.totalMs);
  const tag = best === "direct" ? "direct" : `via ${best.slice(4)}`;
  if (entry.direct?.ok === false && !best.startsWith("via:")) return `${tag} (${entry.direct?.label || "offline"})`;
  return ms != null ? `${tag} ${ms}ms` : tag;
}

// -group list 静态成员行尾缀：该成员作为 best 出现时的供应商与相对直连收益
export function groupRowSuffix(peerUrl, routes) {
  if (!peerUrl || !routes || typeof routes !== "object") return null;
  const label = (() => {
    const raw = String(peerUrl);
    if (raw.includes("://")) {
      try { const u = new URL(raw); return `${u.hostname}${u.port ? `:${u.port}` : ""}`; } catch { return raw.slice(-16); }
    }
    return raw;
  })();
  const wins = [];
  for (const [key, entry] of Object.entries(routes)) {
    if (!key.startsWith("provider:")) continue;
    const prov = key.slice(9);
    if (entry?.best === `via:${label}`) {
      const d = entry.deltaMs;
      wins.push(d != null ? `${prov} ${d > 0 ? "+" : ""}${d}ms` : prov);
    }
  }
  if (!wins.length) return null;
  return `  via-routes: ${wins.join(", ")}`;
}

// -status 汇总（多行字符串）：探针条目摘要 ≤5 条；空数据给引导
export function statusViaSummary({ routes, meta, probeMs }) {
  const list = Object.entries(routes || {}).filter(([k]) => k.startsWith("provider:"));
  if (!list.length) {
    return `via-routes: 无探针数据（后台探针 ${probeMs === 0 ? "已关闭" : "自动运行中"}，加入组并配置 key/token 类供应商后自动生成）`;
  }
  const at = meta?.at ? new Date(meta.at) : null;
  const atStr = at && !Number.isNaN(at.getTime()) ? at.toISOString().slice(11, 19) + "Z" : "";
  const lines = [`via-routes: ${list.length} 条（探针自动${atStr ? `，${atStr} 刷新` : ""}）`];
  for (const [key, entry] of list.slice(0, 5)) {
    const prov = key.slice(9);
    const b = bestDisplay(entry);
    if (b) lines.push(`  ${prov} → ${b}${entry.deltaMs != null ? ` (${entry.deltaMs > 0 ? "+" : ""}${entry.deltaMs}ms vs direct)` : ""}`);
  }
  if (list.length > 5) lines.push(`  … 其余 ${list.length - 5} 条见 via-routes.json`);
  return lines.join("\n");
}
