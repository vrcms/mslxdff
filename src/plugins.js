import { readdirSync, existsSync } from "node:fs";
import { join, basename, extname } from "node:path";
import { pathToFileURL } from "node:url";
import os from "node:os";

// mslxdff 插件系统：约定目录下的 *.mjs / *.js 模块，default export：
//   { name?, version?, description?, hooks?: { "<hook-name>": async (ctx) => nextValue? } }
// hook 返回数组时可替换流程值（如 model:select 的候选顺序）；返回 undefined 表示只观察。
// 插件错误一律隔离：加载失败进 errors，hook 抛错不影响主链路。

export function pluginsDir() {
  return process.env.MSLXDFF_PLUGINS_DIR ||
    join(os.homedir(), ".config", "mslxdff", "plugins");
}

// 安装目录下的 plugins/（随仓库/内置分发；auto-update 重装会丢，仅作开发/内置用）
export function bundledPluginsDir(pkgRoot) {
  if (!pkgRoot) return null;
  return join(pkgRoot, "plugins");
}

// 解析扫描目录列表：env 完全接管；否则安装目录 plugins/ + 用户目录（同名文件用户目录优先）
export function resolvePluginDirs({ pkgRoot } = {}) {
  const env = process.env.MSLXDFF_PLUGINS_DIR;
  if (env) return [env];
  const dirs = [];
  const bundled = bundledPluginsDir(pkgRoot);
  if (bundled) dirs.push(bundled);
  dirs.push(pluginsDir());
  return dirs;
}

const PLUGIN_EXTS = new Set([".mjs", ".js"]);

async function loadFromDir(dir, skipFiles) {
  const plugins = [];
  const errors = [];
  if (!dir || !existsSync(dir)) return { plugins, errors };
  let files = [];
  try {
    files = readdirSync(dir).filter((f) => PLUGIN_EXTS.has(extname(f).toLowerCase()));
  } catch (err) {
    errors.push({ file: dir, error: String(err?.message || err) });
    return { plugins, errors };
  }
  files.sort();
  for (const f of files) {
    const file = join(dir, f);
    if (skipFiles?.has(f)) continue; // 用户目录同名文件优先
    try {
      const mod = await import(pathToFileURL(file).href);
      const plugin = mod?.default;
      if (!plugin || typeof plugin !== "object") {
        errors.push({ file, error: "no default export object" });
        continue;
      }
      plugins.push({
        name: typeof plugin.name === "string" && plugin.name ? plugin.name : basename(f, extname(f)),
        version: typeof plugin.version === "string" ? plugin.version : "",
        description: typeof plugin.description === "string" ? plugin.description : "",
        hooks: plugin.hooks && typeof plugin.hooks === "object" ? plugin.hooks : {},
        file,
      });
    } catch (err) {
      errors.push({ file, error: String(err?.message || err) });
    }
  }
  return { plugins, errors };
}

export async function loadPlugins({ dir, dirs } = {}) {
  // 兼容旧签名 loadPlugins({ dir })；新签名 dirs 数组按优先级从低到高（后者覆盖前者同名文件）
  const list = dirs || (dir ? [dir] : [pluginsDir()]);
  let plugins = [];
  const errors = [];
  const seen = new Set(); // 已加载的 basename，先扫的目录跳过它们 → 后目录（高优先）覆盖
  for (let i = list.length - 1; i >= 0; i--) {
    const r = await loadFromDir(list[i], seen);
    for (const p of r.plugins) seen.add(basename(p.file));
    plugins = [...r.plugins, ...plugins]; // 低优先目录在前，目录内保持文件名序
    errors.push(...r.errors);
  }
  return { plugins, errors };
}

// 串行执行某 hook。返回 { value, changed, errors }：
// - value：最后一个返回非 undefined 值的插件的返回值（链式传递；数组、对象、布尔均可）
// - changed：是否有插件返回了非 undefined 值（调用方可据此采用 value）
export async function runHook(plugins, name, ctx) {
  let value;
  let changed = false;
  const errors = [];
  for (const p of plugins || []) {
    const fn = p.hooks?.[name];
    if (typeof fn !== "function") continue;
    try {
      const out = await fn(ctx);
      if (out !== undefined) {
        value = out;
        changed = true;
      }
    } catch (err) {
      errors.push({ plugin: p.name, error: String(err?.message || err) });
    }
  }
  return { value, changed, errors };
}
