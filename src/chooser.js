// 交互式模型选择器的纯渲染逻辑（便于测试）；键盘循环在 bin/mslxdff.js

// items: [{ id, status?, ms?, fail?, current?, picked? }]；cursor 当前高亮行
// multi=true 时多选勾选（picked 显示 [x]/[ ]），否则单选默认模型（当前显示 ✓）
// 返回行数组（无 ANSI 颜色，纯文本标记，Windows 终端友好）
export function renderChooser(items, cursor = 0, { multi = false } = {}) {
  return items.map((it, i) => {
    const arrow = i === cursor ? "❯" : " ";
    const check = multi
      ? (it.picked ? " [✓]" : " [ ]")
      : (it.current ? " ✓ (current)" : "");
    let state = "";
    if (it.fail) state = `  [fail: ${it.fail}]`;
    else if (it.ms != null) state = `  [${it.ms}ms]`;
    else if (it.status && it.status !== "normal") state = `  [${it.status}]`;
    return `${arrow} ${it.id}${check}${state}`;
  });
}

export function renderChooserHelp(multi = false) {
  return multi
    ? ["", "↑/↓ move · Space toggle pick · Enter save picks · q/Esc cancel"]
    : ["", "↑/↓ move · Enter select as default · q/Esc cancel"];
}

// 解析按键：返回 "up" | "down" | "enter" | "cancel" | "space" | null(忽略)
export function parseKey(str) {
  if (!str) return null;
  if (str === "\x1b[A" || str === "k") return "up";
  if (str === "\x1b[B" || str === "j") return "down";
  if (str === "\r" || str === "\n") return "enter";
  if (str === " " || str === "\x1b[32") return "space"; // 空格（32=0x20 的 ASC 表示）或某些终端 terminator
  if (str === "\x1b" || str === "q" || str === "\x03") return "cancel";
  return null;
}
