// 交互式模型选择器的纯渲染逻辑（便于测试）；键盘循环在 bin/mslxdff.js

// items: [{ id, status?, ms?, fail?, current? }]；cursor 当前高亮行
// 返回行数组（无 ANSI 颜色，纯文本标记，Windows 终端友好）
export function renderChooser(items, cursor = 0) {
  return items.map((it, i) => {
    const arrow = i === cursor ? "❯" : " ";
    const check = it.current ? " ✓ (current)" : "";
    let state = "";
    if (it.fail) state = `  [fail: ${it.fail}]`;
    else if (it.ms != null) state = `  [${it.ms}ms]`;
    else if (it.status && it.status !== "normal") state = `  [${it.status}]`;
    return `${arrow} ${it.id}${check}${state}`;
  });
}

export function renderChooserHelp() {
  return ["", "↑/↓ move · Enter select as default · q/Esc cancel"];
}

// 解析按键：返回 "up" | "down" | "enter" | "cancel" | null(忽略)
export function parseKey(str) {
  if (!str) return null;
  if (str === "\x1b[A" || str === "k") return "up";
  if (str === "\x1b[B" || str === "j") return "down";
  if (str === "\r" || str === "\n") return "enter";
  if (str === "\x1b" || str === "q" || str === "\x03") return "cancel";
  return null;
}
