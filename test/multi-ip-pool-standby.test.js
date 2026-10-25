// multi-ip-pool / standby 回归（用户 2026-10-25 裁决之三、之四）：
//   ③ 定时预拨**不多于 5** 条备选 IP，429 一到立即启用；④ 启用备用 IP 前要「打 hi 到 opencode.ai 拿 200」。
// 桩的行为对齐真实 dial.js：openSlot **内部就带 hi 闸门**（不 200 当场拆掉换下一个），
// standby 只负责"攒够 N 条已验通的"与"交付前再验一次"。IO 全注入，零真机零网络。
import test from "node:test";
import assert from "node:assert/strict";
import { createStandby, STANDBY_INDEX_BASE } from "../src/multi-ip-pool/standby.js";
import { resolveMultiIpConfig } from "../src/multi-ip-pool/config.js";

const cfgOf = (over = {}) => resolveMultiIpConfig({ MSLXDFF_MULTI_IP_STANDBY: "3", ...over }, { logDirFn: () => "C:/logs" });

/**
 * 假拨号器：第 n 次拨号出的出口尾址 = n，**奇数有额度（200）、偶数没额度（429）**，
 * 所以每次 openSlot 都会"拨—验—拆—再拨"直到撞上一个奇数（与真 dial.js 同形状）。
 * `deny` 里的设备名在**复验**时判 429（模拟"一小时里这个 IP 被别人吃光了"）。
 */
function fakeDialer({ deny = new Set() } = {}) {
  const dialed = [];
  const dropped = [];
  let n = 0;
  const hi = async (e) => {
    const last = Number(String(e.tunIp).split(".").pop());
    if (deny.has(e.dev) || last % 2 === 0) return { ok: false, status: 429, kind: "free-quota", ms: 2, ip: "" };
    return { ok: true, status: 200, kind: "none", ms: 2, ip: `198.51.100.${last}` };
  };
  return {
    dialed,
    dropped,
    tunnels: new Set(),
    used: new Set(),
    deny,
    async ensureCandidates() {
      return 9;
    },
    async openSlot(index) {
      for (let k = 0; k < 6; k++) {
        n += 1;
        const e = { dev: `mltun${index}`, index, tries: n, tunIp: `10.9.0.${n}`, table: 210 + index, priority: 20000 + index, node: { hostName: `v${n}` }, stop: () => {} };
        dialed.push(e);
        const p = await hi(e);
        if (p.status === 200) {
          e.exitIp = p.ip;
          this.tunnels.add(e);
          return e;
        }
        dropped.push(e); // 不 200：当场拆掉换下一个（绝不当备用）
      }
      return null;
    },
    hiProbe: hi,
    async drop(e) {
      dropped.push(e);
      this.tunnels.delete(e);
    },
  };
}

test("补位：只收 hi 回 200 的出口，没额度的那条当场被拆掉换下一个", async () => {
  const d = fakeDialer();
  const logs = [];
  const s = createStandby({ cfg: cfgOf(), log: (m) => logs.push(m), dialer: d, now: () => 1 });
  const r = await s.refill();
  assert.deepEqual({ have: r.have, want: r.want }, { have: 3, want: 3 }, "攒满 3 条待命");
  assert.equal(d.dropped.length, 2, "偶数尾址没额度 ⇒ 拨到第 5 次共拆 2 条");
  assert.equal(d.dialed.length, 5, "验通为止：奇偶交替 ⇒ 拨 5 收 3");
  assert.ok(d.dialed.every((e) => e.index >= STANDBY_INDEX_BASE), "备用槽必须用偏移索引：设备名/表号才不与正式槽撞");
  assert.ok(logs.some((l) => l.includes("备选池 +1") && l.includes("3/3 条待命")));
  assert.ok(logs.some((l) => l.includes("标准是 hi 回 200")), "补位结论要写清判据是 200，不是隧道起来了");
  await s.stop();
});

