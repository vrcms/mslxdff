import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function tmpStateFile() {
  const dir = mkdtempSync(join(tmpdir(), "cline-dedup-"));
  return join(dir, "state.json");
}

// 同邮箱去重契约：keys 按邮箱替换不追加；auths uid=email 映射与 keys 双写；轮换同步 auths。
test("cline 同邮箱 login 替换不追加（keys/auths 双写）", async () => {
  const file = tmpStateFile();
  const { saveProviderConfig, loadProviderKeys, loadProviderAuths } = await import("../src/state.js");
  const baseUrl = "https://api.cline.bot";
  saveProviderConfig("cline", {
    baseUrl,
    keys: ["RT_A_11111111111111111111111"],
    auths: [{ uid: "mslxd@163.com", domain: "cline.bot", enterpriseId: "", refreshToken: "RT_A_11111111111111111111111" }],
  }, { file });
  // 模拟同邮箱新 token：替换位置 0，不追加
  const cur = loadProviderKeys("cline", { file });
  const auths = loadProviderAuths("cline", { file });
  const ai = auths.findIndex((a) => String(a.uid || "").toLowerCase() === "mslxd@163.com");
  assert.ok(ai >= 0);
  const oldRt = auths[ai].refreshToken;
  const nextKeys = [...cur];
  nextKeys[nextKeys.indexOf(oldRt)] = "RT_C_NEW_DUP_MSLXD_163____";
  const nextAuths = [...auths];
  nextAuths[ai] = { ...nextAuths[ai], refreshToken: "RT_C_NEW_DUP_MSLXD_163____" };
  saveProviderConfig("cline", { baseUrl, keys: nextKeys, auths: nextAuths }, { file });
  assert.equal(loadProviderKeys("cline", { file }).length, 1);
  assert.equal(loadProviderAuths("cline", { file })[0].refreshToken, "RT_C_NEW_DUP_MSLXD_163____");
});

test("cline 新邮箱才追加；轮换回写同步 auths", async () => {
  const file = tmpStateFile();
  const { saveProviderConfig, loadProviderKeys, loadProviderAuths } = await import("../src/state.js");
  const baseUrl = "https://api.cline.bot";
  saveProviderConfig("cline", {
    baseUrl,
    keys: ["RT_A", "RT_B"],
    auths: [
      { uid: "a@x.com", domain: "cline.bot", enterpriseId: "", refreshToken: "RT_A" },
      { uid: "b@x.com", domain: "cline.bot", enterpriseId: "", refreshToken: "RT_B" },
    ],
  }, { file });
  // 新邮箱追加
  const cur = loadProviderKeys("cline", { file });
  const nextKeys = [...new Set([...cur, "RT_C"])];
  const nextAuths = [...loadProviderAuths("cline", { file }), { uid: "c@x.com", domain: "cline.bot", enterpriseId: "", refreshToken: "RT_C" }];
  saveProviderConfig("cline", { baseUrl, keys: nextKeys, auths: nextAuths }, { file });
  assert.equal(loadProviderKeys("cline", { file }).length, 3);
  // 轮换：RT_B -> RT_B2，auths 同步
  const cur2 = loadProviderKeys("cline", { file });
  const idx = cur2.indexOf("RT_B");
  const n2 = [...cur2]; n2[idx] = "RT_B2";
  const a2 = loadProviderAuths("cline", { file }).map((a) => (a.refreshToken === "RT_B" ? { ...a, refreshToken: "RT_B2" } : a));
  saveProviderConfig("cline", { baseUrl, keys: n2, auths: a2 }, { file });
  assert.ok(loadProviderKeys("cline", { file }).includes("RT_B2"));
  assert.ok(loadProviderAuths("cline", { file }).some((a) => a.uid === "b@x.com" && a.refreshToken === "RT_B2"));
});
