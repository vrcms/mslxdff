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
