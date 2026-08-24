// Facade — chat 逻辑已拆至 ./chat/ 子模块，按需加载保持单文件 <10KB
export * from "./chat/index.js";
export { chatHandler } from "./chat/index.js";
