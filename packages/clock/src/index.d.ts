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
export declare class SystemClock implements Clock {
    wall(): EpochMs;
    monotonic(): MonoMs;
    setTimer(delayMs: number, cb: () => void): Unsubscribe;
    setInterval(intervalMs: number, cb: () => void): Unsubscribe;
    sleep(ms: number): Promise<void>;
}
/**
 * 虚拟时钟：测试专用。
 * - 时间只在显式 advance() 时前进（定时器按到期顺序触发）
 * - sleep() 自动推进虚拟时间，因此长任务测试是同步快跑
 * - 支持 jumpWall()：只改墙钟不改单调钟 → 用于模拟 NTP 校正 / 用户改时间
 * - 支持 suspend()：只改两个钟的差值 → 用于模拟系统休眠（mono 不前进）
 */
export declare class VirtualClock implements Clock {
    #private;
    constructor(startWall?: EpochMs);
    wall(): EpochMs;
    monotonic(): MonoMs;
    setTimer(delayMs: number, cb: () => void): Unsubscribe;
    setInterval(intervalMs: number, cb: () => void): Unsubscribe;
    /** 推进虚拟时间：先让等待中的 promise 有机会注册定时器，再按到期顺序触发 */
    advance(ms: number): Promise<void>;
    sleep(ms: number): Promise<void>;
    /** 系统休眠：墙钟前进但单调钟不前进（这正是 daemon 判定"我睡过"的依据） */
    suspend(wallMs: number): void;
    /** NTP 校正 / 用户改时间：只改墙钟 */
    jumpWall(deltaMs: number): void;
    /** 测试断言用：仍在等待的定时器数量（泄漏检测） */
    pendingTimers(): number;
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
export declare function detectSkew(before: {
    wall: EpochMs;
    mono: MonoMs;
}, after: {
    wall: EpochMs;
    mono: MonoMs;
}, thresholdMs?: number): SkewReport;
//# sourceMappingURL=index.d.ts.map