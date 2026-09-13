import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeModelCaps, normalizeProviderModels, normalizeWorkbuddyCaps } from "../src/model-capabilities/parse.js";
import { createCapabilitiesService, globalCapabilities, _resetGlobalCapabilities, workbuddyCapsFromModels } from "../src/model-capabilities/index.js";
import { enrichOpencodeEntry, capsSummary } from "../src/model-capabilities/enrich.js";

// fixtures：形态取自 .scratch/opencode-model-capabilities/evidence/models-dev-api.json 实测切片
const EFFORT_IMAGE_MODEL = {
  id: "claude-sonnet-4-6",
  reasoning: true,
  reasoning_options: [
    { type: "effort", values: ["low", "medium", "high", "max"] },
    { type: "budget_tokens", min: 1024 },
  ],
  tool_call: true,
  modalities: { input: ["text", "image"], output: ["text"] },
  limit: { context: 200000, output: 64000 },
  cost: { input: 3, output: 15 },
};
const TOGGLE_MODEL = {
  id: "glm-4.7",
  reasoning: true,
  reasoning_options: [{ type: "toggle" }],
  tool_call: true,
  modalities: { input: ["text"], output: ["text"] },
};
const PLAIN_MODEL = {
  id: "some-plain",
  reasoning: false,
  tool_call: false,
  modalities: { input: ["text"], output: ["text"] },
};
const SPARSE_MODEL = { id: "sparse" };

describe("S1 parse 纯函数：models.dev 模型对象 → mslxdff 能力形状", () => {
  it("effort 型：档位数组/图片输入/上下文与价格", () => {
    const c = normalizeModelCaps("claude-sonnet-4-6", EFFORT_IMAGE_MODEL);
    assert.equal(c.reasoning, true);
    assert.equal(c.effortType, "effort");
    assert.deepEqual(c.effortValues, ["low", "medium", "high", "max"]);
    assert.equal(c.imageInput, true);
    assert.equal(c.toolCall, true);
    assert.equal(c.context, 200000);
    assert.equal(c.maxOutput, 64000);
    assert.equal(c.costIn, 3);
    assert.equal(c.costOut, 15);
  });

  it("toggle 型：effortType=toggle 且无档位数组", () => {
    const c = normalizeModelCaps("glm-4.7", TOGGLE_MODEL);
    assert.equal(c.effortType, "toggle");
    assert.equal(c.effortValues, null);
    assert.equal(c.imageInput, false);
  });

  it("budget_tokens 型：effortType=budget_tokens", () => {
    const c = normalizeModelCaps("x", { reasoning: true, reasoning_options: [{ type: "budget_tokens", min: 1024 }] });
    assert.equal(c.effortType, "budget_tokens");
    assert.equal(c.effortValues, null);
  });

  it("纯文本无档位：全缺省值", () => {
    const c = normalizeModelCaps("some-plain", PLAIN_MODEL);
    assert.equal(c.reasoning, false);
    assert.equal(c.effortType, null);
    assert.equal(c.effortValues, null);
    assert.equal(c.imageInput, false);
    assert.equal(c.context, null);
    assert.equal(c.costIn, null);
  });

  it("极端缺字段对象不抛错", () => {
    const c = normalizeModelCaps("sparse", SPARSE_MODEL);
    assert.equal(c.reasoning, false);
    assert.equal(c.imageInput, false);
    assert.equal(c.toolCall, false);
  });

  it("normalizeProviderModels 批量：键为模型 id", () => {
    const map = normalizeProviderModels({ a: EFFORT_IMAGE_MODEL, b: TOGGLE_MODEL });
    assert.equal(map.a.effortType, "effort");
    assert.equal(map.b.effortType, "toggle");
  });
});

