// 交互式模型选择器的纯渲染逻辑（便于测试）；键盘循环在 interactive.js

// items: [{ id, status?, ms?, fail?, current?, picked? }]；cursor 当前高亮行（全局下标）
// multi=true 时多选勾选（picked 显示 [x]/[ ]），否则单选默认模型（当前显示 ✓）
// index/size 可选——窗口分页渲染（只画当页 + 页头），不传 size 则全量渲染（行为不变）
// Note: 分页是本模块职责（键盘循环在 interactive.js），不传 size 必全量渲染 — 见 .agents/notes/implemented/feature/2026-09-21-models-paginated-chooser.md
export function renderChooser(items, cursor = 0, { multi = false, index = 0, size } = {}) {
  if (size == null) return renderRows(items, cursor, 0, multi);
  const total = items.length;
  const sz = Math.max(1, Number(size) || 1);
  const pages = Math.max(1, Math.ceil(total / sz));
  const idx = Math.min(Math.max(Number(index) || 0, 0), pages - 1);
  const start = idx * sz;
  const rows = [`── 第 ${idx + 1}/${pages} 页 · 共 ${total} 项（←/→ 翻页） ──`];
  rows.push(...renderRows(items.slice(start, start + sz), cursor, start, multi));
  return rows;
}

function renderRows(slice, cursor, offset, multi) {
  return slice.map((it, li) => {
    const i = offset + li;
    const arrow = i === cursor ? "❯" : " ";
    let state = "";
    if (it.fail) state = `  [fail: ${it.fail}]`;
    else if (it.ms != null) state = `  [${it.ms}ms]`;
    else if (it.status && it.status !== "normal") state = `  [${it.status}]`;
    if (multi) {
      const box = it.picked ? "[✓]" : "[ ]";
      return `${arrow} ${box} ${it.id}${state}`;
    }
    const check = it.current ? " ✓ (current)" : "";
    return `${arrow} ${it.id}${check}${state}`;
  });
}

export function renderChooserHelp(multi = false, hasPages = false) {
  const paging = hasPages ? " · ←/→ page" : "";
  return multi
    ? ["", `↑/↓ move · Space toggle pick${paging} · Enter save picks · q/Esc cancel`]
    : ["", `↑/↓ move${paging} · Enter select as default · q/Esc cancel`];
}

// 解析按键：返回 "up" | "down" | "pageup" | "pagedown" | "enter" | "cancel" | "space" | null(忽略)
export function parseKey(str) {
  if (!str) return null;
  if (str === "\x1b[A" || str === "k") return "up";
  if (str === "\x1b[B" || str === "j") return "down";
  if (str === "\x1b[D" || str === "h" || str === "\x1b[5~") return "pageup";
  if (str === "\x1b[C" || str === "l" || str === "\x1b[6~") return "pagedown";
  if (str === "\r" || str === "\n") return "enter";
  if (str === " " || str === "\x1b[32") return "space"; // 空格（32=0x20 的 ASC 表示）或某些终端 terminator
  if (str === "\x1b" || str === "q" || str === "\x03") return "cancel";
  return null;
}
