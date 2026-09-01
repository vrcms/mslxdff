import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getOnlinePeers } from "../src/bench/via.js";

describe("bench/via discovery", () => {
  it("未加组返回空且不调网络", async () => {
    let healthCalls = 0;
    const probeHealth = async () => { healthCalls++; return { rank: 0 }; };
    const loadGroupsJoined = () => [];
    const peers = await getOnlinePeers({ loadGroupsJoined, probeHealth });
    assert.equal(peers.length, 0);
    assert.equal(healthCalls, 0);
  });

  it("过滤离线 peer", async () => {
    const loadGroupsJoined = () => [
      { name: "g1", kind: "static", members: {} } // not used directly, via peers
    ];
    // getOnlinePeers should also look at peers list via loadPeers?我们用 injected loadPeers
    const loadPeers = () => [
      { id: "B", url: "http://1.1.1.1:8989" },
      { id: "C", url: "http://2.2.2.2:8989" },
    ];
    const probeHealth = async ({ id }) => {
      if (id === "B") return { id, url: `http://${id}`, rank: 0 };
      return { id, url: `http://${id}`, rank: 2, fail: "offline" };
    };
    const peers = await getOnlinePeers({ loadGroupsJoined, loadPeers, probeHealth });
    assert.equal(peers.length, 1);
    assert.equal(peers[0].id, "B");
  });

  it("broadband stale 视为离线", async () => {
    const loadGroupsJoined = () => [];
    const loadPeers = () => [
      { id: "BB", url: "relay://leader/g2", kind: "broadband", lastSeen: Date.now() - 200000 },
    ];
    const probeHealth = async (p) => {
      if (p.kind === "broadband") return { ...p, rank: 2, stale: true, fail: "stale" };
      return { ...p, rank: 0 };
    };
    const peers = await getOnlinePeers({ loadGroupsJoined, loadPeers, probeHealth });
    assert.equal(peers.length, 0);
  });
});
