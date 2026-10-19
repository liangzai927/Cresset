/**
 * 凭据存储 —— 一律进系统钥匙串，不落明文配置（NFR-S1）
 *
 * 实测约束（R0 S3 / 《M0+M1 详细设计》C-5）：
 *   1. 读取**必须带 `-w`** —— 不带 -w 时 `security` 会走 GUI 授权对话框，
 *      对 24/7 无人值守的 daemon 是致命的（会永久挂住）。
 *   2. `security` 的钥匙串路径（若指定）必须是**最后一个位置参数**。
 *   3. 删除一个不存在的条目会返回非 0；这**不是错误**，要当"已删除"处理。
 *   4. 受限环境（沙箱/无 GUI 会话）下访问登录钥匙串会被拒（`Operation not permitted`），
 *      此时应给出明确的可用性结论，而不是抛裸错。
 *
 * 安全约定：
 *   - 凭据值绝不进日志、绝不进数据库；库里只存引用（`credential_ref.keychain_key`）。
 *   - 本模块的返回值是明文（调用方需要使用），因此**禁止**把它写进审计/日志。
 */
import { spawnSync } from "node:child_process";

/** 凭据存储抽象；实现须保证**非交互**（无人值守场景不能被 GUI 授权卡住） */
export interface SecretStore {
  set(key: string, value: string): Promise<void>;
  get(key: string): Promise<string | null>;
  delete(key: string): Promise<void>;
  /** 列出该 service 下的条目名（用于诊断与清理孤儿凭据） */
  list(): Promise<string[]>;
  /** 能力自检：启动时可用来确认凭证存储可用 */
  available(): Promise<SecretAvailability>;
}

/** 可用性自检结果；`backend` 用于诊断实际走的是哪条实现 */
export interface SecretAvailability {
  ok: boolean;
  detail: string;
  /** 使用的后端（便于诊断） */
  backend: string;
}

/** 凭据存储不可用（平台未实现 / 权限被拒 / 读取超时） */
export class SecretUnavailableError extends Error {
  constructor(detail: string) {
    super(`凭据存储不可用：${detail}`);
    this.name = "SecretUnavailableError";
  }
}

/** 凭据写入失败（含权限拒绝） */
export class SecretWriteError extends Error {
  constructor(detail: string) {
    super(`凭据写入失败：${detail}`);
    this.name = "SecretWriteError";
  }
}

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** login keychain 的默认路径 */
export function defaultLoginKeychainPath(home: string = process.env.HOME ?? ""): string {
  return `${home}/Library/Keychains/login.keychain-db`;
}

function runSecurity(args: string[], timeoutMs: number): CommandResult {
  const r = spawnSync("/usr/bin/security", args, { encoding: "utf8", timeout: timeoutMs });
  return {
    code: r.status ?? -1,
    stdout: (r.stdout ?? "").trim(),
    stderr: (r.stderr ?? "").trim(),
    timedOut: r.signal === "SIGTERM",
  };
}

/** macOS 钥匙串实现的可选项；`keychainPath` 建议显式指定（约束 C-9） */
export interface MacOsKeychainOptions {
  /** 钥匙串 service 名（来自 @aegis/product 的 KEYCHAIN_SERVICE） */
  service: string;
  /**
   * 目标钥匙串路径（必须是 security 命令的**最后一个位置参数**）。
   *
   * 约束 C-9：**强烈建议显式指定**。`security` 的查找/删除会在整个钥匙串搜索列表
   * （login + System + 其他）中生效，而不带 `-k` 时命中哪个钥匙串并不确定 ——
   * R1 实测出现过"delete 报告已删除、find 仍能检索到"的不一致现象。
   * 显式指定可以把行为固定下来。默认使用 login keychain。
   */
  keychainPath?: string;
  /** 单次调用超时（毫秒）—— 防止意外的 GUI 交互把 daemon 挂死 */
  timeoutMs?: number;
}

/** macOS 钥匙串实现（经 `/usr/bin/security`） */
export class MacOsKeychain implements SecretStore {
  readonly #service: string;
  readonly #keychainPath: string | undefined;
  readonly #timeoutMs: number;

  constructor(opts: MacOsKeychainOptions) {
    if (!opts.service.trim()) throw new Error("service 不能为空");
    this.#service = opts.service;
    // 默认显式指向 login keychain（C-9：避免搜索列表带来的不确定性）
    this.#keychainPath = opts.keychainPath ?? defaultLoginKeychainPath();
    this.#timeoutMs = opts.timeoutMs ?? 15_000;
  }

