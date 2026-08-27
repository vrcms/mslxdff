import { startRepl } from "./repl.js";

export async function startChat({ singleShot } = {}) {
  // 独立进程：本函数在用户终端前台运行，与 daemon 无父子关系，daemon 重启不影响
  await startRepl({ singleShot });
}