describe("S1b enrich：-setto opencode 条目能力注入", () => {
  const RAW_WITH_DATES = {
    ...EFFORT_IMAGE_MODEL,
    release_date: "2026-01-15",
    last_updated: "2026-08-01",
    attachment: true,
    temperature: true,
  };
  const svc = {
    ready: async () => {},
    get: (pid, mid) => (pid === "opencode" && mid === "claude-sonnet-4-6")
      ? normalizeModelCaps("claude-sonnet-4-6", RAW_WITH_DATES)
      : null,
  };

  it("命中能力：条目补齐 opencode Model 形状字段 + 返回摘要", async () => {
    const { entry, caps } = await enrichOpencodeEntry({ name: "claude-sonnet-4-6" }, "claude-sonnet-4-6", svc);
    assert.equal(entry.name, "claude-sonnet-4-6");
    assert.equal(entry.reasoning, true);
    assert.equal(entry.tool_call, true);
    assert.equal(entry.attachment, true);
    assert.equal(entry.temperature, true);
    assert.equal(entry.release_date, "2026-01-15");
    assert.deepEqual(entry.limit, { context: 200000, output: 64000 });
    assert.deepEqual(entry.modalities, { input: ["text", "image"], output: ["text"] });
    assert.deepEqual(entry.cost, { input: 3, output: 15 });
    assert.ok(caps);
    assert.equal(caps.imageInput, true);
  });

  it("未收录模型：条目原样返回，caps=null", async () => {
    const entry0 = { name: "workbuddy-glm-5.3-flash" };
    const emptyWb = async () => ({ object: "list", data: [] });
    const { entry, caps } = await enrichOpencodeEntry(entry0, "workbuddy/glm-5.3-flash", svc, emptyWb);
    assert.deepEqual(entry, entry0);
    assert.equal(caps, null);
  });

  it("workbuddy 模型：models.dev miss 后走上游原生字段兜底", async () => {
    const emptySvc = { ready: async () => {}, get: () => null };
    const wbSource = async () => ({
      object: "list",
      data: [{ id: "workbuddy/hy3", maxInputTokens: 192000, maxOutputTokens: 64000, supportsImages: true, supportsReasoning: true, reasoning: { effort: "high" }, supportsToolCall: true }],
    });
    const { entry, caps } = await enrichOpencodeEntry({ name: "workbuddy-hy3" }, "workbuddy/hy3", emptySvc, wbSource);
    assert.equal(entry.reasoning, true);
    assert.equal(entry.tool_call, true);
    assert.deepEqual(entry.limit, { context: 192000, output: 64000 });
    assert.deepEqual(entry.modalities, { input: ["text", "image"], output: ["text"] });
    assert.equal(caps.defaultEffort, "high");
    assert.equal(caps.costIn, null); // credits 倍率不硬映射价格
  });

  it("workbuddy 兜底失败（源抛错）：静默降级原样条目", async () => {
    const emptySvc = { ready: async () => {}, get: () => null };
    const badSource = async () => { throw new Error("wb down"); };
    const entry0 = { name: "workbuddy-hy3" };
    const { entry, caps } = await enrichOpencodeEntry(entry0, "workbuddy/hy3", emptySvc, badSource);
    assert.deepEqual(entry, entry0);
    assert.equal(caps, null);
  });

  it("provider 前缀路由：bai/glm → provider=bai 查询", async () => {
    const svc2 = { ready: async () => {}, get: (pid, mid) => ({ called: `${pid}/${mid}` }) };
    const { caps } = await enrichOpencodeEntry({ name: "x" }, "bai/glm-5.3-flash", svc2);
    assert.equal(caps.called, "bai/glm-5.3-flash");
  });

  it("capsSummary 人话摘要：档位/读图/上下文", () => {
    const s1 = capsSummary({ reasoning: true, effortType: "effort", effortValues: ["low", "medium", "high", "max"], imageInput: true, context: 200000 });
    assert.match(s1, /low\/medium\/high\/max/);
    assert.match(s1, /读图/);
    assert.match(s1, /200k/);
    const s2 = capsSummary(null);
    assert.equal(s2, "");
    const s3 = capsSummary({ reasoning: false, effortType: null, effortValues: null, imageInput: false, context: null });
    assert.equal(s3, "");
  });
});

