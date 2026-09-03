/**
 * 其他供应商 allowlist 段 + 遗留别名映射展示。
 * 输入均为已算好的数据；state/model-id 走动态 import（与原内联一致，避免循环依赖）。
 */
export async function renderOtherProviders({ pickedIds, ids, fullAliases }) {
  const { loadProviderConfigs, loadProviderAllowedModels, loadProviderAllowAnyModels, loadProviderBaseUrl } = await import("../../../state.js");
  const { loadModelAliases: _la2, getAliasForModel: _gaf } = await import("../../../providers/model-id.js");
  try { _la2(); } catch {}
  const configs = loadProviderConfigs();
  const otherIds = Object.keys(configs).filter((k) => String(k).toLowerCase() !== "opencode");
  const order2 = ["workbuddy", "clinebot", "openrouter", "bai"];
  otherIds.sort((a, b) => {
    const ia = order2.indexOf(a), ib = order2.indexOf(b);
    if (ia !== -1 || ib !== -1) {
      if (ia === -1) return 1;
      if (ib === -1) return -1;
      return ia - ib;
    }
    return a.localeCompare(b);
  });
  if (otherIds.length) {
    console.log(`\n────────────────────────────────────────`);
    console.log(`其他供应商 (allowlist，原名 + 别名) (${otherIds.length} providers):`);
    for (const pid of otherIds) {
      const allowed = loadProviderAllowedModels(pid);
      const allowAny = loadProviderAllowAnyModels(pid);
      const baseUrl = loadProviderBaseUrl(pid) || configs[pid]?.baseUrl || "";
      const header = allowAny
        ? (allowed.length ? `allowlist ${allowed.length} (allowAny ON)` : `allowAny ON (allowlist 空=放行全部)`)
        : (allowed.length ? `allowlist ${allowed.length} (allowAny OFF)` : `allowlist 空 + allowAny OFF = 阻塞`);
      console.log(`\n  ── ${pid} (${header})${baseUrl ? `  baseUrl=${baseUrl}` : ""} ──`);
      if (!allowed.length) {
        if (allowAny) {
          console.log(`     (未设 allowlist，全部模型放行)  查看 live 列表: mslxdff -provider ${pid} models`);
          console.log(`     限制可用模型: mslxdff -provider ${pid} allowlist set <model1> <model2>`);
        } else {
          console.log(`     阻塞中：无可用模型 — 设白名单: mslxdff -provider ${pid} allowlist set <model1> <model2>`);
          console.log(`     或放行全部: mslxdff -provider ${pid} allowAny on`);
        }
      } else {
        for (const raw of allowed) {
          const canonical = `${pid}/${raw}`;
          let alias = null;
          try { alias = _gaf(canonical); } catch {}
          if (!alias && String(canonical).includes("/")) alias = String(canonical).replace(/\//g, "-");
          const aliasStr = alias && alias !== canonical ? `  (别名: ${alias})` : "";
          const pickedMark = pickedIds.includes(canonical) || pickedIds.includes(alias || "") ? "*" : " ";
          console.log(`     ${pickedMark} ${canonical}${aliasStr}`);
        }
        console.log(`     管理: mslxdff -provider ${pid} allowlist [list|add|remove|clear] | allowAny on|off`);
      }
    }
  } else {
    console.log(`\n────────────────────────────────────────`);
    console.log(`其他供应商 (allowlist，原名 + 别名): (none — 尚未配置)`);
    console.log(`  添加示例: mslxdff -provider add myapi https://api.example.com/v1 sk-xxx --models-path /v1/models`);
  }
  const aliasEntries = Object.entries(fullAliases).filter(([alias, canonical]) => {
    if (ids.includes(canonical)) return false;
    for (const pid of otherIds) {
      const allowed = loadProviderAllowedModels(pid);
      for (const raw of allowed) {
        const can = `${pid}/${raw}`;
        if (can === canonical) return false;
      }
    }
    return true;
  });
  if (aliasEntries.length) {
    console.log(`\n  本地别名 (不在 allowlist 里的遗留映射 ${aliasEntries.length}):`);
    for (const [alias, canonical] of aliasEntries) {
      console.log(`     ${canonical}  =>  ${alias}`);
    }
  }
}
