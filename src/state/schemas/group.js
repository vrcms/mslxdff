import { defaultStateFile, readState, writeStateImmediate } from "../store.js";

export function loadGroups({ file = defaultStateFile() } = {}) {
  const groups = readState(file).groups;
  return groups && typeof groups === "object" && !Array.isArray(groups) ? groups : {};
}

export function loadGroupsJoined({ file = defaultStateFile() } = {}) {
  const joined = readState(file).groupsJoined;
  return Array.isArray(joined) ? joined : [];
}

export function saveGroupsJoined(joined, { file = defaultStateFile() } = {}) {
  writeStateImmediate(file, { groupsJoined: joined });
  return joined;
}

export function loadBans({ file = defaultStateFile() } = {}) {
  const bans = readState(file).bans;
  return bans && typeof bans === "object" && !Array.isArray(bans) ? bans : {};
}

export function saveBans(bans, { file = defaultStateFile() } = {}) {
  writeStateImmediate(file, { bans });
  return bans;
}

export function saveGroups(groups, { file = defaultStateFile() } = {}) {
  writeStateImmediate(file, { groups });
  return groups;
}
