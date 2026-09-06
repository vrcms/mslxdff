// DeepSeek SSE JSON-Patch decoder（对齐 TQZHR/deepseek2api MIT src/utils/deepseek-sse.js 范式）
// 纯解码层：consume(payloadText) → deltas[{kind,text,snapshot?}]，kind ∈ content|reasoning|finish
// Android 通道特有补充：startKind（expert 空 THINK fragment 无 type 字段时兜底）+
// elapsed_secs SET 边界（THINK→RESPONSE 静默切换，新 fragment 首块带路径但无 o）。
const FRAGMENT_KIND_BY_TYPE = Object.freeze({
  ANSWER: "content",
  THINKING: "reasoning",
  THINK: "reasoning",
  RESPONSE: "content",
});

function resolveFragmentKind(type) {
  return FRAGMENT_KIND_BY_TYPE[String(type || "").toUpperCase()] ?? null;
}

function normalizePatchPath(basePath, path) {
  const b = String(basePath || "").replace(/^\/+|\/+$/g, "");
  const p = String(path || "").replace(/^\/+|\/+$/g, "");
  if (!p) return b;
  if (p === "response" || p.startsWith("response/")) return p;
  return b ? `${b}/${p}` : p;
}

function isSnapshotOperation(op) {
  const t = String(op || "").toUpperCase();
  return t === "SET" || t === "REPLACE";
}

// TQZHR takeUnseenSuffix：快照是某类全量文本，取相对已累积的未见过后缀
function unseenSuffix(previous, next) {
  if (!next) return "";
  if (!previous) return next;
  if (next.startsWith(previous)) return next.slice(previous.length);
  if (previous.endsWith(next)) return "";
  const max = Math.min(previous.length, next.length);
  for (let len = max; len > 0; len--) {
    if (previous.endsWith(next.slice(0, len))) return next.slice(len);
  }
  return next;
}

export function createDeepseekDeltaParser({ startKind = "content" } = {}) {
  const state = { currentKind: startKind, finished: false };
  const acc = { content: "", reasoning: "" };

  function push(kind, text, snapshot, deltas) {
    if (typeof text !== "string" || !text) return;
    const unseen = snapshot ? unseenSuffix(acc[kind], text) : text;
    if (!unseen) return;
    acc[kind] += unseen;
    deltas.push({ kind, text: unseen });
  }

  function appendFragmentDeltas(fragments, { snapshot = false } = {}, deltas) {
    if (!Array.isArray(fragments)) return;
    const grouped = new Map();
    for (const frag of fragments) {
      const kind = resolveFragmentKind(frag?.type);
      // type 明确才更新 currentKind（空 fragment {} 不改变判定，Android expert 真机形态）
      if (kind) state.currentKind = kind;
      const content = typeof frag?.content === "string" && frag.content ? frag.content : "";
      if (content) grouped.set(state.currentKind, (grouped.get(state.currentKind) ?? "") + content);
    }
    for (const [kind, text] of grouped) push(kind, text, snapshot, deltas);
  }

  function appendResponseSnapshot(response, deltas) {
    if (Array.isArray(response?.fragments)) {
      appendFragmentDeltas(response.fragments, { snapshot: true }, deltas);
      return;
    }
    // 旧版字段（web 1.x 通道）
    push("reasoning", response?.thinking_content, true, deltas);
    push("content", response?.content, true, deltas);
  }

  function decodePatch(payload, deltas, basePath = "") {
    if (!payload || typeof payload !== "object") return;
    const path = normalizePatchPath(basePath, payload.p ?? "");
    const value = payload.v;

    // 流结束信号（TQZHR 放在 completion-stream 层，我们在 decoder 内处理）
    if (value === "FINISHED" && (path === "response/status" || /\/status$/.test(path))) {
      if (!state.finished) {
        state.finished = true;
        deltas.push({ kind: "finish" });
      }
      return;
    }

    const response = value?.response ?? (!path ? payload.response : null);
    if (response && typeof response === "object") {
      appendResponseSnapshot(response, deltas);
      return;
    }

    if (payload.o === "BATCH" && Array.isArray(value)) {
      for (const op of value) decodePatch(op, deltas, path);
      return;
    }

    if (path === "response" && Array.isArray(value)) {
      for (const op of value) decodePatch(op, deltas, "response");
      return;
    }

    if (path === "response/fragments" && Array.isArray(value)) {
      appendFragmentDeltas(value, { snapshot: payload.o !== "APPEND" }, deltas);
      return;
    }

    if (/^response\/fragments\/-?\d+$/.test(path) && value && typeof value === "object") {
      appendFragmentDeltas([value], { snapshot: isSnapshotOperation(payload.o) }, deltas);
      return;
    }

    if (/^response\/fragments\/-?\d+\/type$/.test(path)) {
      state.currentKind = resolveFragmentKind(value) ?? state.currentKind;
      return;
    }

    if (path === "response/thinking_content" && typeof value === "string") {
      push("reasoning", value, isSnapshotOperation(payload.o), deltas);
      return;
    }

    if (path === "response/content" && typeof value === "string") {
      push("content", value, isSnapshotOperation(payload.o), deltas);
      return;
    }

    if (/^response\/fragments\/-?\d+\/content$/.test(path) && typeof value === "string") {
      push(state.currentKind, value, isSnapshotOperation(payload.o), deltas);
      return;
    }

    // 裸 v：沿用 currentKind（流式优化，无 p）
    if (!("p" in payload) && typeof value === "string") {
      push(state.currentKind, value, false, deltas);
      return;
    }

    // elapsed_secs SET：Android 通道 THINK→RESPONSE 静默边界（单轮 THINK→RESPONSE 固定交替）
    if (/^response\/fragments\/-?\d+\/elapsed_secs$/.test(path) && payload.o === "SET") {
      if (state.currentKind === "reasoning") state.currentKind = "content";
    }
    // 其余（accumulated_token_usage / quasi_status / search_status 等）忽略
  }

  return {
    consume(payloadText) {
      const deltas = [];
      let payload = null;
      try { payload = JSON.parse(String(payloadText ?? "")); } catch { return deltas; }
      decodePatch(payload, deltas);
      return deltas;
    },
    _state: state,
  };
}
