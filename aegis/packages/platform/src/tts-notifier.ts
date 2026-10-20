/**
 * macOS TTS 通知渠道（M3）
 *
 * 用 `/usr/bin/say` 朗读标题+正文。完全本地，不产生网络外发。
 * 语音是"额外的打扰"，默认关闭；由用户显式启用。
 *
 * 注意：spawn 是异步的，不能阻塞 daemon 的 tick；朗读超时会杀进程。
 */

import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import type { ChannelOutcome, Notifier, NotifyPayload } from "./index.js";

/** say 调用结果；抽出来便于测试 */
export interface TtsExecResult {
  code: number | null;
  timedOut: boolean;
  stderr: string;
}

/** TTS 渠道配置 */
export interface TtsNotifierOptions {
  /** macOS voice 名，例如 "Tingting"；留空用系统默认 */
  voice?: string;
  timeoutMs?: number;
  /** 注入执行器，便于测试；默认 spawn /usr/bin/say */
  exec?: (text: string, voice: string | undefined, timeoutMs: number) => Promise<TtsExecResult>;
}

/** 默认异步执行 say */
function defaultExec(text: string, voice: string | undefined, timeoutMs: number): Promise<TtsExecResult> {
  return new Promise((resolve) => {
    const args = voice ? ["-v", voice, text] : [text];
    const child = spawn("/usr/bin/say", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let timedOut = false;
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: null, timedOut: false, stderr: err.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, timedOut, stderr });
    });
  });
}

/** 语音播报渠道 */
export class TtsNotifier implements Notifier {
  readonly channel = "tts" as const;
  readonly #voice: string | undefined;
  readonly #timeoutMs: number;
  readonly #exec: (text: string, voice: string | undefined, timeoutMs: number) => Promise<TtsExecResult>;

  constructor(options: TtsNotifierOptions = {}) {
    this.#voice = options.voice;
    this.#timeoutMs = options.timeoutMs ?? 20_000;
    this.#exec = options.exec ?? defaultExec;
  }

  /** 只检查平台/命令存在，不发声 */
  async probe(): Promise<{ ok: boolean; detail: string }> {
    if (process.platform !== "darwin") {
      return { ok: false, detail: `平台 ${process.platform} 不支持 macOS say` };
    }
    try {
      accessSync("/usr/bin/say", constants.X_OK);
      return { ok: true, detail: "say 可用（未发声）" };
    } catch {
      return { ok: false, detail: "/usr/bin/say 不可用" };
    }
  }

  /** 朗读标题+正文 */
  async send(payload: NotifyPayload): Promise<{ outcome: ChannelOutcome; error?: string }> {
    const text = [payload.title, payload.body].filter(Boolean).join("。");
    if (!text) return { outcome: "permanent_error", error: "没有可朗读的内容" };
    const r = await this.#exec(text, this.#voice, this.#timeoutMs);
    if (r.timedOut) return { outcome: "timeout", error: "语音播报超时" };
    if (r.code === 0) return { outcome: "success" };
    return { outcome: "permanent_error", error: r.stderr.slice(0, 200) || `say 退出码 ${r.code}` };
  }
}
