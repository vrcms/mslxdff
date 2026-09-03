import { groupSyncIntervalMs } from "../cli/policy.js";
import { errMsg } from "../cli/util.js";

/**
 * 群组成员同步 — 首拉 + 定时器（fire-and-forget，原语义）。
 */
export async function startGroupSync({ peers, groups }) {
  const { syncAllJoinedGroups } = await import("../cli/group-helpers.js");
  syncAllJoinedGroups({ peers, groups })
    .then((results) => {
      for (const r of results) {
        if (r.error) console.log(`group sync ${r.name}: failed — ${r.error}`);
        else console.log(`group sync ${r.name}: ${r.total} member(s), ${r.added} peer(s)`);
      }
    })
    .catch((err) => console.log(`group sync: ${errMsg(err)}`));
  const groupSyncTimer = setInterval(() => {
    syncAllJoinedGroups({ peers, groups })
      .then((results) => {
        for (const r of results) {
          if (r.error) console.log(`group sync ${r.name}: failed — ${r.error}`);
          else if (r.added) console.log(`group sync ${r.name}: ${r.total} member(s), ${r.added} peer(s)`);
        }
      })
      .catch((err) => console.log(`group sync: ${errMsg(err)}`));
  }, groupSyncIntervalMs());
  groupSyncTimer.unref();
}
