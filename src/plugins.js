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

const PLUGIN_EXTS = new Set([".mjs", ".js"]);

export async function loadPlugins({ dir = pluginsDir() } = {}) {
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
