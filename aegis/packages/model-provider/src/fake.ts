/**
 * 测试用 Provider
 *
 * 它不发起任何网络请求，只记录请求并按调用方给定的 responder 返回结果。
 * 生产代码不应使用它 —— 它存在的意义是让网关测试**不依赖真实模型与 API Key**。
 */

import type { CompletionRequest, CompletionResponse, ModelProvider } from "./types.js";

/** 由测试决定的响应函数 */
export type FakeResponder = (request: CompletionRequest) => CompletionResponse | Promise<CompletionResponse>;

/** 记录请求并返回构造响应的假 Provider */
export class FakeModelProvider implements ModelProvider {
  readonly id: string;
  readonly requests: CompletionRequest[] = [];
  readonly #respond: FakeResponder;

  constructor(respond?: FakeResponder, id = "fake") {
    this.id = id;
    this.#respond = respond ?? ((request) => ({ text: "fake-response", model: request.model }));
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    // 复制 messages，避免调用方在请求发出后修改数组影响断言
    this.requests.push({ ...request, messages: request.messages.map((m) => ({ ...m })) });
    return this.#respond(request);
  }

  /** 清空已记录的请求（测试之间复用同一实例时用） */
  reset(): void {
    this.requests.length = 0;
  }
}
