/**
 * `@aegis/model-provider` 公共出口
 *
 * ## 职责边界
 *
 * 只定义"如何调用模型"：接口、错误、三个厂商适配器、测试假实现。
 * **不做**脱敏、分级、审计、预算 —— 这些属于 `@aegis/redaction-gateway`。
 *
 * ## 唯一消费者
 *
 * 依赖方向门禁只允许 `redaction-gateway` 依赖本包（C3 唯一出口）。
 * 其他模块直接 import 会被 `pnpm boundaries` 拦下。
 */

export * from "./anthropic.js";
export * from "./errors.js";
export * from "./fake.js";
export * from "./http.js";
export * from "./ollama.js";
export * from "./openai-compatible.js";
export * from "./types.js";
