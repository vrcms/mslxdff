import { json, errMsg } from "./helpers.js";

export async function modelsHandler({ res, models }) {
  if (!models) return json(res, 501, { error: "Models service not configured" });
  try {
    const data = await models.get();
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
