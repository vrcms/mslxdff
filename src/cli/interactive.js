// 交互式选择器：↑/↓ 移动，Enter 确认，q/Esc 取消；ANSI 原地重绘
export async function pickInteractive(items, startCursor = 0) {
  const { renderChooser, renderChooserHelp, parseKey } = await import("../chooser.js");
  let cursor = Math.min(Math.max(startCursor, 0), items.length - 1);
  const draw = () => {
    const lines = [...renderChooser(items, cursor), ...renderChooserHelp()];
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
      if (key === "up") {
        cursor = (cursor - 1 + items.length) % items.length;
        draw();
      } else if (key === "down") {
        cursor = (cursor + 1) % items.length;
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

// 多选勾选：↑/↓ 移动，Space 勾选/取消，Enter 保存，q/Esc 取消（返回 Set 或 null）
export async function pickInteractiveMulti(items, initialPicked = new Set(), startCursor = 0) {
  const { renderChooser, renderChooserHelp, parseKey } = await import("../chooser.js");
  let cursor = Math.min(Math.max(startCursor, 0), items.length - 1);
  const picked = new Set(items.filter((it) => initialPicked.has(it.id)).map((it) => it.id));
  const draw = () => {
    const rows = items.map((it, i) => ({ ...it, picked: picked.has(it.id) }));
    const lines = [...renderChooser(rows, cursor, { multi: true }), ...renderChooserHelp(true)];
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
      if (key === "up") {
        cursor = (cursor - 1 + items.length) % items.length;
        draw();
      } else if (key === "down") {
        cursor = (cursor + 1) % items.length;
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
