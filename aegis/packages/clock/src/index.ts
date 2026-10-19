/**
 * Clock 抽象 —— NFR-M1（可测试性）的基石。
 *
 * ⚠️ 全仓库只允许本包直接使用 Date.now() / new Date() / setTimeout。
 *    其他包一律通过注入的 Clock 获取时间与定时器，否则"30 天运行 / 休眠恢复 /
 *    跨时区 / 跨夏令时"这些场景只能靠真等，无法自动化验证。
 *
 * 双时钟设计（见《M0+M1 详细设计》§3 第 6 步）：
 *   - wall()      墙钟：会被 NTP 校正、用户改时间、系统休眠影响
 *   - monotonic() 单调钟：只增不减，不受改时间影响
 *   两者差值异常 → 判定发生了 睡眠/挂起/改时间，据此触发补偿扫描。
 */

/** 墙钟毫秒（UTC） */
export type EpochMs = number;
/** 单调毫秒（进程内，从某个不确定的原点起算，只保证单调） */
export type MonoMs = number;

/** 取消订阅：调用后定时器/监听器不再触发 */
export type Unsubscribe = () => void;

/**
 * 时间与定时器抽象 —— NFR-M1（可测试性）的基石。
 *
 * 铁律：**业务代码禁止直接使用 Date.now() / new Date() / setTimeout**，
 * 一律通过注入的 Clock 获取。否则"30 天不漏报""休眠 8 小时后补偿"这类
 * 场景只能真等，无法自动化验证。
 */
export interface Clock {
  /** 墙钟：UTC 毫秒。对应 Date.now() */
  wall(): EpochMs;
  /** 单调钟：毫秒，只增不减。对应 performance.now() 的取整 */
  monotonic(): MonoMs;
  /** 安排一次性定时器；返回取消函数 */
  setTimer(delayMs: number, cb: () => void): Unsubscribe;
  /** 周期性定时器；返回取消函数 */
  setInterval(intervalMs: number, cb: () => void): Unsubscribe;
  /** 让出事件循环（测试中同步返回，避免真实等待） */
  sleep(ms: number): Promise<void>;
}

/** 系统时钟：生产环境唯一允许的实现 */
export class SystemClock implements Clock {
  wall(): EpochMs {
    return Date.now();
  }

  monotonic(): MonoMs {
    return Math.round(performance.now());
  }

  setTimer(delayMs: number, cb: () => void): Unsubscribe {
    const handle = setTimeout(cb, Math.max(0, delayMs));
    // 定时器不应阻止进程退出（daemon 靠 tick 与信号控制生命周期）
    handle.unref?.();
    return () => clearTimeout(handle);
  }

  setInterval(intervalMs: number, cb: () => void): Unsubscribe {
    const handle = setInterval(cb, Math.max(1, intervalMs));
    handle.unref?.();
    return () => clearInterval(handle);
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const handle = setTimeout(resolve, Math.max(0, ms));
      handle.unref?.();
    });
  }
}

/**
 * 虚拟时钟：测试专用。
 * - 时间只在显式 advance() 时前进（定时器按到期顺序触发）
 * - sleep() 自动推进虚拟时间，因此长任务测试是同步快跑
 * - 支持 jumpWall()：只改墙钟不改单调钟 → 用于模拟 NTP 校正 / 用户改时间
 * - 支持 suspend()：只改两个钟的差值 → 用于模拟系统休眠（mono 不前进）
 */
export class VirtualClock implements Clock {
  #wall: EpochMs;
  #mono: MonoMs;
  #timers: Array<{ id: number; at: MonoMs; cb: () => void; intervalMs?: number }> = [];
  #nextId = 1;

  constructor(startWall: EpochMs = Date.parse("2026-02-19T00:00:00.000Z")) {
    this.#wall = startWall;
    this.#mono = 0;
  }

  wall(): EpochMs {
    return this.#wall;
  }

  monotonic(): MonoMs {
    return this.#mono;
  }

