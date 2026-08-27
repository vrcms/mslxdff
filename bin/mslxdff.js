#!/usr/bin/env node
import { execFile } from "node:child_process";
import { readFileSync, existsSync, statSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";
import { startServer, resolvePort } from "../src/server.js";
import { DEFAULT_PORT, defaultStateFile } from "../src/state.js";
import { createRouter } from "../src/routes.js";
import { createUpstreamClient } from "../src/upstream.js";
import { createModelsService } from "../src/models.js";
import { loadToken, refreshToken, setPort, getPort, loadGroupsJoined, saveGroupsJoined, loadModelErrors, savePreferredModel, loadPreferredModel, loadModelPicks, saveModelPicks, loadProviderKey, loadProviderKeys } from "../src/state.js";
import { getPreferredModel } from "../src/auto.js";
import { normalizeModel } from "../src/reasoning.js";
import { syncToWorkbuddy, workbuddyModelsPath } from "../src/sync-workbuddy.js";
import { startDaemon, stopDaemon, writePid, pidFile, logFile, readPid, readPidVersion, isPidAlive } from "../src/daemon.js";
import { createAutoSelector } from "../src/auto.js";
import { createPeersService } from "../src/peers.js";
import { createEventBus } from "../src/events.js";
import { createGroupsService, createBansService, refreshGroupMembers, syncPeersFromMembers } from "../src/groups.js";
import { logDir, recentCalls, lastError, appendCall, appendError, appendEvent, recentEvents, eventsFile, callsFile, errorsFile } from "../src/logs.js";
import { loadPlugins, runHook, pluginsDir, resolvePluginDirs } from "../src/plugins.js";
import { createOpenCodeProvider } from "../src/providers/opencode.js";

const logs = { appendCall, appendError, appendEvent };

const args = process.argv.slice(2);
const VERSION = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8")).version;
const HEALTH_TIMEOUT_MS = 4000;

if (args.includes("-help") || args.includes("--help") || args.includes("-h")) {
  printHelp();
  process.exit(0);
}

if (args.includes("-update") || args.includes("--update")) {
  await updateSelf();
  process.exit(0);
}

if (args.includes("-refresh-token") || args.includes("--refresh-token")) {
  const token = await refreshToken();
  console.log(token);
  process.exit(0);
}

if (args.includes("-showtoken") || args.includes("--showtoken")) {
  const { token } = await loadToken();
  console.log(token);
  process.exit(0);
}

if (args.includes("-stop") || args.includes("--stop")) {
  const { stopped, pid, reason } = stopDaemon();
  if (stopped) {
    console.log(`mslxdff daemon stopped (pid ${pid})`);
  } else {
    console.log(`mslxdff daemon not running${reason ? ` (${reason})` : ""}`);
  }
  process.exit(0);
}

if (args.includes("-uninstall") || args.includes("--uninstall")) {
  const { stopped, pid } = stopDaemon();
  if (stopped) console.log(`mslxdff daemon stopped (pid ${pid})`);
  else console.log("mslxdff daemon not running");

  const stateFile = defaultStateFile();
  const dir = dirname(stateFile);
  const removed = [];
  for (const f of [
    stateFile,
    pidFile(),
    logFile(),
    join(dir, "calls.log"),
    join(dir, "errors.log"),
    join(dir, "events.log"),
  ]) {
    try {
      rmSync(f, { force: true });
      removed.push(f);
    } catch {
      // already gone, fine
    }
  }
  if (removed.length) console.log(`removed ${removed.length} file(s):\n  ${removed.join("\n  ")}`);
  else console.log("no state/log files to remove");

  console.log("\npackage still installed — finish with:");
  console.log("  npm uninstall -g mslxdff");
  process.exit(0);
}

if (args.includes("-log") || args.includes("--log") || args.includes("-logs") || args.includes("--logs")) {
  const idx = args.findIndex((x) => x === "-log" || x === "--log" || x === "-logs" || x === "--logs");
  const raw = args[idx + 1];
  const n = Number(raw);
  const count = Number.isInteger(n) && n > 0 ? n : 10;
  const file = eventsFile();
  const dir = logDir();
  console.log(`log dir: ${dir}`);
  console.log(`events:  ${file}`);
  const evts = recentEvents(count);
  if (!evts.length) {
    console.log(`(no events yet — file empty or not found)`);
  } else {
    console.log(`--- last ${evts.length} event(s) ---`);
    for (const e of evts) console.log(fmtEvent(e));
  }
  // also hint for other logs
  if (count <= 10) {
    console.log(`\nhint: mslxdff -log 100  |  calls: ${callsFile()}  errors: ${errorsFile()}  daemon: ${logFile()}`);
  }
  process.exit(0);
}

// -plugins: list plugins in the plugins dirs (and their hooks) without starting the daemon
if (args.includes("-plugins") || args.includes("--plugins")) {
  const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const dirs = resolvePluginDirs({ pkgRoot });
  const labels = ["official (bundled)", "user"];
  if (dirs.length === 1) labels[0] = "dir";
  console.log(`plugin dirs:`);
  dirs.forEach((d, i) => console.log(`  [${labels[i] || `dir${i + 1}`}] ${d}${existsSync(d) ? "" : "  (not created yet)"}`));
  const { plugins, errors } = await loadPlugins({ dirs });
  if (!plugins.length && !errors.length) {
    console.log("(no plugins — drop *.mjs files into a dir above, see docs/plugins.md)");
  }
  for (const p of plugins) {
    const hooks = Object.keys(p.hooks || {});
    const src = p.file.startsWith(pkgRoot) ? "official" : "user";
    console.log(`  ${p.name}${p.version ? `@${p.version}` : ""}  [${hooks.join(", ") || "no hooks"}]  (${src})`);
    if (p.description) console.log(`    ${p.description}`);
  }
  for (const e of errors) console.log(`  load error: ${e.file} — ${e.error}`);
  process.exit(0);
}

if (args.includes("-status") || args.includes("--status") || args.includes("-s")) {
  await printStatus();
  process.exit(0);
}

// -model list | -models : show the free models this proxy serves (cache-first)
// -model refresh : force a fresh fetch from the upstream and update the cache
if (args.includes("-model") || args.includes("-models")) {
  const idx = args.findIndex((x) => x === "-model" || x === "-models");
  const sub = args[idx + 1];
  if (sub === "refresh") {
    const models = createModelsService({
      baseUrl: process.env.UPSTREAM_BASE_URL || "https://opencode.ai",
      headers: createUpstreamClient({}).headers,
      refreshMs: 0,
      cacheFile: join(logDir(), "models.json"),
    });
    try {
      const list = await models.get();
      const ids = (list.data || []).map((m) => m.id).filter(Boolean);
      console.log(`refreshed: ${ids.length} free model(s)`);
      for (const id of ids) console.log(`  ${id}`);
    } catch (err) {
      console.error(`could not refresh models: ${String(err?.message || err)}`);
      process.exit(1);
    }
    process.exit(0);
  }
  if (sub === "status") {
    const statuses = loadModelErrors();
    const cacheFile = join(logDir(), "models.json");
    const cached = readModelsCache(cacheFile);
    const ids = new Set([
      ...(cached?.data || []).map((m) => m.id),
      ...Object.keys(statuses),
    ]);
    for (const id of ids) {
      const e = statuses[id];
      const st = typeof e === "number" ? "error" : e?.status || "normal";
      const at = typeof e === "number" ? e : e?.at;
      const when = at
        ? `  (${new Date(at).toISOString().slice(5, 19).replace("T", " ")})`
        : "";
      const extra = e?.code ? `  HTTP ${e.code}` : "";
      console.log(`  ${id}  ${st}${when}${extra}`);
    }
    process.exit(0);
  }
  if (sub === "set" && args[idx + 2]) {
    const id = args[idx + 2];
    savePreferredModel(id);
    const picks = [...new Set([...loadModelPicks(), id])];
    saveModelPicks(picks);
    console.log(`default model set to: ${id} (daemon hot-reloads on next request)`);
    console.log(`picked: ${picks.join(", ") || "(none)"} (auto will pick within these)`);
    process.exit(0);
  }
  // -model pick <id> | -model unpick <id> | -model picks : 常用模型勾选集管理（非 TTY 用）
  if (sub === "pick" && args[idx + 2] && args[idx + 2] !== "clear") {
    const picks = [...new Set([...loadModelPicks(), args[idx + 2]])];
    saveModelPicks(picks);
    console.log(`picked: ${picks.join(", ") || "(none)"} (auto will pick within these)`);
    process.exit(0);
  }
  if (sub === "pick" && args[idx + 2] === "clear") {
    saveModelPicks([]);
    console.log("picks cleared — auto uses the full model list again");
    process.exit(0);
  }
  if (sub === "unpick" && args[idx + 2]) {
    const picks = loadModelPicks().filter((x) => x !== args[idx + 2]);
    saveModelPicks(picks);
    console.log(`picked: ${picks.join(", ") || "(none)"}${picks.length === 0 ? " (auto uses full list)" : ""}`);
    process.exit(0);
  }
  if (sub === "picks") {
    const picks = loadModelPicks();
    if (!picks.length) {
      console.log("no picks — auto uses the full model list");
    } else {
      console.log(`${picks.length} picked model(s), auto only selects within these:`);
    }
    for (const id of picks) console.log(`  ${id}`);
    process.exit(0);
  }
  if (sub !== undefined && sub !== "list") {
    console.error("usage: mslxdff -models (interactive multi-pick) | mslxdff -model list | mslxdff -model set <id> | mslxdff -model pick <id> | mslxdff -model unpick <id> | mslxdff -model pick clear | mslxdff -model picks | mslxdff -model status | mslxdff -model refresh");
    process.exit(1);
  }
  const cacheFile = join(logDir(), "models.json");
  // 主动刷新：每次执行都尝试拉取上游最新列表（4s 超时），成功则更新缓存，失败则回退到 stale
  async function tryRefreshModels() {
    try {
      const models = createModelsService({
        baseUrl: process.env.UPSTREAM_BASE_URL || "https://opencode.ai",
        headers: createUpstreamClient({}).headers,
        refreshMs: 0,
        cacheFile,
      });
      // 4s 超时，避免阻塞
      const list = await Promise.race([
        models.get(),
        new Promise((_, rej) => setTimeout(() => rej(new Error("refresh timeout")), 4000)),
      ]);
      return list;
    } catch {
      return null;
    }
  }
  try {
    let ids = [];
    let cachedAt = null;
    let refreshed = null;
    // 每次都主动尝试刷新
    refreshed = await tryRefreshModels();
    if (refreshed?.data) {
      ids = (refreshed.data || []).map((m) => m.id).filter(Boolean);
      cachedAt = refreshed.cachedAt || Date.now();
    } else {
      const cached = readModelsCache(cacheFile);
      if (cached) {
        ids = (cached.data || []).map((m) => m.id).filter(Boolean);
        cachedAt = cached.cachedAt || null;
      } else {
        // 无缓存且刷新失败，尝试一次兜底 fetch（已在 tryRefreshModels 中尝试过，此处直接报错）
        throw new Error("no cached models and refresh failed");
      }
    }
    if (!ids.length) {
      console.log("no models available — try: mslxdff -model refresh");
      process.exit(0);
    }
    // TTY：交互式多选勾选常用模型（空格勾选，Enter 保存）；非 TTY（管道/脚本）：保持纯列表并标注勾选
    if (process.stdin.isTTY && process.stdout.isTTY) {
      const statuses = loadModelErrors();
      const current = getPreferredModel();
      const pickedIds = loadModelPicks();
      const items = ids.map((id) => {
        const e = statuses[id];
        return {
          id,
          status: typeof e === "number" ? "error" : e?.status || "normal",
          current: id === current,
          picked: pickedIds.includes(id),
        };
      });
      const result = await pickInteractiveMulti(items, new Set(pickedIds), Math.max(0, items.findIndex((x) => x.current)));
      if (!result) {
        console.log("cancelled — picks unchanged");
        process.exit(0);
      }
      saveModelPicks([...result]);
      console.log(`saved ${result.size} picked model(s): ${[...result].join(", ") || "(none — auto uses full list)"}`);
      process.exit(0);
    }
    const at = cachedAt ? ` (cached ${new Date(cachedAt).toISOString().slice(0, 16).replace("T", " ")})` : "";
    const pickedIds = loadModelPicks();
    const mark = (id) => (pickedIds.includes(id) ? "*" : " ");
    console.log(`${ids.length} free model(s)${at} (${pickedIds.length} picked, * = picked):`);
    for (const id of ids) console.log(`  ${mark(id)} ${id}`);
    console.log(`\npicked only constrains auto; manage with: mslxdff -models (TTY) | mslxdff -model pick <id> | mslxdff -model unpick <id> | mslxdff -model pick clear`);
  } catch (err) {
    console.error(`could not fetch models: ${String(err?.message || err)}`);
    process.exit(1);
  }
  process.exit(0);
}

// -setto workbuddy [modelId]: set default model and sync to WorkBuddy models.json
if (args.includes("-setto") || args.includes("--setto")) {
  const idx = args.findIndex((x) => x === "-setto" || x === "--setto");
  const target = args[idx + 1];
  if (target !== "workbuddy") {
    console.error("usage: mslxdff -setto workbuddy [modelId]");
    process.exit(1);
  }
  const raw = args[idx + 2] && !String(args[idx + 2]).startsWith("-") ? String(args[idx + 2]).trim() : null;
  let id;
  if (raw) {
    if (raw === "auto" || !raw) {
      console.error("modelId 不能为 auto 或空");
      process.exit(1);
    }
    const norm = normalizeModel(raw);
    if (!norm) {
      console.error("modelId 不能为空");
      process.exit(1);
    }
    savePreferredModel(norm);
    console.log(`default model set to: ${norm} (daemon hot-reloads on next request)`);
    id = norm;
  } else {
    id = loadPreferredModel() || getPreferredModel();
    if (!id) {
      console.error("no preferred model set; use: mslxdff -setto workbuddy <modelId>");
      process.exit(1);
    }
  }
  // 主动刷新模型列表（每次 -setto 都尝试，保证 deepseek 等最新模型可见；失败不阻断同步）
  try {
    const cacheFile = join(logDir(), "models.json");
    const models = createModelsService({
      baseUrl: process.env.UPSTREAM_BASE_URL || "https://opencode.ai",
      headers: createUpstreamClient({}).headers,
      refreshMs: 0,
      cacheFile,
    });
    const fresh = await Promise.race([
      models.get(),
      new Promise((_, rej) => setTimeout(() => rej(new Error("refresh timeout")), 4000)),
    ]);
    if (fresh?.data?.length) {
      const ids = fresh.data.map((m) => m.id);
      if (!ids.includes(id)) {
        console.log(`warn: "${id}" not in current free list (${ids.length} models), still syncing to WorkBuddy`);
      }
    }
  } catch {
    // refresh failed, still proceed with sync using stale/cached list
  }
  try {
    const { token } = await loadToken();
    const persisted = getPort();
    const envPort = Number(process.env.MSLXDFF_PORT);
    const port = persisted !== null ? persisted : (Number.isInteger(envPort) && envPort > 0 ? envPort : 8989);
    const file = workbuddyModelsPath();
    const r = await syncToWorkbuddy({ id, token, port, file });
    console.log(`synced to WorkBuddy: ${r.action} "${id}" @ ${file}`);
    console.log(`  url: http://127.0.0.1:${port}/v1/chat/completions`);
  } catch (err) {
    console.error(`failed to sync to WorkBuddy: ${String(err?.message || err)}`);
    process.exit(1);
  }
  process.exit(0);
}

// -provider <id> [key...|add|remove|list|clear]: 配置需鉴权的供应商 API key（如 openrouter）。
// 行为：无参数且 TTY → 交互式隐藏输入（多行直到空行，逐一追加）；非 TTY → 打印用法。key 持久化到 state。
if (args.includes("-provider") || args.includes("--provider")) {
  const idx = args.findIndex((x) => x === "-provider" || x === "--provider");
  const id = args[idx + 1];
  const sub = args[idx + 2];
  const rest = args.slice(idx + 2);
  if (!id) {
    console.error("usage: mslxdff -provider <id> [key...|add|remove|list|clear]");
    console.error("       e.g. mslxdff -provider openrouter sk-1 sk-2 sk-3      set multiple keys (replaces all)");
    console.error("            mslxdff -provider openrouter add sk-4             append one key");
    console.error("            mslxdff -provider openrouter remove sk-1          remove a key by value");
    console.error("            mslxdff -provider openrouter list                 list all keys (masked)");
    console.error("            mslxdff -provider openrouter                      interactive hidden input (append)");
    console.error("            mslxdff -provider openrouter clear                remove all keys");
    process.exit(1);
  }
  const { loadProviderKeys, saveProviderKeys, addProviderKey, removeProviderKeys } = await import("../src/state.js");
  if (sub === "clear") {
    saveProviderKeys(id, []);
    console.log(`cleared ${id} API keys (provider disabled on next daemon start)`);
    process.exit(0);
  }
  if (sub === "list" || sub === "status") {
    const keys = loadProviderKeys(id);
    if (keys.length) {
      console.log(`provider: ${id} (${keys.length} key${keys.length > 1 ? "s" : ""})`);
      keys.forEach((k, i) => console.log(`  [${i + 1}]  ${k.slice(0, 4)}…${k.slice(-4)} (${k.length} chars)`));
      console.log(`  remove by: mslxdff -provider ${id} remove <seq> [seq...] | <key-value>`);
    } else {
      console.log(`provider: ${id} (no keys configured)`);
    }
    process.exit(0);
  }
  if (sub === "add") {
    const key = rest[1];
    if (!key) {
      console.error("usage: mslxdff -provider openrouter add <key>");
      process.exit(1);
    }
    const added = addProviderKey(id, key);
    console.log(`added ${id} API key (now ${added.length} total) — restart daemon to activate`);
    process.exit(0);
  }
  if (sub === "remove") {
    const targets = rest.slice(1).filter((k) => !k.startsWith("-"));
    if (!targets.length) {
      console.error("usage: mslxdff -provider openrouter remove <seq|key> [seq|key ...]   (seq = index shown by 'list')");
      process.exit(1);
    }
    const current = loadProviderKeys(id);
    const toRemove = [];
    for (const raw of targets.flatMap((t) => String(t).split(","))) {
      const t = raw.trim();
      if (!t) continue;
      if (/^\d+$/.test(t)) {
        const seq = Number(t);
        const idx = seq - 1;
        if (Number.isInteger(seq) && idx >= 0 && idx < current.length) toRemove.push(current[idx]);
        else console.log(`  ! no key at sequence ${seq} (provider has ${current.length}) — skipped`);
      } else {
        toRemove.push(t);
      }
    }
    if (!toRemove.length) {
      console.log("nothing to remove");
      process.exit(0);
    }
    const remaining = removeProviderKeys(id, [...new Set(toRemove)]);
    console.log(`removed ${current.length - remaining.length} ${id} API key(s) (now ${remaining.length} total) — restart daemon to activate`);
    process.exit(0);
  }
  if (sub && !sub.startsWith("-")) {
    const keys = rest.filter((k) => !k.startsWith("-"));
    if (!keys.length) {
      console.error("no key given");
      process.exit(1);
    }
    saveProviderKeys(id, keys);
    console.log(`set ${id} API keys (${keys.length}: ${keys.map((k) => `${k.slice(0, 4)}…${k.slice(-4)}`).join(", ")}) — restart daemon to activate`);
    process.exit(0);
  }
  // 交互式隐藏输入：多行直到空行，逐一追加到现有 keys
  if (process.stdin.isTTY && process.stdout.isTTY) {
    const readline = await import("node:readline/promises");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    console.log(`Enter ${id} API keys, one per line (input hidden). Blank line to finish:`);
    const existing = loadProviderKeys(id);
    const collected = [];
    for (;;) {
      const key = await rl.question(existing.length || collected.length ? "" : "");
      const clean = String(key || "").trim();
      if (!clean) break;
      collected.push(clean);
    }
    rl.close();
    if (!collected.length) {
      console.log("empty input — nothing changed");
      process.exit(0);
    }
    for (const k of collected) addProviderKey(id, k);
    const total = (await import("../src/state.js")).loadProviderKeys(id).length;
    console.log(`added ${collected.length} ${id} API key(s) (now ${total} total) — restart daemon to activate`);
    process.exit(0);
  }
  console.error("provide keys inline (non-TTY): mslxdff -provider openrouter <key1> [key2 ...]");
  process.exit(1);
}

// 交互式选择器：↑/↓ 移动，Enter 确认，q/Esc 取消；ANSI 原地重绘
async function pickInteractive(items, startCursor = 0) {
  const { renderChooser, renderChooserHelp, parseKey } = await import("../src/chooser.js");
  let cursor = Math.min(Math.max(startCursor, 0), items.length - 1);
  const draw = () => {
    const lines = [...renderChooser(items, cursor), ...renderChooserHelp()];
    process.stdout.write("\x1b[G\x1b[J" + lines.join("\n"));
  };
  draw();
  return new Promise((resolve) => {
    const wasRaw = process.stdin.isRaw;
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
async function pickInteractiveMulti(items, initialPicked = new Set(), startCursor = 0) {
  const { renderChooser, renderChooserHelp, parseKey } = await import("../src/chooser.js");
  let cursor = Math.min(Math.max(startCursor, 0), items.length - 1);
  const picked = new Set(items.filter((it) => initialPicked.has(it.id)).map((it) => it.id));
  const draw = () => {
    const rows = items.map((it, i) => ({ ...it, picked: picked.has(it.id) }));
    const lines = [...renderChooser(rows, cursor, { multi: true }), ...renderChooserHelp(true)];
    process.stdout.write("\x1b[G\x1b[J" + lines.join("\n"));
  };
  draw();
  return new Promise((resolve) => {
    const wasRaw = process.stdin.isRaw;
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

// -debug: stop the background daemon and run the server in THIS terminal
// (foreground), printing every event to stdout in real time via the in-memory
// event bus — no filesystem polling. Ctrl+C / SIGTERM restarts the daemon in
// the background, then exits. See the daemon body below for the stream wiring.
if (args.includes("-debug") || args.includes("--debug")) {
  // 先停旧 daemon，再清日志，保持 debug 输出干净（仅本次会话）
  const { stopped, pid } = stopDaemon();
  if (stopped) console.log(`[debug] stopped background daemon (pid ${pid})`);
  try {
    const dir = logDir();
    const toClear = [eventsFile(), callsFile(), errorsFile(), logFile()];
    let cleared = 0;
    for (const f of toClear) {
      try {
        if (existsSync(f)) {
          writeFileSync(f, "");
          cleared++;
        }
      } catch {}
    }
    console.log(`[debug] 已清理旧日志 ${cleared} 个文件 (${dir})，本次会话干净输出`);
  } catch {}
  console.log("--- live (Ctrl+C: stop debugging and restore background daemon) ---");
  process.env.MSLXDFF_DEBUG = "1";
  process.env.MSLXDFF_DAEMON = "1";
  // fall through to the daemon body below — no process.exit() here
}

// -creategroup <name> | -group create <name> | -group sync | -group leave <name> | -group list |
// -addtogroup <leader-host> <name> | -resetban [ip]
const createGroupArg = argValue("-creategroup", "--creategroup") || groupIs("create", args);
if (createGroupArg) {
  const groups = createGroupsService({});
  const peers = createPeersService({});
  const name = createGroupArg;
  const { created } = groups.create(name); // the group name is the password
  markJoined({ name, leaderUrl: "", myUrl: "", memberName: "leader" });
  const synced = await syncAllJoinedGroups({ peers, groups });
  const s = synced.find((x) => x.name === name);
  console.log(created ? `group created: ${name}` : `group already exists: ${name}`);
  console.log(`members on this node: ${s ? `${s.total} (failover: ${s.added})` : "?"}`);
  console.log(`others join with: mslxdff -addtogroup <this-node-host> ${name}`);
  process.exit(0);
}

function groupIs(action, argv) {
  const idx = argv.indexOf("-group");
  if (idx < 0) return null;
  return argv[idx + 1] === action ? argv[idx + 2] : null;
}

const groupCmd = argValue("-group", "--group");
if (groupCmd && groupCmd !== "create") {
  const groups = createGroupsService({});
  const peers = createPeersService({});
  const rest = args.slice(args.indexOf("-group") + 1);
  const [action, a] = rest;
  if (action === "sync") {
    const synced = await syncAllJoinedGroups({ peers, groups });
    if (!synced.length) {
      console.log("not joined to any group (use -addtogroup or -creategroup)");
    } else {
      for (const s of synced) {
        if (s.error) console.log(`${s.name}: sync failed — ${s.error}`);
        else console.log(`${s.name}: ${s.total} member(s), ${s.added} failover target(s) configured`);
      }
    }
  } else if (action === "leave" && a) {
    const before = loadGroupsJoined().filter((g) => g.name === a).length;
    saveGroupsJoined(loadGroupsJoined().filter((g) => g.name !== a));
    const removed = peers.removeByGroup(a);
    console.log(before ? `left group "${a}" (${removed} member(s) removed)` : `not a member of group "${a}"`);
  } else if (action === "list") {
    const joinedList = loadGroupsJoined();
    if (!joinedList.length) {
      console.log("no groups on this node");
      process.exit(0);
    }
    const { token } = await loadToken();
    const fetchImpl = (url, opts) => fetch(url, { ...opts, signal: AbortSignal.timeout(1500) });
    for (const g of joinedList) {
      const isLeader = !g.leaderUrl;
      let members;
      if (isLeader) {
        members = groups.list()[g.name]?.members || {};
      } else {
        try {
          members = await refreshGroupMembers(g.name, {
            leaderUrl: g.leaderUrl,
            memberName: g.memberName,
            url: g.myUrl,
            token,
            fetchImpl,
          });
        } catch (err) {
          console.log(`${g.name}  (members unavailable — leader unreachable: ${errMsg(err)})`);
          continue;
        }
      }
      const entries = Object.entries(members).filter(([id]) => id !== "leader");
      console.log(`${g.name}  (${entries.length} member${entries.length === 1 ? "" : "s"})`);
      // probe every member endpoint concurrently for reachability + latency;
      // display order = state order so the sequence numbers stay stable for -group remove
      // broadband members (relay://) are not probed — they are reachable via leader
      const probes = await Promise.all(
        entries.map(([id, m]) => probeHealth({ id, url: m?.url || id, kind: m?.kind, lastSeen: m?.lastSeen, publicIp: m?.publicIp }))
      );
      const leaderEntry = members.leader ? Object.entries(members).find(([id]) => id === "leader") : null;
      const leaderProbe = leaderEntry ? await probeHealth({ id: "leader", url: leaderEntry[1].url }) : null;
      const display = leaderProbe ? [...probes, leaderProbe] : probes;
      let seq = 0;
      for (const r of display) {
        const m = entries.find(([eid]) => eid === r.id)?.[1] || (r.id === "leader" ? leaderEntry?.[1] : null);
        const isBb = r.kind === "broadband" || String(r.url || "").startsWith("relay://") || m?.kind === "broadband";
        if (isBb) {
          const ago = r.lastSeen ? `${Math.round((Date.now() - r.lastSeen) / 1000)}s ago` : "no heartbeat yet";
          const ip = r.publicIp || m?.publicIp || "?";
          const via = r.stale ? "stale" : `via leader ${ago}`;
          const stateBb = `${via} ip=${ip}`;
          if (r.id === "leader") {
            console.log(`  leader  ${r.url}  ${stateBb}`);
            continue;
          }
          seq += 1;
          const label = r.id && r.id !== r.url ? `  [${r.id}]` : "";
          console.log(`  ${seq}. ${r.url}${label}  [broadband] ${stateBb}`);
          continue;
        }
        const state = r.fail ? `fail  ${r.fail}` : `ok    ${r.ms}ms`;
        if (r.id === "leader") {
          console.log(`  leader  ${r.url}  ${state}`);
          continue;
        }
        seq += 1;
        const label = r.id && r.id !== r.url ? `  [${r.id}]` : "";
        console.log(`  ${seq}. ${r.url}${label}  ${state}`);
      }
    }
    console.log(`\njoined groups (${joinedList.length}):`);
    for (const g of joinedList) console.log(`  ${g.name}  ${g.leaderUrl || "(this node is the leader)"}`);
  } else if (action === "remove" && a) {
    // leader-only: kick a member by its list sequence number (1-based, leader excluded)
    const seq = Number(a);
    if (!Number.isInteger(seq) || seq < 1) {
      console.error(`usage: mslxdff -group remove <seq>`);
      process.exit(1);
    }
    const joined = loadGroupsJoined().find((g) => !g.leaderUrl);
    if (!joined) {
      console.error("group remove requires being the leader — this node leads no group");
      process.exit(1);
    }
    const members = groups.list()[joined.name]?.members || {};
    const entries = Object.entries(members).filter(([id]) => id !== "leader");
    const target = entries[seq - 1];
    if (!target) {
      console.error(`member #${seq} not found — group "${joined.name}" has ${entries.length} member(s)`);
      process.exit(1);
    }
    const [id, m] = target;
    try {
      const removed = groups.removeMember(joined.name, { url: m.url });
      if (removed) console.log(`removed ${m.url} from "${joined.name}"`);
      else console.log(`member ${m.url} already gone from "${joined.name}"`);
    } catch (err) {
      console.error(`remove failed: ${errMsg(err)}`);
      process.exit(1);
    }
  } else {
    console.error("usage: mslxdff -group sync | -group leave <name> | -group list | -group remove <seq> | -creategroup <name>");
  }
  process.exit(0);
}

// -addtogroup <leader-host> <name> [--broadband]
const addToGroupIdx = args.findIndex((x) => x === "-addtogroup" || x === "--addtogroup");
if (addToGroupIdx >= 0) {
  const rawArgs = args.slice(addToGroupIdx + 1);
  const isBroadband = rawArgs.includes("--broadband");
  const filtered = rawArgs.filter((a) => a !== "--broadband");
  const [leaderHost, name] = filtered;
  if (!leaderHost || !name || filtered.length > 2) {
    console.error("usage: mslxdff -addtogroup <leader-host> <name> [--broadband]");
    process.exit(1);
  }
  const groups = createGroupsService({});
  const peers = createPeersService({});
  const myToken = (await loadToken()).token;
  const leaderUrl = leaderHost.includes("://")
    ? leaderHost.replace(/\/+$/, "")
    : `http://${leaderHost}${leaderHost.includes(":") ? "" : ":8989"}`;
  const kind = isBroadband ? "broadband" : "static";
  let joinBody;
  if (isBroadband) {
    const relayId = `relay://${myToken.slice(0, 8)}`;
    joinBody = { name, key: name, leaderUrl, url: relayId, token: myToken, kind: "broadband" };
  } else {
    const myPort = effectivePort();
    joinBody = { name, key: name, leaderUrl, myPort, token: myToken, kind: "static" };
  }
  try {
    const res = await fetch(`${leaderUrl}/v1/groups/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(joinBody),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`join failed (HTTP ${res.status}): ${text}`);
    }
    const data = await res.json();
    const myUrl = data.you?.url || joinBody.url || "";
    const memberName = isBroadband ? myUrl : myUrl;
    markJoined({ name, leaderUrl, myUrl, memberName, kind });
    const synced = await syncAllJoinedGroups({ peers, groups });
    const s = synced.find((x) => x.name === name);
    console.log(`joined group "${name}" at ${leaderUrl}${isBroadband ? " [broadband]" : ""}`);
    if (s?.error) console.log(`  local failover setup failed: ${s.error}`);
    else console.log(`  ${s?.added ?? 0} failover target(s) configured${isBroadband ? " (broadband via leader, local 127.0.0.1)" : ""}`);
  } catch (err) {
    console.error(`join failed: ${err.message}`);
    process.exit(1);
  }
  process.exit(0);
}

// -resetban [ip]
const resetBanArg = argValue("-resetban", "--resetban");
if (resetBanArg !== null || args.includes("-resetban") || args.includes("--resetban")) {
  const bans = createBansService({});
  const ip = resetBanArg || null;
  bans.clear(ip || undefined);
  console.log(ip ? `ban cleared for ${ip}` : "all bans cleared");
  process.exit(0);
}

function markJoined(entry) {
  const { name } = entry;
  if (!entry.kind) entry.kind = "static";
  const list = loadGroupsJoined().filter((g) => g.name !== name);
  saveGroupsJoined([...list, entry]);
}

// -leavegroup | -leave-groups: leave every joined group as a member.
// Leaders cannot "leave" — they must disband with -delgroup <name>.
const leaveAll = args.includes("-leavegroup") || args.includes("--leavegroup") || args.includes("-leave-groups");
if (leaveAll) {
  const peers = createPeersService({});
  const joined = loadGroupsJoined();
  if (!joined.length) {
    console.log("not joined to any group");
    process.exit(0);
  }
  const myToken = (await loadToken()).token;
  const leaders = [];
  for (const g of joined) {
    if (g.leaderUrl) {
      // member: deregister from the leader so we stop showing up in -group list
      const peersRemoved = peers.removeByGroup(g.name);
      try {
        const res = await fetch(`${g.leaderUrl}/v1/groups/leave`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${myToken}`,
          },
          body: JSON.stringify({ name: g.name }),
        });
        if (res.ok) console.log(`${g.name}: left (deregistered from ${g.leaderUrl})`);
        else console.log(`${g.name}: left locally (leader said: ${await res.text().catch(() => `HTTP ${res.status}`)})`);
      } catch (err) {
        console.log(`${g.name}: left locally (leader unreachable: ${errMsg(err)})`);
      }
    } else {
      leaders.push(g.name);
    }
  }
  const left = joined.filter((g) => g.leaderUrl).map((g) => g.name);
  saveGroupsJoined(loadGroupsJoined().filter((g) => !left.includes(g.name)));
  console.log(`left ${left.length} group(s)`);
  if (leaders.length) {
    console.log(`\nskipped ${leaders.length} group(s) where this node is the leader:`);
    for (const n of leaders) console.log(`  ${n}  — leaders can't leave; disband it with: mslxdff -delgroup ${n}`);
  }
  process.exit(0);
}

// -delgroup <name>: a leader disbands one of its groups (local groups state +
// any member records). Fails if this node is not the leader of that group.
const delGroupName = argValue("-delgroup", "--delgroup");
if (delGroupName) {
  const groups = createGroupsService({});
  const peers = createPeersService({});
  const local = groups.list()[delGroupName];
  if (!local) {
    const joined0 = loadGroupsJoined().find((g) => g.name === delGroupName);
    if (joined0?.leaderUrl) {
      console.log(`"${delGroupName}" is led by ${joined0.leaderUrl} — you are a member, use -leavegroup to leave it`);
    } else if (joined0) {
      console.log(`"${delGroupName}" exists in local state but has no group definition — nothing to delete`);
    } else {
      console.log(`group "${delGroupName}" not found on this node`);
    }
    process.exit(1);
  }
  const disbanded = groups.delete(delGroupName);
  const members = Object.values(disbanded?.members || {});
  peers.removeByGroup(delGroupName);
  saveGroupsJoined(loadGroupsJoined().filter((g) => g.name !== delGroupName));
  console.log(`group "${delGroupName}" disbanded (${members.length} member${members.length === 1 ? "" : "s"} removed)`);
  process.exit(0);
}

function errMsg(err) { return String(err?.message || err); }

// Probe a member's health endpoint concurrently (v1/health preferred,
// falling back to /health). Returns { id, url, ms, rank } or { id, url, fail }.
// broadband relay:// members are not probed — they are reachable via leader relay.
async function probeHealth({ id, url, kind, lastSeen, publicIp } = {}) {
  if (!url) return { id, url, fail: "no url", rank: 3 };
  const isBb = kind === "broadband" || String(url).startsWith("relay://");
  if (isBb) {
    const staleMs = Number(process.env.MSLXDFF_BROADBAND_STALE_MS) > 0 ? Number(process.env.MSLXDFF_BROADBAND_STALE_MS) : 90_000;
    const stale = typeof lastSeen === "number" ? Date.now() - lastSeen > staleMs : true;
    return { id, url, kind: "broadband", lastSeen, publicIp, stale, rank: stale ? 2 : 0 };
  }
  const base = String(url).replace(/\/+$/, "");
  const startedAt = Date.now();
  try {
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    if (!res.ok) return { id, url: base, fail: `HTTP ${res.status}`, rank: 2 };
    return { id, url: base, ms: Date.now() - startedAt, rank: 0 };
  } catch (err) {
    return { id, url: base, fail: errMsg(err), rank: 2 };
  }
}

function readModelsCache(cacheFile) {
  try {
    return JSON.parse(readFileSync(cacheFile, "utf8"));
  } catch {
    return null;
  }
}

// Sync every joined group into the local peer list. Leaders read their local
// groups state; members re-register with the leader (idempotent) to get the
// freshest member list. Returns per-group results.
async function syncAllJoinedGroups({ peers, groups }) {
  const joined = loadGroupsJoined();
  const myToken = (await loadToken()).token;
  const results = [];
  for (const g of joined) {
    try {
      if (g.leaderUrl) {
        const members = await refreshGroupMembers(g.name, {
          leaderUrl: g.leaderUrl,
          memberName: g.memberName,
          url: g.myUrl,
          token: myToken,
          kind: g.kind,
        });
        results.push({
          name: g.name,
          ...syncPeersFromMembers({ peers, members, myUrl: g.myUrl, group: g.name }),
        });
      } else {
        // this node is the leader: […] own entry is always skipped
        const members = groups.list()[g.name]?.members ?? {};
        results.push({
          name: g.name,
          ...syncPeersFromMembers({ peers, members, myUrl: g.myUrl, group: g.name, skipIds: ["leader"] }),
        });
      }
    } catch (err) {
      results.push({ name: g.name, error: errMsg(err) });
    }
  }
  return results;
}

// Upgrade-aware handling of a running daemon: keep it when it already runs
// our version, otherwise stop it so the spawn below takes over. Cleans up
// stale pid files (daemon died without -stop).
function stopDaemonIfOutdated() {
  const pid = readPid();
  if (!pid) return;
  if (!isPidAlive(pid)) {
    console.log(`daemon pid ${pid} is stale (not running) — starting fresh`);
    return;
  }
  const runningVersion = readPidVersion();
  if (runningVersion === VERSION) return;
  console.log(
    runningVersion
      ? `daemon running v${runningVersion} — upgrading to v${VERSION}, restarting...`
      : `daemon version unknown — restarting with v${VERSION}...`
  );
  stopDaemon();
}

// -port N: persist the port, then restart the daemon on it if one is running.
// Skip when we ARE the daemon child (it already carries the port via args).
const portArg = argValue("-port", "--port");
if (portArg && !process.env.MSLXDFF_DAEMON) {
  const port = Number(portArg);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    console.error(`invalid port: ${portArg}`);
    process.exit(1);
  }
  setPort(port);
  const daemon = readPid();
  if (daemon) {
    stopDaemon();
    startDaemon(["-port", String(port)]);
    await waitForHealth(port, 4000);
    console.log(`mslxdff restarted on port ${port} (pid ${readPid()})`);
    console.log(`endpoint:   http://localhost:${port}/v1`);
  } else {
    console.log(`port saved: ${port} (daemon not running; takes effect on next start)`);
  }
  process.exit(0);
}

if (args.includes("-d") || args.includes("--daemon")) {
  if (!process.env.MSLXDFF_DAEMON) {
    // foreground: spawn the detached background instance, then wait for health
    const port = effectivePort();
    stopDaemonIfOutdated();
    const spawnedPid = startDaemon(args.filter((a) => a !== "-d" && a !== "--daemon"));
    await waitForHealth(port, 4000);
    console.log(`mslxdff daemon started (pid ${spawnedPid})`);
    console.log(`log: ${logFile()}`);
    console.log(`pid: ${pidFile()}`);
    process.exit(0);
  }
  // we ARE the daemon; stdout/stderr already point at the log file via startDaemon stdio
}

// Bare run: show status + help when the daemon is already up; otherwise spawn it
// as a background daemon and exit — never holds the terminal (npx-friendly).
if (!process.env.MSLXDFF_DAEMON) {
  const pid = readPid();
  if (pid && isPidAlive(pid) && readPidVersion() === VERSION) {
    await printStatus();
    printHelp();
    process.exit(0);
  }
  const port = effectivePort();
  stopDaemonIfOutdated();
  const spawnedPid = startDaemon([]);
  await waitForHealth(port, 4000);
  console.log(`mslxdff v${VERSION} started as a background daemon (pid ${spawnedPid})`);
  console.log(`endpoint:   http://localhost:${port}/v1`);
  console.log(`log:        ${logFile()}`);
  console.log(`pid:        ${pidFile()}`);
  console.log(`status:     run \`mslxdff\` again (or \`mslxdff -status\`)`);
  process.exit(0);
}

const { token, created } = await loadToken();
// 插件系统：加载（在 upstream 创建前，插件可整体替换上游实现）
// 双目录：<安装目录>/plugins/（官方插件，随包分发）+ ~/.config/mslxdff/plugins/（用户自定义，升级不丢）
const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const pluginDirs = resolvePluginDirs({ pkgRoot });
const { plugins: loadedPlugins, errors: pluginErrors } = await loadPlugins({ dirs: pluginDirs });
for (const e of pluginErrors) {
  console.log(`plugin load failed: ${e.file} — ${e.error}`);
  appendEvent({ ts: Date.now(), type: "plugin-load-error", file: e.file, error: e.error });
}
if (loadedPlugins.length) {
  console.log(`plugins loaded (${loadedPlugins.length}): ${loadedPlugins.map((p) => `${p.name}${p.version ? `@${p.version}` : ""}`).join(", ")}`);
  appendEvent({ ts: Date.now(), type: "plugins-loaded", plugins: loadedPlugins.map((p) => ({ name: p.name, version: p.version })) });
}
// 多供应商通道：默认 opencode + 可选 openrouter（MSLXDFF_OPENROUTER_KEY 启用）
// 插件 createUpstream 仍是"整体替换式"外部 provider（单通道，保留原语义）
const upstreamHooks = loadedPlugins.length
  ? (name, ctx) => runHook(loadedPlugins, name, ctx)
  : null;
const providerPlugin = loadedPlugins.find((p) => typeof p.createUpstream === "function");
let upstream;
const baseUrl = process.env.UPSTREAM_BASE_URL || "https://opencode.ai";
let providers = [];
if (providerPlugin) {
  // 插件整体替换：沿用旧单通道路径
  if (!upstream) {
    try {
      upstream = await providerPlugin.createUpstream({ baseUrl, authToken: process.env.UPSTREAM_AUTH_TOKEN || "public", env: process.env });
      console.log(`upstream provider replaced by plugin: ${providerPlugin.name}`);
      appendEvent({ ts: Date.now(), type: "plugin-upstream-active", plugin: providerPlugin.name });
    } catch (err) {
      console.log(`plugin upstream (${providerPlugin.name}) failed: ${errMsg(err)} — falling back to default`);
      appendEvent({ ts: Date.now(), type: "plugin-upstream-error", plugin: providerPlugin.name, error: errMsg(err) });
    }
  }
  if (!upstream) upstream = createUpstreamClient({ hooks: upstreamHooks });
} else {
  // 内置多 Provider：opencode 恒启用，openrouter 有 key 才启用
  const opencodeClient = createUpstreamClient({ hooks: upstreamHooks });
  const opencodeModels = createModelsService({
    baseUrl,
    headers: opencodeClient.headers,
    refreshMs: refreshIntervalMs(),
    cacheFile: join(logDir(), "models.json"),
  });
  providers.push(createOpenCodeProvider({ upstream: opencodeClient, modelsService: opencodeModels }));
  const orKeys = loadProviderKeys("openrouter");
  if (orKeys.length) {
    const { createOpenRouterProvider } = await import("../src/providers/openrouter.js");
    providers.push(createOpenRouterProvider({ apiKeys: orKeys }));
    console.log(`provider enabled: openrouter (${orKeys.length} key${orKeys.length > 1 ? "s" : ""})`);
    appendEvent({ ts: Date.now(), type: "provider-enabled", provider: "openrouter", keys: orKeys.length });
  }
  const { createProviderDispatcher } = await import("../src/providers/dispatcher.js");
  upstream = createProviderDispatcher(providers);
  appendEvent({ ts: Date.now(), type: "providers", providers: providers.map((p) => p.id) });
}
const opencodeProvider = providers.find((p) => p.id === "opencode");
const models = createModelsService({
  providers: providers.length > 1 ? providers : undefined,
  baseUrl,
  headers: upstream.headers || opencodeProvider?.upstream?.headers,
  refreshMs: refreshIntervalMs(),
  cacheFile: join(logDir(), "models.json"),
});
const auto = createAutoSelector({
  cooldownMs: modelCooldownMs(),
  slowCooldownMs: slowCooldownMs(),
  file: defaultStateFile(),
  loadCandidates: async () => {
    try {
      return (await models.get()).data.map((m) => m.id);
    } catch {
      return null;
    }
  },
});
const peers = createPeersService({ cooldownMs: peerCooldownMs(), heatMs: peerHeatMs() });
const groups = createGroupsService({});
const bans = createBansService({ windowMs: banWindowMs(), threshold: banThreshold() });

const isDebug = process.env.MSLXDFF_DEBUG === "1";
const bus = createEventBus();
const router = createRouter({ token, upstream, models, auto, logs, peers, maxHops: maxHopsValue(), groups, bans, bus, plugins: loadedPlugins });
const listenHost = effectiveHost();
const srv = startServer({
  router,
  signals: !isDebug,
  host: listenHost,
  onBeforeClose: loadedPlugins.length
    ? () => runHook(loadedPlugins, "server:stop", { version: VERSION }).then(() => {})
    : undefined,
});

// -debug: push every event straight to this terminal.
if (isDebug) {
  bus.subscribe((e) => {
    try {
      console.log(fmtEvent(e));
    } catch {
      // malformed event — skip
    }
  });
  // Ctrl+C / SIGTERM: restore the background daemon, then exit.
  const restore = () => {
    console.log("\n[debug] restoring background daemon...");
    try {
      const restoredPid = startDaemon([]);
      console.log(`[debug] daemon restored (pid ${restoredPid})`);
    } catch (err) {
      console.error(`[debug] could not restore daemon: ${err.message}`);
    }
    setTimeout(() => process.exit(0), 300);
  };
  process.on("SIGINT", restore);
  process.on("SIGTERM", restore);
}

await srv.ready();

// 插件 hook：server:start — 服务就绪后触发（只观察）
if (loadedPlugins.length) {
  runHook(loadedPlugins, "server:start", { port: srv.server.address()?.port, host: listenHost, version: VERSION }).catch(() => {});
  // 插件 onEvent(evt) — 订阅全部事件流（fire-and-forget，错误隔离）
  const eventPlugins = loadedPlugins.filter((p) => typeof p.onEvent === "function");
  if (eventPlugins.length) {
    bus.subscribe((e) => {
      for (const p of eventPlugins) {
        try { p.onEvent(e); } catch {}
      }
    });
  }
}

// 上游 Keep-Alive 预热：首条 TCP+TLS 暖好，100ms 后异步触发，不阻塞 ready
setTimeout(() => {
  upstream.preheat().then((r) => {
    const entry = { ts: Date.now(), type: "upstream-preheat", ...r, baseUrl };
    try { bus.emit(entry); } catch {}
    try { logs.appendEvent(entry); } catch {}
    if (r.skipped) console.log(`[preheat] skipped (MSLXDFF_PREHEAT disabled)`);
    else if (r.ok) console.log(`[preheat] opencode models ok ${r.status} ${r.ms}ms`);
    else console.log(`[preheat] opencode models failed ${r.error || r.status || ""} ${r.ms || 0}ms`);
  }).catch(() => {});
}, 100).unref?.();

models.startAutoRefresh();
if (process.env.MSLXDFF_DAEMON) {
  writePid(process.pid, VERSION);
}
const addr = srv.server.address();
const host = addr.address === "0.0.0.0" || addr.address === "::" ? "localhost" : addr.address;
console.log(`mslxdff v${VERSION} listening on http://${host}:${addr.port}`);
if (created) {
  console.log(`auth token: ${token}`);
}
console.log(`endpoint:   http://${host}:${addr.port}/v1`);
try {
  const { hedgeDelayMs } = await import("../src/routes/hedge.js");
  const hd = hedgeDelayMs();
  console.log(`hedge:      ${hd ? `${hd}ms` : "off"} (MSLXDFF_HEDGE_DELAY_MS)`);
} catch {}

// Periodically pull the freshest member lists for every joined group so a
// new member becomes a failover peer on all nodes without manual re-joining.
syncAllJoinedGroups({ peers, groups })
  .then((results) => {
    for (const r of results) {
      if (r.error) console.log(`group sync ${r.name}: failed — ${r.error}`);
      else console.log(`group sync ${r.name}: ${r.total} member(s), ${r.added} peer(s)`);
    }
  })
  .catch((err) => console.log(`group sync: ${errMsg(err)}`));
const groupSyncTimer = setInterval(() => {
  syncAllJoinedGroups({ peers, groups })
    .then((results) => {
      for (const r of results) {
        if (r.error) console.log(`group sync ${r.name}: failed — ${r.error}`);
        else if (r.added) console.log(`group sync ${r.name}: ${r.total} member(s), ${r.added} peer(s)`);
      }
    })
    .catch((err) => console.log(`group sync: ${errMsg(err)}`));
}, groupSyncIntervalMs());
groupSyncTimer.unref();

// Broadband heartbeat + relay poll (only for broadband members)
const broadbandGroups = () => loadGroupsJoined().filter((g) => g.kind === "broadband" && g.leaderUrl);
if (broadbandGroups().length) {
  const doHeartbeat = async () => {
    for (const g of broadbandGroups()) {
      try {
        const res = await fetch(`${g.leaderUrl}/v1/groups/relay/heartbeat`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
          body: JSON.stringify({ name: g.name, group: g.name }),
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) {
          const txt = await res.text().catch(() => "");
          console.log(`broadband heartbeat ${g.name}: ${res.status} ${txt.slice(0, 100)}`);
        }
      } catch (err) {
        console.log(`broadband heartbeat ${g.name}: failed — ${errMsg(err)}`);
      }
    }
  };
  const doPoll = async () => {
    for (const g of broadbandGroups()) {
      try {
        const pollRes = await fetch(`${g.leaderUrl}/v1/groups/relay/poll`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
          body: JSON.stringify({ name: g.name, group: g.name }),
          signal: AbortSignal.timeout(8000),
        });
        if (!pollRes.ok) continue;
        const data = await pollRes.json().catch(() => ({}));
        const items = data.data || [];
        for (const item of items) {
          const { reqId, body } = item;
          let result;
          try {
            const upRes = await upstream.chat(body);
            const ct = upRes.headers.get("content-type") || "";
            const isStream = Boolean(body?.stream) || ct.includes("text/event-stream");
            if (isStream && upRes.body) {
              // collect stream chunks for relay (simplified: buffer then forward as SSE)
              let collected = "";
              for await (const chunk of upRes.body) {
                collected += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
              }
              result = { status: upRes.status, headers: { "Content-Type": "text/event-stream" }, body: collected };
            } else {
              const txt = await upRes.text();
              let parsed;
              try { parsed = JSON.parse(txt); } catch { parsed = txt; }
              result = { status: upRes.status, headers: { "Content-Type": upRes.headers.get("content-type") || "application/json" }, body: typeof parsed === "string" ? parsed : JSON.stringify(parsed) };
            }
          } catch (err) {
            result = { status: 502, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: errMsg(err) }) };
          }
          try {
            await fetch(`${g.leaderUrl}/v1/groups/relay/result`, {
              method: "POST",
              headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
              body: JSON.stringify({ name: g.name, group: g.name, reqId, result }),
              signal: AbortSignal.timeout(5000),
            });
          } catch {}
        }
      } catch {}
    }
  };
  // initial heartbeat
  doHeartbeat().catch(() => {});
  const hbTimer = setInterval(doHeartbeat, 30_000);
  hbTimer.unref();
  const pollTimer = setInterval(doPoll, 1000);
  pollTimer.unref();
  console.log(`broadband relay: heartbeat 30s + poll 1s for ${broadbandGroups().length} group(s)`);
}

