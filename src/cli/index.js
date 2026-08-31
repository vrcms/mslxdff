import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(readFileSync(join(__dirname, "..", "..", "package.json"), "utf8")).version;

// deep CLI entry — single inlet: run(args) — hides all command branching inside
export async function run(args = process.argv.slice(2)) {
  const { handleHelp, handleUpdate, handleRefreshToken, handleShowToken, handleUninstall, handleLog, handlePlugins, handleChat, handleStatus, handleFree, handleAutostart } = await import("./commands/system.js");
  if (await handleHelp(args, VERSION)) return;
  if (await handleUpdate(args, VERSION)) return;
  if (await handleRefreshToken(args)) return;
  if (await handleShowToken(args)) return;
  const { handleTimezone } = await import("./commands/timezone.js");
  if (await handleTimezone(args)) return;

  const { handleStop, handleRestart } = await import("./commands/daemon.js");
  if (await handleStop(args)) return;
  if (await handleRestart(args, VERSION)) return;
  if (await handleUninstall(args)) return;
  if (await handleLog(args)) return;
  if (await handlePlugins(args)) return;
  if (await handleChat(args)) return;
  if (await handleStatus(args, VERSION)) return;

  const { handleModel } = await import("./commands/model.js");
  if (await handleModel(args)) return;
  const { handleSetto } = await import("./commands/sync.js");
  if (await handleSetto(args)) return;
  const { handleWorkbuddy } = await import("./commands/workbuddy.js");
  if (await handleWorkbuddy(args)) return;

  if (await handleAutostart(args)) return;
  if (await handleFree(args)) return;

  const { handleProviders, handleProvider } = await import("./commands/provider.js");
  if (await handleProviders(args)) return;
  if (await handleProvider(args)) return;

  const { handleDebug } = await import("./commands/daemon.js");
  await handleDebug(args);

  const { handleGroupCreate, handleGroupCommand, handleAddToGroup, handleResetBan, handleLeaveGroup, handleDelGroup } = await import("./commands/group.js");
  if (await handleGroupCreate(args)) return;
  if (await handleGroupCommand(args)) return;
  if (await handleAddToGroup(args)) return;
  if (await handleResetBan(args)) return;
  if (await handleLeaveGroup(args)) return;
  if (await handleDelGroup(args)) return;

  const { handlePort, handleDaemonFlag, handleBareRun } = await import("./commands/daemon.js");
  if (await handlePort(args)) return;
  if (await handleDaemonFlag(args, VERSION)) return;
  if (await handleBareRun(args, VERSION)) return;

  const { startDaemonMain } = await import("./bootstrap.js");
  await startDaemonMain(VERSION);
}

export { VERSION };
