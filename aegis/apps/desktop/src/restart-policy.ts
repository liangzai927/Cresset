/**
 * 崩溃重启退避策略 —— NFR-R2（崩溃自恢复）的纯逻辑部分
 *
 * ## 为什么单独抽出来
 *
 * 重启时序是本项目最容易"看起来在工作"的逻辑：退避算错、连续失败计数忘了
 * 重置、或者在若干次失败后悄悄放弃，单测都很难从真实进程行为里观察出来。
 * 因此把"下一次隔多久重启"做成不依赖进程、时钟与 Electron 的状态机，
 * 用虚拟时钟把整条时间线跑一遍。
 *
 * ## 三条硬约束
 *
 * 1. **10 秒内重启**（NFR-R2）：退避上限不得超过 {@link RESTART_DEADLINE_MS}，
 *    默认 8 秒，给进程启动留 2 秒余量。
 * 2. **稳定后重置**：连续运行超过 {@link DEFAULT_STABLE_AFTER_MS} 再崩溃，
 *    重新从 2 秒开始退避。否则"几个月里偶发三次崩溃"会被误判为崩溃循环。
 * 3. **永不放弃**：超过快速重试阶段后仍按上限持续重试，返回的计划里没有
 *    "giveUp" 这种状态 —— 24/7 的产品里，"放弃重启"等于静默死亡。
 */

/** NFR-R2：异常退出后必须在 10 秒内重启 */
export const RESTART_DEADLINE_MS = 10_000;

/** 默认首次退避：2 秒 */
export const DEFAULT_RESTART_BASE_MS = 2_000;

/** 默认退避上限：8 秒（留 2 秒余量满足 NFR-R2） */
export const DEFAULT_RESTART_MAX_MS = 8_000;

/** 默认稳定阈值：连续运行 60 秒后，下一次崩溃重新从最短退避开始 */
export const DEFAULT_STABLE_AFTER_MS = 60_000;

/** 一次重启计划 */
export interface RestartPlan {
  /** 距本次退出多久后重启（毫秒） */
  delayMs: number;
  /** 连续失败序号（从 1 开始；稳定运行后重置） */
  attempt: number;
}

/** 重启策略的构造参数；全部有默认值 */
export interface RestartPolicyOptions {
  /** 首次退避（毫秒），默认 {@link DEFAULT_RESTART_BASE_MS} */
  baseDelayMs?: number;
  /** 退避上限（毫秒），默认 {@link DEFAULT_RESTART_MAX_MS}，不得超过 10 秒 */
  maxDelayMs?: number;
  /** 连续运行多久视为稳定（毫秒），默认 {@link DEFAULT_STABLE_AFTER_MS} */
  stableAfterMs?: number;
}

/**
 * 崩溃重启退避状态机（纯逻辑，不读时钟、不碰进程）。
 *
 * 调用顺序：
 *   1. 每次真正拉起进程时 `markStarted(now)`；
 *   2. 进程退出时 `planAfterExit(now)` 拿到下一次重启计划；
 *   3. 按 `delayMs` 安排定时器，触发后重新拉起进程。
 */
export class RestartPolicy {
  readonly #baseDelayMs: number;
  readonly #maxDelayMs: number;
  readonly #stableAfterMs: number;
  #consecutiveFailures = 0;
  #startedAt: number | null = null;

  constructor(opts: RestartPolicyOptions = {}) {
    const base = opts.baseDelayMs ?? DEFAULT_RESTART_BASE_MS;
    const max = opts.maxDelayMs ?? DEFAULT_RESTART_MAX_MS;
    const stable = opts.stableAfterMs ?? DEFAULT_STABLE_AFTER_MS;

    if (base <= 0) throw new RangeError(`restartBaseMs 必须大于 0（收到 ${base}）`);
    if (max < base) throw new RangeError(`restartMaxMs 不能小于 restartBaseMs（${max} < ${base}）`);
    if (max > RESTART_DEADLINE_MS) {
      throw new RangeError(
        `restartMaxMs 不能超过 NFR-R2 的 ${RESTART_DEADLINE_MS}ms（收到 ${max}）—— ` +
          "否则异常退出后无法在 10 秒内重启",
      );
    }
    if (stable < 0) throw new RangeError(`stableAfterMs 不能为负数（收到 ${stable}）`);

    this.#baseDelayMs = base;
    this.#maxDelayMs = max;
    this.#stableAfterMs = stable;
  }

  /** 当前连续失败次数（稳定运行后会归零；供诊断与测试断言） */
  get consecutiveFailures(): number {
    return this.#consecutiveFailures;
  }

  /** 记录一次进程启动时刻；未调用时按"刚启动就退出"处理 */
  markStarted(at: number): void {
    this.#startedAt = at;
  }

  /**
   * 记录一次异常退出，返回下一次重启计划。
   *
   * 永远不会返回"不重启"：连续失败只影响退避时长，不影响是否继续尝试。
   * 若本次运行时长达到稳定阈值，会先清零连续失败计数。
   *
   * @param at 退出时刻（由注入的 Clock 提供）
   */
  planAfterExit(at: number): RestartPlan {
    if (this.#startedAt !== null && at - this.#startedAt >= this.#stableAfterMs) {
      this.#consecutiveFailures = 0;
    }

    this.#consecutiveFailures += 1;
    this.#startedAt = null;

    // 2 的幂增长；封顶后一直保持上限。指数上限 16 只是为了防止
    // 连续失败几万次时算出 Infinity，实际上远在上限处就被 Math.min 截断。
    const exponent = Math.min(this.#consecutiveFailures - 1, 16);
    const delayMs = Math.min(this.#maxDelayMs, this.#baseDelayMs * 2 ** exponent);
    return { delayMs, attempt: this.#consecutiveFailures };
  }
}