  /** 钥匙串路径必须是**最后一个位置参数**（C-5 第 2 条） */
  #withKeychain(args: string[]): string[] {
    return this.#keychainPath ? [...args, this.#keychainPath] : args;
  }

  async set(key: string, value: string): Promise<void> {
    // -U：已存在则更新（幂等写入）
    const r = runSecurity(
      this.#withKeychain(["add-generic-password", "-s", this.#service, "-a", key, "-w", value, "-U"]),
      this.#timeoutMs,
    );
    if (r.code !== 0) {
      throw new SecretWriteError(r.stderr || r.stdout || `security 退出码 ${r.code}`);
    }
  }

  async get(key: string): Promise<string | null> {
    // ★ 必须带 -w：这是唯一不弹 GUI 授权的读取方式
    const r = runSecurity(
      this.#withKeychain(["find-generic-password", "-s", this.#service, "-a", key, "-w"]),
      this.#timeoutMs,
    );
    if (r.timedOut) {
      throw new SecretUnavailableError("读取凭据超时（可能意外触发了 GUI 授权，请确认使用了 -w）");
    }
    // 条目不存在（退出码 44）是正常情况
    if (r.code !== 0) return null;
    return r.stdout;
  }

  async delete(key: string): Promise<void> {
    const r = runSecurity(
      this.#withKeychain(["delete-generic-password", "-s", this.#service, "-a", key]),
      this.#timeoutMs,
    );
    if (r.code === 0) return;
    // 条目本就不存在 → 视为已删除
    if (r.code === 44 || /could not be found|SecKeychainItemNotFound/i.test(r.stderr)) return;
    throw new Error(`凭据删除失败：${r.stderr || r.stdout || `退出码 ${r.code}`}`);
  }

  /**
   * 列出该 service 下的条目名。
   * 用 `dump-keychain`（只读属性、不带 -w）因此**不会输出明文口令**。
   */
  async list(): Promise<string[]> {
    // 只 dump 目标钥匙串（避免搜索列表带来的跨钥匙串噪声）
    const r = runSecurity(this.#withKeychain(["dump-keychain"]), this.#timeoutMs);
    if (r.code !== 0) return [];
    const accounts: string[] = [];
    // dump-keychain 以属性块形式输出；按 svce 分组后取 acct
    for (const block of r.stdout.split(/\n\s*keychain:/)) {
      const svce = /"svce"<blob>="([^"]*)"/.exec(block)?.[1];
      if (svce !== this.#service) continue;
      const acct = /"acct"<blob>="([^"]*)"/.exec(block)?.[1];
      if (acct) accounts.push(acct);
    }
    return accounts;
  }

  async available(): Promise<SecretAvailability> {
    const probeKey = `__aegis_probe_${process.pid}`;
    const marker = `probe-${Date.now()}`;
    const backend = this.#keychainPath ? "security-cli(custom-keychain)" : "security-cli(login-keychain)";

    try {
      await this.set(probeKey, marker);
    } catch (err) {
      return {
        ok: false,
        backend,
        detail: `写入失败：${err instanceof Error ? err.message : String(err)}`,
      };
    }

    try {
      const readBack = await this.get(probeKey);
      if (readBack !== marker) return { ok: false, backend, detail: "写入后读回不一致" };
      return { ok: true, backend, detail: "可非交互读写（-w），适合 24/7 无人值守" };
    } finally {
      try {
        await this.delete(probeKey);
      } catch {
        /* 清理失败不影响结论 */
      }
    }
  }
}

/** 未实现平台的显式占位：宁可明确失败，也不要静默把凭据写到别处 */
export class UnsupportedSecretStore implements SecretStore {
  readonly #platform: string;
  constructor(platform: string) {
    this.#platform = platform;
  }
  #fail(): never {
    throw new SecretUnavailableError(`平台 ${this.#platform} 的凭据存储尚未实现（计划 M8）`);
  }
  async set(): Promise<void> {
    this.#fail();
  }
  async get(): Promise<string | null> {
    this.#fail();
  }
  async delete(): Promise<void> {
    this.#fail();
  }
  async list(): Promise<string[]> {
    this.#fail();
  }
  async available(): Promise<SecretAvailability> {
    return {
      ok: false,
      backend: "unsupported-platform",
      detail: `平台 ${this.#platform} 尚未实现（计划 M8）`,
    };
  }
}

/** 平台分发：目前仅 macOS 有实现（Windows/Linux 在 M8） */
export function createSecretStore(opts: { service: string; platform?: NodeJS.Platform }): SecretStore {
  const platform = opts.platform ?? process.platform;
  if (platform === "darwin") return new MacOsKeychain({ service: opts.service });
  return new UnsupportedSecretStore(platform);
}
