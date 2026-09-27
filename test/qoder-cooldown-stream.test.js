// 流式路径的坏号冷却：上游 401/403/429/5xx 在对外契约里被整形成 "200 + 流内 error"，
// 于是 provider 门面（index.js 的 chat()）看不到真实状态码 → 坏号不冷却。
// 配合"同请求粘号"（ADR-0036）会放大成：重试一直粘在坏号上，整单失败且不换号。
// 修法：chat.js 用内部回显头 x-mslxdff-qoder-upstream-status 带出真实状态码，门面据此冷却。
// 不落凭据（只有状态码与 host/region）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createQoderProvider } from "../src/providers/qoder/index.js";

const blob = (t) => JSON.stringify({ device_token: t, refresh_token: "" });
const body = { model: "qoder/qfmodel", messages: [{ role: "user", content: "hi" }], stream: true };

function mk(fetchImpl) {
  const dir = mkdtempSync(join(tmpdir(), "mslxdff-qoder-cool-"));
  const p = createQoderProvider({
    id: "qoder",
    apiKeys: [blob("dt-a"), blob("dt-b")],
    file: join(dir, "state.json"), // 隔离 state：不读开发者真实账号
    fetchImpl,
  });
  return { p, dir };
}

test("流式上游 401：真实状态码带出且坏号被冷却（粘号不再粘它）", async () => {
  const { p, dir } = mk(async () => new Response("nope", { status: 401 }));
  try {
    const r1 = await p.chat(body, { reqId: "r1" });
    await r1.text().catch(() => {});
    assert.equal(r1.status, 200, "流式对外仍是 200（契约不变）");
    assert.equal(r1.headers.get("x-mslxdff-qoder-upstream-status"), "401", "真实状态码必须带出");
    assert.equal(r1.headers.get("x-mslxdff-qoder-cooldown"), "401", "冷却决定要钉在响应上（模型日志 cooled=401）");
    assert.equal(r1.headers.get("x-mslxdff-qoder-account"), "new", "首次选号 decision=new");
    assert.equal(p.keyRing.keys.filter((k) => p.keyRing.isCooling(k)).length, 1, "只有一个号被冷却");

    const r2 = await p.chat(body, { reqId: "r1" });
    await r2.text().catch(() => {});
    assert.equal(r2.headers.get("x-mslxdff-qoder-account"), "switch", "坏号冷却后同请求重试必须换号");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("流式上游 400：业务错不冷却（不误伤好号）", async () => {
  const { p, dir } = mk(async () => new Response("bad request", { status: 400 }));
  try {
    const r = await p.chat(body, { reqId: "r2" });
    await r.text().catch(() => {});
    assert.equal(r.headers.get("x-mslxdff-qoder-upstream-status"), "400");
    assert.equal(r.headers.get("x-mslxdff-qoder-cooldown"), null, "400 是业务错，不冷却");
    assert.equal(p.keyRing.keys.filter((k) => p.keyRing.isCooling(k)).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("非流式 401：仍按响应状态码冷却（老路径不回归）", async () => {
  const { p, dir } = mk(async () => new Response("nope", { status: 401 }));
  try {
    const r = await p.chat({ ...body, stream: false }, { reqId: "r3" });
    await r.text().catch(() => {});
    assert.equal(r.status, 401);
    assert.equal(r.headers.get("x-mslxdff-qoder-cooldown"), "401");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
