// 常驻热备选路（用户 2026-10-20 约定）：
//   ① 组长恒定第一（先榨干组长额度），组长满了才按延迟升序上组员；
//   ② IPv4 链走空才进 IPv6 阶段（只挑心跳自报 hasV6 的节点）；
//   ③ 备选顺序必须稳定，不随调用次数漂移（这就是「常驻」，不是临时排序）。
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createPeersService } from "../src/peers.js";

function svc(peers, { stats = {}, errors = {} } = {}) {
  return createPeersService({
    peers,
    errors,
    stats,
    persistPeers: () => {},
    persistErrors: () => {},
    persistStats: () => {},
  });
}

const L = "http://149.13.91.10:8989";
const A = "http://10.0.0.1:8989";
const B = "http://10.0.0.2:8989";
const C = "http://10.0.0.3:8989";

describe("standbyChain：组长恒第一 + 延迟升序", () => {
  test("组长延迟不是最低，仍然排第一（旧 ordered 会把它排后面）", () => {
    const p = svc(
      [
        { name: "leader", url: L, token: "t" },
        { name: "b", url: B, token: "t" },
        { name: "c", url: C, token: "t" },
      ],
      // 组长延迟 500ms，组员 B/C 只有 20/30ms —— 旧逻辑会把 B/C 排前面
      { stats: { [L]: { latencyMs: 500 }, [B]: { latencyMs: 20 }, [C]: { latencyMs: 30 } } },
    );
    const { ipv4 } = p.standbyChain();
    assert.deepEqual(ipv4.map((x) => x.url), [L, B, C], "组长必须第一，其后按延迟升序");
  });

  test("无组长记录（组长自己这台的视角）→ 退化为纯延迟升序", () => {
    const p = svc(
      [{ name: "b", url: B }, { name: "c", url: C }],
      { stats: { [B]: { latencyMs: 90 }, [C]: { latencyMs: 10 } } },
    );
    assert.deepEqual(p.standbyChain().ipv4.map((x) => x.url), [C, B]);
  });

  test("心跳延迟（无真实 EMA 时回落）同样参与排序", () => {
    const p = svc([
      { name: "leader", url: L },
      { name: "b", url: B, heartbeatLatencyMs: 300 },
      { name: "c", url: C, heartbeatLatencyMs: 40 },
    ]);
    assert.deepEqual(p.standbyChain().ipv4.map((x) => x.url), [L, C, B]);
  });

  test("冷却中的节点不进链", () => {
    const now = Date.now();
    const p = svc(
      [{ name: "leader", url: L }, { name: "b", url: B }, { name: "c", url: C }],
      { errors: { [B]: now - 1000 } }, // B 刚失败 → 冷却
    );
    const urls = p.standbyChain().ipv4.map((x) => x.url);
    assert.ok(!urls.includes(B), `冷却中的 B 不该进链，实测 ${urls}`);
    assert.deepEqual(urls, [L, C]);
  });
});

describe("standbyChain：IPv6 阶段", () => {
  test("只挑 hasV6 的节点，且仍组长优先、延迟升序", () => {
    const p = svc(
      [
        { name: "leader", url: L, hasV6: true },
        { name: "b", url: B, hasV6: false },
        { name: "c", url: C, hasV6: true },
        { name: "a", url: A, hasV6: true },
      ],
      { stats: { [C]: { latencyMs: 50 }, [A]: { latencyMs: 10 }, [B]: { latencyMs: 5 } } },
    );
    const { ipv4, ipv6 } = p.standbyChain();
    assert.deepEqual(ipv4.map((x) => x.url), [L, B, A, C], "IPv4 阶段：全部节点，组长第一");
    assert.deepEqual(ipv6.map((x) => x.url), [L, A, C], "IPv6 阶段：只 hasV6，组长第一，其余延迟升序");
    assert.ok(!ipv6.some((x) => x.url === B), "B 没有 v6 不能进 v6 链");
  });

  test("没人 hasV6 → v6 链为空（不该乱试）", () => {
    const p = svc([{ name: "leader", url: L }, { name: "b", url: B }]);
    assert.deepEqual(p.standbyChain().ipv6, []);
  });
});

describe("nextStandby：常驻备选（已试过的不再给）", () => {
  test("按已试集合返回两个阶段的各自下一个", () => {
    const p = svc(
      [
        { name: "leader", url: L, hasV6: true },
        { name: "b", url: B, hasV6: true },
        { name: "c", url: C, hasV6: true },
      ],
      { stats: { [B]: { latencyMs: 20 }, [C]: { latencyMs: 10 } } },
    );
    // 一开始备选 = 组长
    assert.equal(p.nextStandby(new Set()).ipv4.url, L);
    // 试过组长后 → 备选 = 延迟最低的组员 C
    assert.equal(p.nextStandby(new Set([L])).ipv4.url, C);
    // 试过组长和 C → 备选 = B
    assert.equal(p.nextStandby(new Set([L, C])).ipv4.url, B);
    // 全试完 → null
    assert.equal(p.nextStandby(new Set([L, C, B])).ipv4, null);
  });

  test("顺序稳定：多次调用同一 tried 集合给出同一个备选（常驻，不漂移）", () => {
    const p = svc(
      [{ name: "leader", url: L }, { name: "b", url: B }, { name: "c", url: C }],
      { stats: { [B]: { latencyMs: 20 }, [C]: { latencyMs: 10 } } },
    );
    const first = p.nextStandby(new Set([L])).ipv4.url;
    for (let i = 0; i < 5; i++) {
      assert.equal(p.nextStandby(new Set([L])).ipv4.url, first, "备选必须稳定，不能每次现排序漂移");
    }
  });
});

describe("ordered：组长恒第一（回归 0.1.219 前的纯延迟排序）", () => {
  test("组长延迟高也排第一", () => {
    const p = svc(
      [{ name: "leader", url: L }, { name: "b", url: B }],
      { stats: { [L]: { latencyMs: 999 }, [B]: { latencyMs: 1 } } },
    );
    assert.deepEqual(p.ordered().map((x) => x.url), [L, B]);
  });
});