// Auto-update: periodically check npm for a newer mslxdff and restart.
// Default: hourly (no env needed). Disable with MSLXDFF_AUTO_UPDATE=0/off/false.
// Tuning: MSLXDFF_AUTO_UPDATE=1/true → hourly, or MSLXDFF_AUTO_UPDATE_MS=<ms>.
const autoUpdateMs = autoUpdateIntervalMs();
function emitAutoUpdate(type, data = {}) {
  const entry = { ts: Date.now(), type, ...data };
  try { bus?.emit(entry); } catch {}
  try { logs?.appendEvent?.(entry); } catch {}
  // also to daemon.log for tail
  const line = `[auto-update] ${type} ${JSON.stringify(data)}`;
  console.log(line);
}
if (autoUpdateMs) {
  console.log(`auto-update enabled: checking every ${Math.round(autoUpdateMs / 60000)}m`);
  emitAutoUpdate("auto-update-enabled", { intervalMs: autoUpdateMs, current: VERSION });
  // run once shortly after start (30s) so a newly deployed fix is picked up quickly,
  // then on the regular interval
  setTimeout(() => {
    emitAutoUpdate("auto-update-check", { current: VERSION });
    checkAndAutoUpdate().catch((err) => {
      console.log(`auto-update check failed: ${errMsg(err)}`);
      emitAutoUpdate("auto-update-failed", { error: errMsg(err) });
    });
  }, 30_000).unref?.();
  const autoUpdateTimer = setInterval(() => {
    emitAutoUpdate("auto-update-check", { current: VERSION });
    checkAndAutoUpdate().catch((err) => {
      console.log(`auto-update check failed: ${errMsg(err)}`);
      emitAutoUpdate("auto-update-failed", { error: errMsg(err) });
    });
  }, autoUpdateMs);
  autoUpdateTimer.unref();
} else {
  console.log(`auto-update disabled (set MSLXDFF_AUTO_UPDATE=1 to enable hourly)`);
  emitAutoUpdate("auto-update-disabled", { current: VERSION });
}

