// todaycn/models.js 单测：目录取自 pricing/status 的 modelOptions.options[]，含倍率解析与缓存。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createModelsService, buildTodaycnModelList, parseModelStatus, parseMultiplier } from "../src/providers/todaycn/models.js";
import { toGatewayModelId, toPlatformOptionId } from "../src/providers/todaycn/const.js";

const STATUS_FIXTURE = {
  success: true,
  code: "common.ok",
  message: "成功",
  data: {
    status: {
      modelOptions: {
        schemaVersion: 1,
        selectedOptionId: "model.deepseek-v4.1-flash",
        options: [
          { id: "model.deepseek-v4.1-flash", disabled: false, display: { title: "DeepSeek V4.1 Flash", subtitle: "消耗倍数：1×" } },
          { id: "model.glm-5.3", disabled: false, display: { title: "GLM 5.3", subtitle: "消耗倍数：4×" } },
        ],
      },
    },
  },
};

test("parseModelStatus 取 data.status.modelOptions.options", () => {
  const r = parseModelStatus(STATUS_FIXTURE);
  assert.equal(r.selectedOptionId, "model.deepseek-v4.1-flash");
  assert.deepEqual(r.options.map((o) => o.optionId), ["model.deepseek-v4.1-flash", "model.glm-5.3"]);
});

test("parseMultiplier 从中文倍率串取值", () => {
  assert.equal(parseMultiplier("消耗倍数：4×"), "4x");
  assert.equal(parseMultiplier("消耗倍数：1x"), "1x");
  assert.equal(parseMultiplier(""), "");
});

test("buildTodaycnModelList 剥 model. 前缀并带倍率价格", () => {
  const { options } = parseModelStatus(STATUS_FIXTURE);
  const list = buildTodaycnModelList({ id: "todaycn", options });
  assert.deepEqual(list.map((m) => m.id), ["todaycn/deepseek-v4.1-flash", "todaycn/glm-5.3"]);
  assert.equal(list[0].price, "1x");
  assert.equal(list[1].price, "4x");
  assert.equal(list[0].mark, "*");
});

test("toGatewayModelId / toPlatformOptionId 互逆且幂等", () => {
  assert.equal(toGatewayModelId("model.deepseek-v4.1-flash"), "deepseek-v4.1-flash");
  assert.equal(toGatewayModelId("mode.fast"), "mode.fast");
  assert.equal(toPlatformOptionId("deepseek-v4.1-flash"), "model.deepseek-v4.1-flash");
  assert.equal(toPlatformOptionId("model.glm-5.3"), "model.glm-5.3");
  assert.equal(toPlatformOptionId("mode.balanced"), "mode.balanced");
});

test("createModelsService 走注入的 loadOptions 并缓存", async () => {
  let calls = 0;
  const fn = () => { calls += 1; return parseModelStatus(STATUS_FIXTURE).options; };
  const svc = createModelsService({ id: "todaycn", loadOptions: fn });
  assert.equal((await svc.listModels()).length, 2);
  assert.equal((await svc.listModels()).length, 2);
  assert.equal(calls, 1, "第二次应命中缓存");
  svc.clearCache();
  await svc.listModels();
  assert.equal(calls, 2);
});

test("createModelsService：未登录空目录；loadOptions 抛错不炸", async () => {
  const noAccount = createModelsService({ id: "todaycn", hasAccount: () => false, loadOptions: async () => [] });
  assert.deepEqual(await noAccount.listModels(), []);
  const boom = createModelsService({ id: "todaycn", loadOptions: async () => { throw new Error("network"); } });
  assert.deepEqual(await boom.listModels(), []);
});