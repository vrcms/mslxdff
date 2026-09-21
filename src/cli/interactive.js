// 交互式选择器：↑/↓ 移动，←/→ 翻页，Enter 确认，q/Esc 取消；ANSI 原地重绘。
// 页高按终端行数自适应（items ≤ 页高时不分页，行为与旧版全量渲染一致）。
const PAGE_RESERVE = 6; // 页头 1 + 帮助 2 + 余量

function pageSizeFor(items) {
  const rows = Number(process.stdout?.rows) || 24;
  const size = Math.max(4, rows - PAGE_RESERVE);
  return items.length > size ? size : items.length || 1;
}

export async function pickInteractive(items, startCursor = 0) {
  const { renderChooser, renderChooserHelp, parseKey } = await import("../chooser.js");
  const size = pageSizeFor(items);
  let page = 0;
  let cursor = Math.min(Math.max(startCursor, 0), items.length - 1);
  const draw = () => {
    const usePage = size < items.length;
    const lines = [...renderChooser(items, cursor, usePage ? { index: page, size } : {}), ...renderChooserHelp(false, usePage)];
    process.stdout.write("\x1b[2J\x1b[H" + lines.join("\n"));
  };
  draw();
  return new Promise((resolve) => {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    const cleanup = () => {
      process.stdin.removeListener("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
    };
    const onData = (chunk) => {
      const key = parseKey(String(chunk));
      const pages = Math.max(1, Math.ceil(items.length / size));
      if (key === "up") {
        cursor = (cursor - 1 + items.length) % items.length;
        page = Math.floor(cursor / size);
        draw();
      } else if (key === "down") {
        cursor = (cursor + 1) % items.length;
        page = Math.floor(cursor / size);
        draw();
      } else if (key === "pageup") {
        page = (page - 1 + pages) % pages;
        cursor = page * size;
        draw();
      } else if (key === "pagedown") {
        page = (page + 1) % pages;
        cursor = Math.min(page * size, items.length - 1);
        draw();
      } else if (key === "enter") {
        cleanup();
        resolve(items[cursor].id);
      } else if (key === "cancel") {
        cleanup();
        resolve(null);
      }
    };
    process.stdin.on("data", onData);
  });
}

// 多选勾选：↑/↓ 移动，←/→ 翻页，Space 勾选/取消，Enter 保存，q/Esc 取消（返回 Set 或 null）
export async function pickInteractiveMulti(items, initialPicked = new Set(), startCursor = 0) {
  const { renderChooser, renderChooserHelp, parseKey } = await import("../chooser.js");
  const size = pageSizeFor(items);
  let page = 0;
  let cursor = Math.min(Math.max(startCursor, 0), items.length - 1);
  const picked = new Set(items.filter((it) => initialPicked.has(it.id)).map((it) => it.id));
  const draw = () => {
    const usePage = size < items.length;
    const rows = items.map((it, i) => ({ ...it, picked: picked.has(it.id) }));
    const lines = [...renderChooser(rows, cursor, { multi: true, ...(usePage ? { index: page, size } : {}) }), ...renderChooserHelp(true, usePage)];
    process.stdout.write("\x1b[2J\x1b[H" + lines.join("\n"));
  };
  draw();
  return new Promise((resolve) => {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    const cleanup = () => {
      process.stdin.removeListener("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
    };
    const onData = (chunk) => {
      const key = parseKey(String(chunk));
      const pages = Math.max(1, Math.ceil(items.length / size));
      if (key === "up") {
        cursor = (cursor - 1 + items.length) % items.length;
        page = Math.floor(cursor / size);
        draw();
      } else if (key === "down") {
        cursor = (cursor + 1) % items.length;
        page = Math.floor(cursor / size);
        draw();
      } else if (key === "pageup") {
        page = (page - 1 + pages) % pages;
        cursor = page * size;
        draw();
      } else if (key === "pagedown") {
        page = (page + 1) % pages;
        cursor = Math.min(page * size, items.length - 1);
        draw();
      } else if (key === "space") {
        const id = items[cursor].id;
        if (picked.has(id)) picked.delete(id);
        else picked.add(id);
        draw();
      } else if (key === "enter") {
        cleanup();
        resolve(new Set(picked));
      } else if (key === "cancel") {
        cleanup();
        resolve(null);
      }
    };
    process.stdin.on("data", onData);
  });
}
