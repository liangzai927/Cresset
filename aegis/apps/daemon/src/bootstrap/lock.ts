/**
 * 单实例锁（《M0+M1 详细设计》§3 第 2 步）
 *
 * 为什么不能用"文件是否存在"来判断：
 *   崩溃/强杀会留下陈旧锁文件 —— 若据此拒绝启动，用户重启后就再也起不来了。
 * 因此采用 **O_EXCL 创建 + pid 存活探测**：
 *   - 创建成功 → 拿到锁
 *   - 已存在 → 读其中的 pid，用 signal 0 探活：
 *       · 进程仍活着 → 说明真有一个实例在跑，本次应退出（退出码 0，不是错误）
 *       · 进程已死 → 陈旧锁，清理后重新抢锁（并记录一条审计）
 */
import { closeSync, constants, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** 锁文件内容；`note` 便于人工核对是谁拿的锁 */
export interface LockInfo {
  pid: number;
  startedAt: number;
  /** 便于人工核对是谁拿的锁（如 daemon 版本、命令行） */
  note?: string;
}

/** 抢锁结果；`staleRecovered` 非空表示回收了一个陈旧锁（进程已死或内容损坏） */
export type AcquireResult =
  | { acquired: true; info: LockInfo; staleRecovered: null }
  | { acquired: true; info: LockInfo; staleRecovered: LockInfo }
  | { acquired: false; holder: LockInfo | null; reason: "held" | "error"; detail: string };

/** 探测进程是否存活。signal 0 不发送信号，仅做权限与存在性检查。 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = 进程存在但不属于当前用户（仍算存活）
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM") return true;
    return false;
  }
}

/**
 * 单实例锁。
 *
 * 为什么不用"文件是否存在"判断：崩溃/强杀会留下陈旧锁文件，
 * 若据此拒绝启动，用户重启后就再也起不来。因此采用
 * **O_EXCL 创建 + pid 存活探测**：进程活着才拒绝，否则清理后重新抢锁。
 */
export class DaemonLock {
  readonly #path: string;
  #acquired = false;

  constructor(path: string) {
    this.#path = path;
  }

  get path(): string {
    return this.#path;
  }

  /**
   * 尝试获取锁。
   * @param note 写入锁文件的备注（便于诊断）
   */
  acquire(note?: string, now: () => number = Date.now): AcquireResult {
    const info: LockInfo = { pid: process.pid, startedAt: now(), ...(note ? { note } : {}) };

    const write = (): boolean => {
      try {
        mkdirSync(dirname(this.#path), { recursive: true });
        // wx = O_CREAT | O_EXCL：已存在则抛 EEXIST，避免"检查后写入"的竞态
        const fd = openSync(this.#path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
        try {
          writeFileSync(fd, `${JSON.stringify(info)}\n`);
        } finally {
          closeSync(fd);
        }
        this.#acquired = true;
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
        throw err;
      }
    };

    if (write()) return { acquired: true, info, staleRecovered: null };

    // 已存在：读出来探活
    let holder: LockInfo | null = null;
    try {
      holder = JSON.parse(readFileSync(this.#path, "utf8")) as LockInfo;
    } catch {
      holder = null; // 内容损坏 → 视为陈旧
    }

    if (holder && isProcessAlive(holder.pid)) {
      return { acquired: false, holder, reason: "held", detail: `已有实例在运行（pid=${holder.pid}）` };
    }

    // 陈旧锁：清理后重试一次。
    // 内容损坏（holder === null）同样属于陈旧锁 —— 锁文件存在但 pid 不可解析，
    // 必须回收，否则用户会遇到"明明没有实例在跑却起不来"。
    const stale: LockInfo = holder ?? { pid: -1, startedAt: 0, note: "corrupted lock file" };
    try {
      unlinkSync(this.#path);
    } catch {
      /* 可能已被其他进程清理 */
    }
    if (write()) return { acquired: true, info, staleRecovered: stale };

    // 二次失败：很可能另一个进程同时在抢
    let newHolder: LockInfo | null = null;
    try {
      newHolder = JSON.parse(readFileSync(this.#path, "utf8")) as LockInfo;
    } catch {
      newHolder = null;
    }
    return {
      acquired: false,
      holder: newHolder,
      reason: "held",
      detail: "清理陈旧锁后仍被其他进程抢占（可能是并发启动）",
    };
  }

  /** 释放锁（仅当本进程持有） */
  release(): void {
    if (!this.#acquired) return;
    try {
      unlinkSync(this.#path);
    } catch {
      /* 已被清理 */
    }
    this.#acquired = false;
  }

  get held(): boolean {
    return this.#acquired;
  }
}