test("取用：交付前再验一次 hi——不 200 就丢掉取下一条（宁缺毋滥）", async () => {
  const d = fakeDialer();
  const logs = [];
  const s = createStandby({ cfg: cfgOf(), log: (m) => logs.push(m), dialer: d });
  await s.refill();
  const first = s.stats().exits[0];
  d.deny.add(first.dev); // 这一小时里它被别人吃光了
  const got = await s.take();
  assert.ok(got, "必须还能取到一条");
  assert.notEqual(got.dev, first.dev, "复验不过的那条绝不能交出去");
  assert.ok(logs.some((l) => l.includes("丢弃备用出口") && l.includes("宁缺毋滥")));
  assert.ok(logs.some((l) => l.includes("启用备用出口") && l.includes("剩余备用")), "429 后立即启用的那一行证据");
  assert.ok(got.exitIp.startsWith("198.51.100."), "取用行要带真实出口 IP");
  await s.stop();
});

test("上限：用户要「不多于 5」——配置层与池层都夹住；0 = 关", async () => {
  assert.equal(resolveMultiIpConfig({ MSLXDFF_MULTI_IP_STANDBY: "99" }, { logDirFn: () => "C:/logs" }).standby, 5);
  assert.equal(resolveMultiIpConfig({ MSLXDFF_MULTI_IP_STANDBY: "0" }, { logDirFn: () => "C:/logs" }).standby, 0, "0 是合法值（关），不许回落缺省");
  const s = createStandby({ cfg: resolveMultiIpConfig({ MSLXDFF_MULTI_IP_STANDBY: "50" }, { logDirFn: () => "C:/logs" }), log: () => {}, dialer: fakeDialer() });
  const r = await s.refill();
  assert.equal(r.want, 5);
  assert.ok(r.have <= 5);
  await s.stop();
});

test("关备选：standby=0 ⇒ 一条都不拨、定时器也不起", async () => {
  const d = fakeDialer();
  let scheduled = 0;
  const s = createStandby({ cfg: cfgOf({ MSLXDFF_MULTI_IP_STANDBY: "0" }), log: () => {}, dialer: d, schedule: () => { scheduled++; return "t"; }, cancel: () => {} });
  await s.refill();
  s.start();
  assert.equal(d.dialed.length, 0);
  assert.equal(scheduled, 0, "关着就不该起定时器（否则白烧上游额度）");
  assert.equal(s.stats().have, 0);
  await s.stop();
});

test("周期刷新：到点把旧备用整批拆掉、重拨一批新 IP，收摊一条不留", async () => {
  const d = fakeDialer();
  let fired = null;
  const s = createStandby({ cfg: cfgOf({ MSLXDFF_MULTI_IP_STANDBY: "1" }), log: () => {}, dialer: d, schedule: (fn) => { fired = fn; return "h"; }, cancel: () => { fired = null; } });
  await s.refill();
  assert.equal(s.stats().have, 1);
  const before = d.dialed.length;
  s.start();
  assert.equal(typeof fired, "function", "起池后必须挂上周期刷新（每小时重拨一批）");
  await s.refreshAll();
  assert.equal(s.stats().have, 1, "刷新后仍是 1 条待命");
  assert.ok(d.dropped.length >= 1, "旧备用隧道必须真被拆掉，不能只从账上抹");
  assert.ok(d.dialed.length > before, "刷新要重拨新出口，否则一小时后还是那几个 IP");
  await s.stop();
  assert.equal(s.stats().have, 0, "收摊不许留隧道");
});

test("候选全不通：一轮补位有上限，且老实报告 0 条待命", async () => {
  const d = fakeDialer();
  d.openSlot = async () => null;
  const logs = [];
  const s = createStandby({ cfg: cfgOf(), log: (m) => logs.push(m), dialer: d });
  const r = await s.refill();
  assert.deepEqual({ added: r.added, have: r.have }, { added: 0, have: 0 });
  assert.ok(logs.some((l) => l.includes("0/3 待命")), "取不到备胎必须在日志里看得见（否则 429 时无从判断为什么只能现场拨号）");
  await s.stop();
});