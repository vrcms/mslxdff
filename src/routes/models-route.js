import { json, errMsg } from "./helpers.js";
import { runHook } from "../plugins.js";

export async function modelsHandler({ res, models, plugins }) {
  if (!models) return json(res, 501, { error: "Models service not configured" });
  try {
    let data = await models.get();
    // 插件 hook：models:list — 返回数组可替换对外模型列表（{object:"list",data:[...]} 或纯 id 数组）
    if (plugins?.length) {
      const ml = await runHook(plugins, "models:list", { data });
      for (const e of ml.errors) console.log(`plugin models:list error (${e.plugin}): ${e.error}`);
      if (ml.changed && Array.isArray(ml.value)) {
        const idsOnly = ml.value.every((x) => typeof x === "string");
        const out = idsOnly
          ? { object: "list", data: ml.value.map((id) => ({ id, object: "model", owned_by: "plugin" })) }
          : { object: "list", data: ml.value };
        return json(res, 200, out);
      }
    }
    json(res, 200, data);
  } catch (err) {
    json(res, 502, { error: errMsg(err) });
  }
}

export async function modelsStatusHandler({ res, models, auto }) {
  const statuses = auto?.statuses?.() || {};
  let ids = [];
  try {
    ids = (await models?.get?.())?.data?.map((m) => m.id) || [];
  } catch {}
  const seen = new Set();
  const data = [];
  for (const id of [...ids, ...Object.keys(statuses)]) {
    if (seen.has(id)) continue;
    seen.add(id);
    const e = statuses[id];
    const entry = typeof e === "number"
      ? { id, status: "error", at: e }
      : { id, status: e?.status || "normal", at: e?.at ?? null, code: e?.code ?? null };
    data.push(entry);
  }
  json(res, 200, { object: "list", data });
}