async function checkAndAutoUpdate() {
  emitAutoUpdate("auto-update-query", { current: VERSION });
  const info = await run(npmCmd(), ["view", "mslxdff", "dist-tags.latest", "--json"]);
  if (info.err) {
    emitAutoUpdate("auto-update-query-failed", { error: info.err.message || String(info.stderr || "").slice(0, 500) });
    throw new Error(info.err.message || String(info.stderr || "").slice(0, 500));
  }
  let latest = "";
  try {
    latest = JSON.parse(String(info.stdout || "").trim());
    if (Array.isArray(latest)) latest = latest[latest.length - 1];
    latest = String(latest || "").replace(/^v/, "").trim();
  } catch {
    const raw = String(info.stdout || "").trim();
    const m = raw.match(/(\d+\.\d+\.\d+[^\s'"]*)/);
    latest = m ? m[1] : raw.split(/\s+/).pop()?.replace(/['"]/g, "") || "";
  }
  latest = latest.replace(/['"]/g, "").trim();
  emitAutoUpdate("auto-update-queried", { current: VERSION, latest, stdout: String(info.stdout || "").trim().slice(0, 200) });
  if (!latest || latest === VERSION) {
    emitAutoUpdate("auto-update-noop", { current: VERSION, latest });
    return;
  }
  if (compareSemver(latest, VERSION) <= 0) {
    emitAutoUpdate("auto-update-noop", { current: VERSION, latest, reason: "not newer" });
    return;
  }
  emitAutoUpdate("auto-update-found", { current: VERSION, latest });
  console.log(`auto-update: v${VERSION} -> v${latest}, installing...`);
  emitAutoUpdate("auto-update-installing", { current: VERSION, latest });
  const up = await run(npmCmd(), ["install", "-g", `mslxdff@${latest}`]);
  if (up.err) {
    emitAutoUpdate("auto-update-install-failed", { current: VERSION, latest, error: up.err.message || String(up.stderr || "").slice(0, 500) });
    throw new Error(up.err.message || String(up.stderr || "").slice(0, 500));
  }
  emitAutoUpdate("auto-update-installed", { current: VERSION, latest, stdout: String(up.stdout || "").slice(0, 500) });
  console.log(`auto-update: installed v${latest}, restarting daemon...`);
  emitAutoUpdate("auto-update-restarting", { current: VERSION, latest });
  try { stopDaemon(); } catch (e) { emitAutoUpdate("auto-update-stop-failed", { error: errMsg(e) }); }
  const newPid = startDaemon([]);
  await waitForHealth(resolvePort(), 8000);
  console.log(`auto-update: restarted as v${latest} (pid ${newPid})`);
  emitAutoUpdate("auto-update-restarted", { current: VERSION, latest, newPid });
}

function compareSemver(a, b) {
  const pa = a.split(".").map((x) => parseInt(x, 10) || 0);
  const pb = b.split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const av = pa[i] || 0, bv = pb[i] || 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

function argValue(...names) {
  for (let i = 0; i < args.length; i++) {
    if (names.includes(args[i])) return args[i + 1];
  }
  return null;
}

function effectivePort() {
  const arg = argValue("-port", "--port");
  if (arg) return Number(arg);
  return resolvePort();
}

function effectiveHost() {
  const envHost = process.env.MSLXDFF_HOST || process.env.MSLXDFF_BIND_HOST;
  if (typeof envHost === "string" && envHost.trim()) return envHost.trim();
  try {
    const joined = loadGroupsJoined();
    if (joined.some((g) => g.kind === "broadband")) return "127.0.0.1";
  } catch {}
  return "0.0.0.0";
}

function refreshIntervalMs() {
  const n = Number(process.env.MODELS_REFRESH_MS);
  return Number.isInteger(n) && n > 0 ? n : 2 * 60 * 60 * 1000;
}

function modelCooldownMs() {
  const n = Number(process.env.MSLXDFF_MODEL_COOLDOWN_MS);
  return Number.isInteger(n) && n > 0 ? n : 60_000;
}

function slowCooldownMs() {
  const n = Number(process.env.MSLXDFF_SLOW_COOLDOWN_MS);
  return Number.isInteger(n) && n > 0 ? n : 5 * 60_000;
}

function peerCooldownMs() {
  const n = Number(process.env.MSLXDFF_PEER_COOLDOWN_MS);
  return Number.isInteger(n) && n > 0 ? n : 30_000;
}

function peerHeatMs() {
  const n = Number(process.env.MSLXDFF_PEER_HEAT_MS);
  return Number.isInteger(n) && n > 0 ? n : 5 * 60_000;
}

function maxHopsValue() {
  const n = Number(process.env.MSLXDFF_MAX_HOPS);
  return Number.isInteger(n) && n > 0 ? n : 3;
}

function groupSyncIntervalMs() {
  const n = Number(process.env.MSLXDFF_GROUP_SYNC_MS);
  return Number.isInteger(n) && n > 0 ? n : 60_000;
}

function autoUpdateIntervalMs() {
  const raw = process.env.MSLXDFF_AUTO_UPDATE_MS ?? process.env.MSLXDFF_AUTO_UPDATE;
  // default: hourly when env not set; explicit 0/off/false disables
  if (raw === undefined || raw === null || raw === "") return 60 * 60 * 1000;
  const s = String(raw).trim().toLowerCase();
  if (s === "0" || s === "off" || s === "false" || s === "no" || s === "disable" || s === "disabled") return 0;
  if (s === "1" || s === "true" || s === "on" || s === "yes" || s === "enable" || s === "enabled") return 60 * 60 * 1000;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : 60 * 60 * 1000;
}

function banWindowMs() {
  const n = Number(process.env.MSLXDFF_BAN_WINDOW_MS);
  return Number.isInteger(n) && n > 0 ? n : 48 * 60 * 60 * 1000;
}

function banThreshold() {
  const n = Number(process.env.MSLXDFF_BAN_THRESHOLD);
  return Number.isInteger(n) && n > 0 ? n : 5;
}

async function waitForHealth(port, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

function printHelp() {
  console.log(`mslxdff v${VERSION} — OpenCode Free OpenAI-compatible proxy

Usage:
  mslxdff                          start as a background daemon and exit (status + help if one is already running)
  mslxdff -d                       start as a background daemon
  mslxdff -status                  show current status (daemon, models, recent calls, last error)
  mslxdff -log [N]                 show last N events (default 10, e.g. -log 100)
  mslxdff -models                interactive picker: ↑/↓ select a model, Enter sets it as the default (non-TTY: plain list)
  mslxdff -model list            list the free models this proxy serves (cached)
  mslxdff -model set <id>        set the default (preferred) model without the interactive picker
  mslxdff -model status            show per-model health status (normal/limit/error)
  mslxdff -model refresh           force-refresh the model cache from the upstream
  mslxdff -debug                   live-follow the daemon event stream (requests, errors, peer forwards)
  mslxdff -stop                    stop the running daemon
  mslxdff -uninstall               stop the daemon and delete all state/log files
  mslxdff -port N                  persist the listen port (restarts the daemon on it if running)
  mslxdff -update                  update mslxdff to the latest published version
  mslxdff -showtoken               print the current auth token
  mslxdff -refresh-token           rotate the auth token (prints the new one)
  mslxdff -setto workbuddy [modelId]  set default model and sync to WorkBuddy models.json (insert or update 127.0.0.1/v1 entry)
  mslxdff -provider openrouter [key...|add|remove|list|clear]  configure provider API keys (multiple keys = rotating accounts; interactive hidden append on empty input)
  mslxdff -creategroup <name>      create a group on this node (the group name is the password)
  mslxdff -addtogroup <leader-host> <name> [--broadband]  join a group via its leader host (default port 8989) — broadband: 宽带动态IP成员（经Leader中继，无需公网入站，默认127.0.0.1）
  mslxdff -group sync              pull the freshest member list for all joined groups
  mslxdff -group leave <name>      leave a group (removes its members from this node)
  mslxdff -group list              list groups on this node (numbered members)
  mslxdff -group remove <seq>      leader only: kick a member by its list sequence number
  mslxdff -leavegroup              leave every joined group as a member (leaders: use -delgroup)
  mslxdff -delgroup <name>         disband a group this node leads (deletes it and its members)
  mslxdff -resetban [ip]           clear join-failure bans (all, or one ip)
  mslxdff -help                    show this help

Environment:
  MSLXDFF_PORT          listen port (default 8989; use mslxdff -port N to persist)
  MSLXDFF_STATE_FILE      token/port state file
  MSLXDFF_DAEMON_DIR      daemon pid/log/models dir
  UPSTREAM_BASE_URL       upstream base (default https://opencode.ai)
  UPSTREAM_AUTH_TOKEN     upstream bearer value (default "public")
  MSLXDFF_OPENROUTER_KEY  openrouter provider API keys(s) (single env value; multiple use "mslxdff -provider openrouter k1 k2 ..." to persist)
  UPSTREAM_CONNECT_TIMEOUT_MS  upstream connect timeout (default 30000)
  MODELS_REFRESH_MS       model-list background refresh interval (default 7200000)
  MSLXDFF_MODEL_COOLDOWN_MS  fallback cooldown after a model error (default 60000)
  MSLXDFF_PEER_COOLDOWN_MS   peer failover cooldown (default 30000)
  MSLXDFF_PEER_HEAT_MS       how long a peer success stays hot for fast reuse (default 300000)
  MSLXDFF_GROUP_SYNC_MS   group membership sync interval (default 60000)
  MSLXDFF_MAX_HOPS           max peer-forwarding depth (default 3)
  MSLXDFF_BAN_THRESHOLD   failed joins before an ip is banned (default 5)
  MSLXDFF_BAN_WINDOW_MS   ban duration after too many failures (default 48h)
  MSLXDFF_HEDGE_DELAY_MS  hedge peer race when local stream first chunk slow (default 1000, 0/off to disable)
  MSLXDFF_AUTO_UPDATE   auto-update: hourly by default, 0/off/false to disable, 1/true or ms
  MSLXDFF_AUTO_UPDATE_MS  same as above, explicit ms (overrides AUTO_UPDATE)
`);
}

async function printStatus() {
  const daemon = readPid();
  const port = getPort() || resolvePort();
  console.log(`mslxdff v${VERSION}`);
  console.log(`daemon:    ${daemon ? `running (pid ${daemon})` : "not running"}`);
  console.log(`endpoint:  http://localhost:${port}/v1`);
  console.log(`log dir:   ${logDir()}`);

  const groups = createGroupsService({});
  const joined = loadGroupsJoined();
  if (joined.length) {
    console.log(`\njoined groups (${joined.length}):`);
    const { token } = await loadToken();
    for (const g of joined) {
      const isLeader = !g.leaderUrl;
      console.log(`  ${g.name}  ${isLeader ? "(this node is the leader)" : `leader ${g.leaderUrl}`}`);
      let members = null;
      if (isLeader) {
        members = groups.list()[g.name]?.members ?? {};
      } else {
        // registered members can pull the member map back from the leader
        const fetchImpl = (url, opts) => fetch(url, { ...opts, signal: AbortSignal.timeout(1500) });
        try {
          members = await refreshGroupMembers(g.name, {
            leaderUrl: g.leaderUrl,
            memberName: g.memberName,
            url: g.myUrl,
            token,
            fetchImpl,
          });
        } catch {
          members = null;
        }
      }
      if (members === null) {
        console.log("    members: (unavailable — leader unreachable)");
      } else {
        const ids = Object.keys(members);
        if (!ids.length) {
          console.log("    members: (none yet)");
        } else {
          console.log(`    members (${ids.length}):`);
          for (const id of ids) {
            const m = members[id];
            const tags = [];
            if (id === "leader" && isLeader) tags.push("leader");
            if (m?.url && m.url === g.myUrl) tags.push("this node");
            if (m?.kind === "broadband") tags.push("broadband");
            if (m?.kind === "broadband" && m?.publicIp) tags.push(`ip=${m.publicIp}`);
            if (m?.kind === "broadband" && m?.lastSeen) {
              const ago = Math.round((Date.now() - m.lastSeen) / 1000);
              tags.push(ago < 90 ? `via leader ${ago}s ago` : "stale");
            }
            const tag = tags.length ? `  [${tags.join(", ")}]` : "";
            console.log(`      ${m?.url || id}${tag}`);
          }
        }
      }
    }
  } else {
    console.log("\njoined groups: (none — use -creategroup or -addtogroup)");
  }

  const peers = createPeersService({});
  const allPeers = peers.all();
  if (allPeers.length) {
    console.log(`\nfailover targets (${allPeers.length}):`);
    for (const p of allPeers) {
      const tags = [];
      if (peers.isCooling(p.url)) tags.push("cooling");
      if (peers.isHot(p.url)) tags.push("hot");
      const s = peers.stat(p.url);
      if (s?.latencyMs != null) tags.push(`${s.latencyMs}ms`);
      if (s?.fails) tags.push(`${s.fails} fail(s)`);
      const tag = tags.length ? `  [${tags.join(", ")}]` : "";
      console.log(`  ${p.name || p.url}  ${p.url}${tag}`);
    }
  }

  const groupNames = Object.keys(groups.list());
  if (groupNames.length) {
    console.log(`\ngroups on this node (${groupNames.length}):`);
    for (const n of groupNames) console.log(`  ${n}`);
  }

  const modelsFile = join(logDir(), "models.json");
  const statuses = loadModelErrors();
  if (existsSync(modelsFile)) {
    try {
      const cached = JSON.parse(readFileSync(modelsFile, "utf8"));
      const ids = (cached.data || []).map((m) => m.id).filter(Boolean);
      console.log(`\nmodels (${ids.length} free):`);
      for (const id of ids) {
        const st = fmtStatus(id, statuses);
        console.log(`  ${id}${st ? `  [${st}]` : ""}`);
      }
    } catch {
      console.log("\nmodels: cache unreadable");
    }
  } else {
    console.log("\nmodels: not cached yet (runs once the server has fetched the upstream list)");
  }

  console.log("\nrecent calls:");
  const calls = recentCalls(5);
  if (calls.length) {
    for (const c of calls) {
      console.log(`  ${fmtTs(c.ts)}  ${c.model || "-"}  ${c.status}  ${c.durationMs ?? "?"}ms${c.auto ? "  auto" : ""}`);
    }
  } else {
    console.log("  (none yet)");
  }

  console.log("\nlast error:");
  const err = lastError();
  if (err) {
    console.log(`  ${fmtTs(err.ts)}  ${err.model || "-"}  ${err.status}  ${err.message || ""}`);
  } else {
    console.log("  (none)");
  }

  if (daemon) console.log(`\nauth token: use \`mslxdff -showtoken\``);
  else console.log(`\nnot running — start with: mslxdff -d`);
}

function fmtStatus(id, statuses) {
  const e = statuses[id];
  if (typeof e === "number") return `error ${fmtTs(new Date(e).toISOString())}`;
  if (!e?.status || e.status === "normal") return "";
  const when = e.at ? ` ${fmtTs(new Date(e.at).toISOString())}` : "";
  const code = e.code ? ` HTTP ${e.code}` : "";
  return `${e.status}${when}${code}`;
}

function fmtDur(ms) {
  if (!Number.isFinite(ms)) return "?";
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function fmtEvent(e) {
  const t = e?.ts ? new Date(e.ts).toISOString().slice(11, 19) : "--:--:--";
  const head = `[${t}]`;
  const m = (x) => x || "-";
  const fallbackTag = e.fallback?.fallback ? ` fallback=${e.fallback.requested_model || e.requested}->${e.fallback.actual_model || e.actual}(${e.fallback.reason || e.reason})` : "";
  switch (e?.type) {
    case "request":
      return `${head} request       client-> ${m(e.requested || e.model)}${e.auto ? " (auto)" : ""} raw=${m(e.rawModel)} lock=${m(e.lockModel)} hops=${e.hops} from ${e.ip || "?"}${e.stream ? " stream" : ""}${e.prompt ? ` content="${e.prompt}"` : ""} reqId=${e.reqId || ""}`;
    case "client-request":
      return `${head} client req    客户端请求 model=${m(e.requested)} raw=${m(e.rawModel)} lock=${m(e.lockModel)} ip=${e.ip || "?"}${e.stream ? " stream" : ""}`;
    case "ordered":
      return `${head} ordered       尝试顺序 [${(e.order||[]).join(" -> ")}] canFallback=${e.canFallback} useAuto=${e.useAuto}`;
    case "model-try":
      return `${head} model-try     尝试本地 model=${m(e.model)} idx=${e.idx} reqId=${e.reqId || ""}`;
    case "upstream-try":
      return `${head} upstream try  上游请求 model=${m(e.model)} attempt=${e.attempt || 1}`;
    case "upstream-done":
      return `${head} upstream ok   ${m(e.model)} HTTP ${e.status}${e.timing ? ` total=${e.timing.totalMs}ms` : ""}`;
    case "upstream-error":
      return `${head} upstream err  ${m(e.model)} ${e.status ? `HTTP ${e.status}` : "network"}: ${m(e.message)}`;
    case "upstream-preheat":
      if (e.skipped) return `${head} preheat       跳过 (MSLXDFF_PREHEAT disabled)`;
      return `${head} preheat       预热 opencode models ${e.ok ? "ok" : "fail"} ${e.status ? `HTTP ${e.status}` : e.error || ""} ${e.ms ? `${e.ms}ms` : ""}`;
    case "peer-race-start":
      return `${head} peer race     开始并发给组员 model=${m(e.model)} peers=${e.peers}`;
    case "peer-health":
      return `${head} peer check    ${e.peer} -> ${e.count ? e.healthy.join(", ") : "no healthy models"}${e.strict ? " (strict)" : ""}`;
    case "peer-request":
      return `${head} peer req      并发发出 peer=${e.peer} model=${m(e.model)} hops=${e.hops}`;
    case "peer-forward":
      return `${head} peer resp     收到响应 peer=${e.peer} model=${m(e.model)} ${e.ok ? "ok" : "fail"} ${e.latencyMs ? `${e.latencyMs}ms` : ""} hops=${e.hops}${e.retry ? " (retry)" : ""}`;
    case "peer-error":
      return `${head} peer err      ${e.peer} ${e.status ? `HTTP ${e.status}` : "network"}: ${m(e.message)} model=${m(e.model)}`;
    case "peer-race-win":
      return `${head} peer win      选中 peer=${e.winPeer} model=${m(e.winTarget)} latency=${e.latencyMs}ms`;
    case "peer-race-lose":
      return `${head} peer lose     组员全部失败 model=${m(e.model)}`;
    case "fallback":
      return `${head} fallback      ${m(e.from)} -> ${m(e.to)} reason=${m(e.reason)}`;
    case "fallback-notice":
      return `${head} fallback!     客户端请求 ${m(e.requested)} 实际返回 ${m(e.actual)} 原因=${m(e.reason)} via=${m(e.via)} notice=${m(e.notice)}`;
    case "relay-try":
      return `${head} relay try     给宽带中继请求 target=${e.target} model=${m(e.model)} via=${e.via}`;
    case "relay-fail":
      return `${head} relay fail    ${e.target} ${e.status ? `HTTP ${e.status}` : ""} ${m(e.message)}`;
    case "relay-ip-change":
      return `${head} relay ip      ${e.member || e.id || "?"} ${e.oldIp || "?"} -> ${e.newIp || e.publicIp || "?"} via leader`;
    case "relay-forward":
      return `${head} relay fwd     ${e.target || e.peer || "?"} via leader model=${m(e.model)} hops=${e.hops || 0}`;
    case "relay-heartbeat":
      return `${head} relay hb      ${e.member || "?"} ip=${e.ip || "?"} lastSeen=${e.lastSeen ? new Date(e.lastSeen).toISOString().slice(11,19) : "?"}`;
    case "client-abort":
      return `${head} client abort  ${m(e.model)} total=${fmtDur(e.totalMs)}`;
    case "result":
      return `${head} result        返回客户端 status=${e.status} model=${m(e.model)} via=${e.via} 响应耗时 ${fmtDur(e.durationMs)}${fallbackTag}`;
    case "client-response":
      return `${head} client res    返回客户端 客户端请求 ${m(e.requested)} 实际返回 ${m(e.actual)} via=${m(e.via)}${e.fallback?.fallback ? ` fallback=${e.fallback.requested_model}->${e.fallback.actual_model}(${e.fallback.reason})` : " 无fallback"} status=${e.status}`;
    case "auto-update-enabled":
      return `${head} auto-update   enabled every ${Math.round((e.intervalMs||0)/60000)}m current=${e.current}`;
    case "auto-update-disabled":
      return `${head} auto-update   disabled current=${e.current}`;
    case "auto-update-check":
      return `${head} auto-update   checking current=${e.current}`;
    case "auto-update-query":
      return `${head} auto-update   querying npm current=${e.current}`;
    case "auto-update-queried":
      return `${head} auto-update   queried current=${e.current} latest=${e.latest} raw=${(e.stdout||"").slice(0,80)}`;
    case "auto-update-noop":
      return `${head} auto-update   noop current=${e.current} latest=${e.latest}${e.reason?` reason=${e.reason}`:""}`;
    case "auto-update-found":
      return `${head} auto-update   NEW v${e.current} -> v${e.latest} 发现新版本`;
    case "auto-update-installing":
      return `${head} auto-update   installing v${e.latest}...`;
    case "auto-update-installed":
      return `${head} auto-update   installed v${e.latest}`;
    case "auto-update-restarting":
      return `${head} auto-update   restarting daemon to v${e.latest}...`;
    case "auto-update-restarted":
      return `${head} auto-update   restarted pid=${e.newPid} v${e.current} -> v${e.latest} 升级完成`;
    case "auto-update-failed":
    case "auto-update-query-failed":
    case "auto-update-install-failed":
      return `${head} auto-update   failed ${e.type} error=${e.error||""}`;
    default:
      return `${head} ${e?.type || "?"} ${JSON.stringify(e || {})}`;
  }
}

function fmtTs(iso) {
  if (!iso) return "-";
  try {
    return new Date(iso).toISOString().replace("T", " ").slice(5, 19);
  } catch {
    return "-";
  }
}

function npmCmd() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function run(cmd, args, opts = {}) {
  const isWin = process.platform === "win32";
  return new Promise((resolve) => {
    // npm.cmd is a batch file on Windows — execFile needs shell:true to find it via PATHEXT
    const execOpts = isWin ? { shell: true, windowsHide: true } : {};
    execFile(cmd, args, { timeout: 120_000, ...execOpts, ...opts }, (err, stdout, stderr) => resolve({ err, stdout, stderr }));
  });
}

async function updateSelf() {
  console.log(`mslxdff v${VERSION} — checking for updates…`);
  const info = await run(npmCmd(), ["view", "mslxdff", "dist-tags.latest", "--json"]);
  if (info.err) {
    console.error(`could not query npm: ${info.err.message || String(info.stderr || "").slice(0, 500)}`);
    process.exit(1);
  }
  let latest = "";
  try {
    latest = JSON.parse(String(info.stdout || "").trim());
    if (Array.isArray(latest)) latest = latest[latest.length - 1];
    latest = String(latest || "").trim();
  } catch {
    const m = String(info.stdout || "").trim().match(/(\d+\.\d+\.\d+[^\s'"]*)/);
    latest = m ? m[1] : "";
  }
  latest = String(latest || "").replace(/['"]/g, "").trim();
  const version = VERSION;
  console.log(`  installed: ${version}`);
  console.log(`  latest:    ${latest || "unknown"}`);
  if (!latest || version === latest || compareSemver(latest, version) <= 0) {
    console.log("already up to date");
    process.exit(0);
  }
  console.log(`updating to ${latest}…`);
  const up = await run(npmCmd(), ["install", "-g", `mslxdff@${latest}`], { stdio: "inherit" });
  if (up.err) {
    console.error(`update failed: ${up.err.message}`);
    process.exit(1);
  }
  console.log(`updated to ${latest}`);
  const daemon = readPid();
  if (daemon) {
    console.log("restarting daemon on the new version…");
    stopDaemon();
    startDaemon([]);
    await waitForHealth(resolvePort(), 4000);
    console.log(`restarted (pid ${readPid()})`);
  }
}
