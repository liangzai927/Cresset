/**
 * 模型 Provider 的公共类型
 *
 * 这里只定义"网关需要什么"，**不包含任何厂商 SDK 类型**。
 * 厂商适配器负责把各自的 HTTP 协议翻译成这套最小接口，
 * 这样换模型（OpenAI 兼容 / Anthropic / Ollama）不会渗透到业务代码。
 *
 * 本文件不含 IO、不读配置、不发请求。
 */

/** 对话角色；与 OpenAI / Anthropic 的 role 语义一致 */
export type ChatRole = "system" | "user" | "assistant";

/** 一条对话消息；v1 只支持纯文本，图片与工具调用留到 M4 */
export interface ChatMessage {
  role: ChatRole;
  content: string;
}

/** 一次补全请求；由网关在脱敏之后构造 */
export interface CompletionRequest {
  model: string;
  messages: ChatMessage[];
  /** 采样温度；0 表示尽量确定 */
  temperature?: number;
  /** 最大输出 token 数；适配器按厂商字段映射 */
  maxTokens?: number;
  /** 取消信号；调用方超时或用户中断时触发 */
  signal?: AbortSignal;
}

/** token 用量；用于成本核算，缺失时调用方按 0 处理 */
export interface CompletionUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/** 一次补全结果 */
export interface CompletionResponse {
  /** 模型返回的文本 */
  text: string;
  /** 实际使用的模型（服务端可能返回带版本的名称） */
  model: string;
  /** token 用量；部分本地模型不返回 */
  usage?: CompletionUsage;
  /** 结束原因（stop / length / tool_calls 等，厂商原样返回） */
  finishReason?: string;
}

/**
 * 模型 Provider 抽象。
 *
 * ⚠️ 只有 `@aegis/redaction-gateway` 允许依赖本包（C3 唯一出口）。
 * 任何其他模块直接调用 Provider 都视为**绕过脱敏网关**，依赖方向门禁会拦。
 */
export interface ModelProvider {
  /** 稳定的 provider 标识，写入审计（如 "openai-compatible"） */
  readonly id: string;
  /**
   * 发起一次非流式补全。
   *
   * @throws {@link ProviderError} 配置错误、鉴权失败、限流、超时、网络或响应格式错误
   */
  complete(request: CompletionRequest): Promise<CompletionResponse>;
}
