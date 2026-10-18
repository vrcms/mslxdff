// mslxdff -provider raccoon login --password —— 手机号 + 密码登录（多账号免扫码）。
//
// 为什么需要它：扫码登录一次只能加一个号，且要手机在手边；密码登录可以在同一个终端里
// 连着把多个号加完（脚本化也行），是「批量补号」的正路。
//
// 安全：密码**只经手本进程内存**，绝不落盘、绝不打印、绝不进 argv（除非用户显式 `--password=xxx`，
// 那种情况会在回执里提示一次「密码已进 shell 历史」）。落盘的是 token，与扫码登录同一条路。
import { compatFetch } from "../../../compat.js";
import { loginRaccoonWithPassword, normalizePhone } from "../../../providers/raccoon/password-login.js";
import { finishRaccoonLogin } from "./raccoon-login.js";

const RELOGIN_HINT = "   （可重试：mslxdff -provider raccoon login --password）";

/**
 * 从 rest 里取 `--key=value` 或 `--key value` 两种写法。
 * **裸旗标（无值）返回 undefined**，不是空串 —— 这样 `?? deps.x` 才能正常回落，
 * 否则 `"" ?? deps.x` 恒取空串，把「只写了 --password 想让程序询问」误判成「显式给了空密码」。
 */
function flagValue(rest, ...names) {
  for (let i = 0; i < rest.length; i++) {
    const cur = String(rest[i]);
    for (const name of names) {
      if (cur === name) {
        const next = rest[i + 1];
        return typeof next === "string" && next.length > 0 && !next.startsWith("-") ? next : undefined;
      }
      if (cur.startsWith(`${name}=`)) {
        const v = cur.slice(name.length + 1);
        return v.length > 0 ? v : undefined;
      }
    }
  }
  return undefined;
}

/**
 * TTY 隐藏输入：**不碰 readline**（它会自己接管 stdin 的原始模式，与我们抢同一份字节），
 * 直接开 raw mode 逐字符读，每个键回显一个 `*` 给出「确实收到了」的可见反馈。
 * 非 TTY 返回 null（由调用方转成「必须用 flag」的指引，绝不从管道偷读）。
 */
async function promptHidden(label) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return null;
  return await new Promise((resolve) => {
    const wasRaw = Boolean(process.stdin.isRaw);
    let buf = "";
    const done = (value) => {
      process.stdin.removeListener("data", onData);
      try { process.stdin.setRawMode(wasRaw); } catch {}
      process.stdin.pause();
      process.stdout.write("\n");
      resolve(value);
    };
    const onData = (chunk) => {
      for (const ch of String(chunk)) {
        if (ch === "\r" || ch === "\n") return done(buf);
        if (ch === "\u0003") return done(null); // Ctrl-C
        if (ch === "\u007f" || ch === "\b") { // 退格
          if (buf.length > 0) { buf = buf.slice(0, -1); process.stdout.write("\b \b"); }
          continue;
        }
        if (ch < " ") continue; // 忽略其余控制字符
        buf += ch;
        process.stdout.write("*");
      }
    };
    process.stdout.write(label);
    try { process.stdin.setRawMode(true); } catch {}
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", onData);
  });
}

async function promptVisible(label) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return null;
  const { createInterface } = await import("../../../readline-compat.js");
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  try {
    return await rl.question(label);
  } finally {
    rl.close();
  }
}

export async function handleRaccoonPasswordLogin(id, sub, rest = [], deps = {}) {
  const fetchImpl = deps.fetchImpl || compatFetch;
  const log = deps.log || ((m) => console.log(m));
  const exit = deps.exit || ((code) => process.exit(code));

  log("=".repeat(60));
  log("  Raccoon 登录（商汤小浣熊 · 手机号 + 密码）");
  log("=".repeat(60));
  log("");

  let phone = flagValue(rest, "--phone") ?? deps.phone;
  // `--password` 既是「模式开关」也可携带值：`--password`（裸）→ 交互询问，`--password=xxx` → 直接用。
  let password = flagValue(rest, "--password", "-p") ?? deps.password;
  const nationCode = flagValue(rest, "--nation", "--nation-code", "--area") || deps.nationCode || "86";

  if (!phone) {
    const asked = await promptVisible("  手机号: ");
    if (asked === null) {
      log("❌ 非交互环境（非 TTY）无法询问手机号 —— 请用 --phone 传入");
      log(RELOGIN_HINT);
      exit(1);
      return true;
    }
    phone = asked;
  }
  const cleanPhone = normalizePhone(phone);
  if (!cleanPhone) {
    log("❌ 手机号不能为空（只填数字即可）");
    log(RELOGIN_HINT);
    exit(1);
    return true;
  }

  if (!password) {
    const asked = await promptHidden("  密码（输入不回显）: ");
    if (asked === null) {
      log("❌ 非交互环境（非 TTY）无法安全询问密码 —— 请用 --password 传入");
      log(RELOGIN_HINT);
      exit(1);
      return true;
    }
    password = asked;
  }

  if (String(password || "").length === 0) {
    log("❌ 密码不能为空");
    log(RELOGIN_HINT);
    exit(1);
    return true;
  }

  log("🔐 正在登录…");
  let credential;
  try {
    credential = await loginRaccoonWithPassword(
      { phone: cleanPhone, password, nationCode },
      { fetchImpl, env: deps.env },
    );
  } catch (error) {
    log("");
    log(`❌ 登录失败：${error?.message ?? error}`);
    log(RELOGIN_HINT);
    exit(1);
    return true;
  }

  // 密码已用完，立刻从本进程的作用域里抹掉（降内存残留；不是安全边界，是习惯）
  password = undefined;

  const masked = cleanPhone.length > 4 ? `${"*".repeat(cleanPhone.length - 4)}${cleanPhone.slice(-4)}` : cleanPhone;
  return await finishRaccoonLogin({
    credential,
    fetchImpl,
    deps,
    log,
    methodNote: `   登录方式: 密码登录（手机号 ${masked}）`,
  });
}
