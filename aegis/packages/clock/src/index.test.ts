/**
 * Clock 与虚拟时钟的测试。
 *
 * 重点覆盖：定时器到期顺序、取消、休眠/改时间的判定语义（detectSkew），
 * 以及 SystemClock 的空闲定时器不阻止进程退出。
 */
import { describe, expect, it } from "vitest";
import { detectSkew, SystemClock, VirtualClock } from "./index.js";

describe("VirtualClock（虚拟时钟）", () => {
  it("初始时间与单调钟从 0 起算", () => {
    const c = new VirtualClock(Date.parse("2026-02-19T00:00:00.000Z"));
    expect(c.wall()).toBe(Date.parse("2026-02-19T00:00:00.000Z"));
    expect(c.monotonic()).toBe(0);
  });

  it("advance 同步推进墙钟与单调钟", async () => {
    const c = new VirtualClock();
    const t0 = c.wall();
    await c.advance(60_000);
    expect(c.wall() - t0).toBe(60_000);
    expect(c.monotonic()).toBe(60_000);
  });

  it("定时器在正确时刻触发，且不被提前触发", async () => {
    const c = new VirtualClock();
    const fired: number[] = [];
    c.setTimer(5_000, () => fired.push(c.monotonic()));
    await c.advance(4_999);
    expect(fired).toEqual([]);
    await c.advance(1);
    expect(fired).toEqual([5_000]);
  });

  it("多个定时器按到期顺序触发（同一时刻按注册顺序）", async () => {
    const c = new VirtualClock();
    const order: string[] = [];
    c.setTimer(300, () => order.push("c"));
    c.setTimer(100, () => order.push("a"));
    c.setTimer(100, () => order.push("b"));
    await c.advance(1_000);
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("周期定时器反复触发", async () => {
    const c = new VirtualClock();
    let n = 0;
    const stop = c.setInterval(1_000, () => {
      n += 1;
    });
    await c.advance(3_500);
    expect(n).toBe(3);
    stop();
    await c.advance(5_000);
    expect(n).toBe(3);
  });

  it("取消的定时器不再触发，且不泄漏", async () => {
    const c = new VirtualClock();
    let fired = 0;
    const cancel = c.setTimer(1_000, () => {
      fired += 1;
    });
    cancel();
    await c.advance(10_000);
    expect(fired).toBe(0);
    expect(c.pendingTimers()).toBe(0);
  });

  it("sleep 自动推进虚拟时间（长任务可秒级跑完）", async () => {
    const c = new VirtualClock();
    const t0 = c.wall();
    await c.sleep(24 * 3600 * 1000); // 模拟一整天
    expect(c.wall() - t0).toBe(24 * 3600 * 1000);
  });
});

describe("休眠与改时间语义（补偿逻辑的依据）", () => {
  it("suspend：墙钟前进而单调钟不动 → 判定为休眠", async () => {
    const c = new VirtualClock();
    const before = { wall: c.wall(), mono: c.monotonic() };
    c.suspend(8 * 3600 * 1000); // 合盖 8 小时
    const after = { wall: c.wall(), mono: c.monotonic() };
    const skew = detectSkew(before, after);
    expect(skew.wallDelta).toBe(8 * 3600 * 1000);
    expect(skew.monoDelta).toBe(0);
    expect(skew.kind).toBe("suspended");
  });

  it("jumpWall：回拨墙钟 → 判定为改时间（不是休眠）", () => {
    const c = new VirtualClock();
    const before = { wall: c.wall(), mono: c.monotonic() };
    c.jumpWall(-3 * 3600 * 1000);
    const after = { wall: c.wall(), mono: c.monotonic() };
    const skew = detectSkew(before, after);
    expect(skew.kind).toBe("wall_jumped");
  });

  it("正常推进不误报", async () => {
    const c = new VirtualClock();
    const before = { wall: c.wall(), mono: c.monotonic() };
    await c.advance(30_000);
    const skew = detectSkew(before, { wall: c.wall(), mono: c.monotonic() });
    expect(skew.kind).toBe("none");
  });

  it("阈值可调：小于阈值的小漂移不算异常", () => {
    const before = { wall: 0, mono: 0 };
    const after = { wall: 5_000, mono: 4_000 };
    expect(detectSkew(before, after, 60_000).kind).toBe("none");
    expect(detectSkew(before, after, 100).kind).toBe("suspended");
  });
});

describe("SystemClock（生产实现）", () => {
  it("墙钟接近真实时间，单调钟只增不减", () => {
    const c = new SystemClock();
    const t0 = c.monotonic();
    expect(Math.abs(c.wall() - Date.now())).toBeLessThan(1_000);
    expect(c.monotonic()).toBeGreaterThanOrEqual(t0);
  });

  it("定时器可取消", async () => {
    const c = new SystemClock();
    let fired = false;
    const cancel = c.setTimer(50, () => {
      fired = true;
    });
    cancel();
    await new Promise((r) => setTimeout(r, 80));
    expect(fired).toBe(false);
  });
});
