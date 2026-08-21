# mslxdff 官方插件目录

本目录随 mslxdff 包分发（`*.mjs` 会被自动加载）。**注意：auto-update 重装包时本目录会被重置**——你自己的正式插件请放 `~/.config/mslxdff/plugins/`（升级永不丢）。

优先级：同名文件时用户目录（`~/.config/mslxdff/plugins/`）覆盖本目录。

## 目录约定

- `*.mjs` / `*.js` — 插件模块（default export `{ name, version, hooks, onEvent?, createUpstream? }`）
- `*.example` — 示例模板，不会被加载；复制成 `.mjs` 并去掉后缀即可启用

## Hook 全表

见 `docs/plugins.md`。