describe("S2 capabilities 服务：取数 + 磁盘缓存 + TTL + 降级", () => {
  function fakeFetch(payload, counter) {
    return async () => { counter.calls += 1; return { ok: true, status: 200, json: async () => payload }; };
  }
  const payload = {
    opencode: { models: { "big-pickle": PLAIN_MODEL, "claude-sonnet-4-6": EFFORT_IMAGE_MODEL } },
    otherprov: { models: { "m1": TOGGLE_MODEL } },
  };

  it("首拉写盘，TTL 内不重拉，过期重拉", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caps-"));
    const file = join(dir, "models-dev.json");
    const counter = { calls: 0 };
    let t = 1000;
    const svc = createCapabilitiesService({ fetchImpl: fakeFetch(payload, counter), cacheFile: file, ttlMs: 5000, now: () => t });
    await svc.ready();
    assert.equal(counter.calls, 1);
    assert.ok(existsSync(file), "缓存文件应落盘");
    const cached = JSON.parse(readFileSync(file, "utf8"));
    assert.ok(cached.opencode.models["big-pickle"], "缓存内容为原始目录");
    assert.equal(svc.get("opencode", "big-pickle").toolCall, false);

    t += 4000; // TTL 内
    await svc.ready();
    assert.equal(counter.calls, 1, "TTL 内不应重拉");
    assert.equal(svc.get("otherprov", "m1").effortType, "toggle");

    t += 6000; // 过期
    await svc.ready();
    assert.equal(counter.calls, 2, "过期后应重拉");
  });

  it("fetch 失败回退旧缓存（staleness 优先）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caps-"));
    const file = join(dir, "models-dev.json");
    let t = 1000;
    const good = createCapabilitiesService({ fetchImpl: fakeFetch(payload, { calls: 0 }), cacheFile: file, ttlMs: 1000, now: () => t });
    await good.ready();
    const caps = good.get("opencode", "big-pickle");
    assert.ok(caps);

    const bad = createCapabilitiesService({
      fetchImpl: async () => { throw new Error("network down"); },
      cacheFile: file, ttlMs: 1000, now: () => t + 5000,
    });
    await bad.ready(); // 不应抛
    assert.deepEqual(bad.get("opencode", "big-pickle"), caps);
  });

  it("fetch 失败且无缓存 → ready 报错、get 返回 null", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caps-"));
    const file = join(dir, "absent.json");
    const svc = createCapabilitiesService({
      fetchImpl: async () => { throw new Error("network down"); },
      cacheFile: file, ttlMs: 1000, now: () => 0,
    });
    await assert.rejects(() => svc.ready());
    assert.equal(svc.get("opencode", "big-pickle"), null);
    assert.deepEqual(svc.list("opencode"), []);
  });

  it("get/list/providers 查询语义", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caps-"));
    const svc = createCapabilitiesService({ fetchImpl: fakeFetch(payload, { calls: 0 }), cacheFile: join(dir, "c.json"), ttlMs: 60000, now: () => 0 });
    await svc.ready();
    assert.equal(svc.get("opencode", "nope"), null);
    assert.equal(svc.get("ghostprov", "x"), null);
    const list = svc.list("opencode");
    assert.equal(list.length, 2);
    assert.ok(list.every((e) => e.id && e.capabilities));
    assert.deepEqual(svc.providers().sort(), ["opencode", "otherprov"]);
  });
});

// workbuddy 上游原生字段 fixture（实测 /console/enterprises/personal/models 2026-09-11）
const WB_FULL = {
  maxInputTokens: 168000,
  maxOutputTokens: 32000,
  supportsImages: true,
  supportsReasoning: true,
  reasoning: { effort: "high", summary: "auto" },
  supportsToolCall: true,
  disabledMultimodal: false,
  temperature: 1,
  credits: "x1.5",
};
const WB_TEXT_ONLY = {
  id: "workbuddy/hunyuan-chat",
  maxInputTokens: 64000,
  maxOutputTokens: 8000,
  supportsImages: true,
  disabledMultimodal: true,
  supportsReasoning: false,
  supportsToolCall: true,
};

