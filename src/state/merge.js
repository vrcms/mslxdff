/**
 * merge 深模块：COLD_WINS + mergeState 纯函数
 * 供 store.js 与 memory.js 同源，避免复制
 */
export const COLD_WINS = new Set([
  "providerConfigs",
  "providerKeys",
  "providerShareKeys",
  "port",
  "token",
  "preferredModel",
  "modelPicks",
  "peers",
  "groups",
  "groupsJoined",
  "bans",
  "createdAt",
]);

export function mergeState(disk, mem) {
  const merged = { ...disk, ...mem };
  for (const k of COLD_WINS) {
    if (disk[k] !== undefined) merged[k] = disk[k];
  }
  return merged;
}
