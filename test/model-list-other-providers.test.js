// -model list 的「其它供应商」段落：allowAny ON 且 allowlist 空时，必须把 live 模型展开列出。
// 回归（2026-10-20）：旧实现只打「未设 allowlist，全部模型放行」两行提示，导致 railway 这类
// 免凭证供应商在 -models / -model list 里"看不见"——用户以为没接上。
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 让 state 指向临时文件，再调用渲染，捕获 stdout
async function renderWith({ providerConfigs, picks = [], ids }) {
  const dir = mkdtempSync(join(tmpdir(), "listprov-"));
  const file = join(dir, "state.json");
  writeFileSync(file, JSON.stringify({
    providerConfigs,
    modelPicks: picks,
  }));
  const saved = process.env.MSLXDFF_STATE_FILE;
  process.env.MSLXDFF_STATE_FILE = file;

  const out = [];
  const orig = console.log;
  console.log = (...a) => out.push(a.join(" "));
  try {
    const { renderOtherProviders } = await import("../src/cli/commands/model/list-providers.js");
    await renderOtherProviders({ pickedIds: picks, ids, fullAliases: {} });
  } finally {
    console.log = orig;
    process.env.MSLXDFF_STATE_FILE = saved;
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
  return out.join("\n");
}

describe("-model list：allowAny ON 的供应商要展开模型", () => {
  test("allowAny ON + 空 allowlist → 列出 live 模型（而不是只打两行提示）", async () => {
    const text = await renderWith({
      providerConfigs: {
        railway: { baseUrl: "https://x.railway.app/ai-api", keys: [], allowAnyModels: true },
      },
      ids: [
        "railway/deepseek-v4.1-flash-free",
        "railway/glm-5.3-flash-free",
        "railway/big-pickle",
      ],
    });
    assert.match(text, /── railway/, "应有 railway 段");
    assert.match(text, /railway\/deepseek-v4\.1-flash-free/, "必须列出模型本体");
    assert.match(text, /railway\/glm-5\.3-flash-free/);
    assert.match(text, /railway\/big-pickle/);
    assert.doesNotMatch(text, /未设 allowlist，全部模型放行/, "有 live 模型时不该只给提示");
  });

  test("allowAny ON 但当前没有 live 模型 → 回退到提示（不虚构）", async () => {
    const text = await renderWith({
      providerConfigs: {
        railway: { baseUrl: "https://x.railway.app/ai-api", keys: [], allowAnyModels: true },
      },
      ids: ["opencode/something-else"],
    });
    assert.match(text, /未设 allowlist，全部模型放行/, "没有 live 模型时应给提示");
  });

  test("勾选过的模型带 * 标记", async () => {
    const picked = "railway/deepseek-v4.1-flash-free";
    const text = await renderWith({
      providerConfigs: {
        railway: { baseUrl: "https://x.railway.app/ai-api", keys: [], allowAnyModels: true },
      },
      picks: [picked],
      ids: [picked, "railway/glm-5.3-flash-free"],
    });
    const line = text.split("\n").find((l) => l.includes(picked));
    assert.ok(line, "应找到被勾选模型那一行");
    assert.match(line, /^\s*\*/, "勾选行应以 * 开头");
  });

  test("allowlist 非空时按 allowlist 列出（原有行为不变）", async () => {
    const text = await renderWith({
      providerConfigs: {
        sensenova: { baseUrl: "https://token.sensenova.cn/v1", keys: ["k"], allowedModels: ["glm-5.2"] },
      },
      ids: ["sensenova/glm-5.2", "sensenova/other"],
    });
    assert.match(text, /sensenova\/glm-5\.2/);
    assert.doesNotMatch(text, /sensenova\/other/, "不在 allowlist 里的不该列出");
  });
});