describe("S1c workbuddy 原生字段 → 统一 caps 形状", () => {
  it("全字段模型：上下文/读图/推理档位/工具调用", () => {
    const c = normalizeWorkbuddyCaps("auto", WB_FULL);
    assert.equal(c.context, 168000);
    assert.equal(c.maxOutput, 32000);
    assert.equal(c.imageInput, true);
    assert.deepEqual(c.inputModalities, ["text", "image"]);
    assert.equal(c.reasoning, true);
    assert.equal(c.effortType, "effort");
    assert.deepEqual(c.effortValues, ["low", "medium", "high"]); // 网关层通用三档（上游只给默认档）
    assert.equal(c.defaultEffort, "high");
    assert.equal(c.toolCall, true);
    assert.equal(c.temperature, true);
    assert.equal(c.costIn, null); // credits 是倍率不是 $/M，不硬映射
  });

  it("disabledMultimodal 压过 supportsImages", () => {
    const c = normalizeWorkbuddyCaps("x", { ...WB_FULL, disabledMultimodal: true });
    assert.equal(c.imageInput, false);
    assert.deepEqual(c.inputModalities, ["text"]);
  });

  it("纯文本模型：全缺省", () => {
    const c = normalizeWorkbuddyCaps("y", { id: "y", supportsImages: false, supportsReasoning: false, supportsToolCall: false });
    assert.equal(c.imageInput, false);
    assert.equal(c.reasoning, false);
    assert.equal(c.effortType, null);
    assert.equal(c.effortValues, null);
    assert.equal(c.defaultEffort, null);
    assert.equal(c.context, null);
    assert.equal(c.toolCall, false);
  });

  it("极端缺字段对象不抛错", () => {
    const c = normalizeWorkbuddyCaps("z", {});
    assert.equal(c.imageInput, false);
    assert.equal(c.context, null);
  });
});

describe("S1d workbuddy 动态源：聚合模型条目 → caps map", () => {
  it("拉 workbuddy/ 前缀条目、剥前缀作 map 键、忽略其他供应商", async () => {
    const agg = {
      object: "list",
      data: [
        { id: "workbuddy/glm-5.3-flash", ...WB_FULL },
        { id: "workbuddy/hunyuan-chat", ...WB_TEXT_ONLY },
        { id: "big-pickle", reasoning: false },
        { id: "workbuddy/", }, // 空裸 id 应跳过
      ],
    };
    const map = await workbuddyCapsFromModels(async () => agg)();
    assert.ok(map["glm-5.3-flash"]);
    assert.equal(map["glm-5.3-flash"].context, 168000);
    assert.equal(map["hunyuan-chat"].imageInput, false); // disabledMultimodal 压过 supportsImages
    assert.equal(map["hunyuan-chat"].toolCall, true);
    assert.equal(map["big-pickle"], undefined);
    assert.equal(Object.keys(map).length, 2);
  });
});