  setTimer(delayMs: number, cb: () => void): Unsubscribe {
    const id = this.#nextId++;
    this.#timers.push({ id, at: this.#mono + Math.max(0, delayMs), cb });
    return () => {
      this.#timers = this.#timers.filter((t) => t.id !== id);
    };
  }

  setInterval(intervalMs: number, cb: () => void): Unsubscribe {
    const id = this.#nextId++;
    const step = Math.max(1, intervalMs);
    this.#timers.push({ id, at: this.#mono + step, cb, intervalMs: step });
    return () => {
      this.#timers = this.#timers.filter((t) => t.id !== id);
    };
  }

  /** 推进虚拟时间：先让等待中的 promise 有机会注册定时器，再按到期顺序触发 */
  async advance(ms: number): Promise<void> {
    const target = this.#mono + Math.max(0, ms);
    // 反复：让微任务清空 → 触发所有已到期的定时器 → 再看是否还有更早的
    for (;;) {
      await Promise.resolve();
      const due = this.#timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at || a.id - b.id);
      const next = due[0];
      if (!next) break;
      // 时间先走到该定时器的到期点
      const delta = next.at - this.#mono;
      this.#mono = next.at;
      this.#wall += delta;
      if (next.intervalMs === undefined) {
        this.#timers = this.#timers.filter((t) => t.id !== next.id);
      } else {
        next.at = this.#mono + next.intervalMs;
      }
      next.cb();
      await Promise.resolve();
    }
    // 走完剩余时间
    const rest = target - this.#mono;
    if (rest > 0) {
      this.#mono = target;
      this.#wall += rest;
    }
    await Promise.resolve();
  }

  async sleep(ms: number): Promise<void> {
    await this.advance(ms);
  }

  /** 系统休眠：墙钟前进但单调钟不前进（这正是 daemon 判定"我睡过"的依据） */
  suspend(wallMs: number): void {
    this.#wall += wallMs;
  }

  /** NTP 校正 / 用户改时间：只改墙钟 */
  jumpWall(deltaMs: number): void {
    this.#wall += deltaMs;
  }

  /** 测试断言用：仍在等待的定时器数量（泄漏检测） */
  pendingTimers(): number {
    return this.#timers.length;
  }
}

/**
 * 挂起检测：比较墙钟与单调钟的推进量，判定是否发生睡眠/挂起/改时间。
 * 这是《M0+M1 详细设计》§3 第 6 步与 §6.5 D 的实现基础。
 */
export interface SkewReport {
  wallDelta: number;
  monoDelta: number;
  /** |wallDelta - monoDelta| 超过该阈值即判为异常 */
  skewMs: number;
  kind: "none" | "suspended" | "wall_jumped";
}

/**
 * 判定两个时刻之间是否发生了"进程没在跑"或"墙钟被改"。
 *
 * 这是补偿逻辑的触发依据：睡眠恢复后 setTimeout 不会补发，定时器漂移也无法自证，
 * 只有比较墙钟与单调钟的推进量才能可靠判定。
 *
 * @param before 之前采样的双时钟快照
 * @param after 当前的双时钟快照
 * @param thresholdMs 判定阈值；超过即认为异常（默认 60 秒）
 * @returns kind='suspended' 表示墙钟多走（睡眠/挂起），'wall_jumped' 表示墙钟被回拨
 */
export function detectSkew(
  before: { wall: EpochMs; mono: MonoMs },
  after: { wall: EpochMs; mono: MonoMs },
  thresholdMs = 60_000,
): SkewReport {
  const wallDelta = after.wall - before.wall;
  const monoDelta = after.mono - before.mono;
  const skewMs = wallDelta - monoDelta;
  let kind: SkewReport["kind"] = "none";
  if (Math.abs(skewMs) > thresholdMs) {
    // 墙钟比单调钟走得多 → 期间进程没在跑（休眠/挂起/关机）
    kind = skewMs > 0 ? "suspended" : "wall_jumped";
  }
  return { wallDelta, monoDelta, skewMs, kind };
}