describe("S3 HTTP handler", () => {
  function fakeRes() {
    const h = {};
    return {
      statusCode: 0, _h: h, _body: null,
      setHeader(k, v) { h[k.toLowerCase()] = v; },
    };
  }
  function jsonRes(res, code, obj) { res.statusCode = code; res._body = obj; }

  const svcData = {
    ready: async () => {},
    providers: () => ["opencode"],
    list: (pid) => pid === "opencode" ? [
      { id: "big-pickle", capabilities: { reasoning: false, effortType: null, effortValues: null, imageInput: false, toolCall: false, context: null, maxOutput: null, costIn: null, costOut: null } },
    ] : [],
    get: (pid, id) => pid === "opencode" && id === "big-pickle" ? { reasoning: false, effortType: null, effortValues: null, imageInput: false, toolCall: false, context: null, maxOutput: null, costIn: null, costOut: null } : null,
  };

  it("默认列出 opencode 能力列表", async () => {
    const { capabilitiesHandler } = await import("../src/routes/models-route.js");
    const res = fakeRes();
    await capabilitiesHandler({ req: { url: "/v1/models/capabilities", headers: {} }, res, capabilities: svcData, jsonFn: jsonRes });
    assert.equal(res.statusCode, 200);
    assert.equal(res._body.object, "list");
    assert.equal(res._body.data[0].id, "big-pickle");
    assert.ok("capabilities" in res._body.data[0]);
  });

  it("id 单查命中返回单条，未收录 404", async () => {
    const { capabilitiesHandler } = await import("../src/routes/models-route.js");
    const res1 = fakeRes();
    await capabilitiesHandler({ req: { url: "/v1/models/capabilities?id=big-pickle", headers: {} }, res: res1, capabilities: svcData, jsonFn: jsonRes });
    assert.equal(res1.statusCode, 200);
    assert.equal(res1._body.id, "big-pickle");
    assert.equal(res1._body.object, "model.capabilities");

    const res2 = fakeRes();
    await capabilitiesHandler({ req: { url: "/v1/models/capabilities?provider=otherprov&id=glm-5.3-flash", headers: {} }, res: res2, capabilities: svcData, jsonFn: jsonRes });
    assert.equal(res2.statusCode, 404);
    assert.match(res2._body.error, /not found/i);
  });

  it("服务不可用 502（空状态不留白）", async () => {
    const { capabilitiesHandler } = await import("../src/routes/models-route.js");
    const res = fakeRes();
    await capabilitiesHandler({ req: { url: "/v1/models/capabilities", headers: {} }, res, capabilities: null, jsonFn: jsonRes });
    assert.equal(res.statusCode, 502);
    assert.ok(res._body.error);
  });

  it("provider=workbuddy：动态源列表 + 单查 + 未收录 404", async () => {
    const { capabilitiesHandler } = await import("../src/routes/models-route.js");
    const wbSource = async () => ({
      object: "list",
      data: [
        { id: "workbuddy/glm-5.3-flash", maxInputTokens: 168000, maxOutputTokens: 32000, supportsImages: true, supportsReasoning: true, reasoning: { effort: "high" }, supportsToolCall: true },
        { id: "workbuddy/hunyuan-chat", maxInputTokens: 64000, supportsToolCall: true },
      ],
    });
    const resList = fakeRes();
    await capabilitiesHandler({ req: { url: "/v1/models/capabilities?provider=workbuddy", headers: {} }, res: resList, jsonFn: jsonRes, wbSource });
    assert.equal(resList.statusCode, 200);
    assert.equal(resList._body.provider, "workbuddy");
    assert.equal(resList._body.data.length, 2);
    assert.equal(resList._body.data[0].id, "glm-5.3-flash");
    assert.equal(resList._body.data[0].capabilities.context, 168000);

    const resOne = fakeRes();
    await capabilitiesHandler({ req: { url: "/v1/models/capabilities?provider=workbuddy&id=glm-5.3-flash", headers: {} }, res: resOne, jsonFn: jsonRes, wbSource });
    assert.equal(resOne.statusCode, 200);
    assert.equal(resOne._body.object, "model.capabilities");
    assert.equal(resOne._body.id, "glm-5.3-flash");
    assert.equal(resOne._body.capabilities.defaultEffort, "high");

    const resMiss = fakeRes();
    await capabilitiesHandler({ req: { url: "/v1/models/capabilities?provider=workbuddy&id=nope", headers: {} }, res: resMiss, jsonFn: jsonRes, wbSource });
    assert.equal(resMiss.statusCode, 404);
    assert.match(resMiss._body.error, /not found/i);
  });

  it("provider=workbuddy 源抛错 → 502", async () => {
    const { capabilitiesHandler } = await import("../src/routes/models-route.js");
    const res = fakeRes();
    const badSource = async () => { throw new Error("upstream down"); };
    await capabilitiesHandler({ req: { url: "/v1/models/capabilities?provider=workbuddy", headers: {} }, res, jsonFn: jsonRes, wbSource: badSource });
    assert.equal(res.statusCode, 502);
    assert.match(res._body.error, /unavailable/i);
  });

  it("globalCapabilities 单例与重置", async () => {
    _resetGlobalCapabilities();
    const a = globalCapabilities();
    const b = globalCapabilities();
    assert.equal(a, b);
    _resetGlobalCapabilities();
    const c = globalCapabilities();
    assert.notEqual(a, c);
  });
});
