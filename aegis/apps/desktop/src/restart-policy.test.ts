/**
 * 重启退避策略测试
 *
 * 这里验证的不是"函数返回了一个数"，而是 NFR-R2 的时间线：
 * 前三次崩溃是否都在 10 秒内、稳定运行后是否重新从 2 秒开始、
 * 连续失败一百次后是否仍在重试（而不是静默放弃）。
 *
 * 时钟用 `VirtualClock` 推进，不真等。
 */

import { VirtualClock } from "@aegis/clock";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_RESTART_MAX_MS,
  RESTART_DEADLINE_MS,
  RestartPolicy,
  type RestartPolicyOptions,
} from "./restart-policy.js";

/** 按虚拟时间推进的便捷封装：模拟一次"拉起 → 运行 → 退出" */
function crashAfter(
  policy: RestartPolicy,
  clock: VirtualClock,
  runForMs: number,
): ReturnType<RestartPolicy["planAfterExit"]> {
  policy.markStarted(clock.wall());
  clock.jumpWall(runForMs);
  return policy.planAfterExit(clock.wall());
}

describe("RestartPolicy 退避时间线", () => {
  it("连续快速崩溃按 2/4/8 秒退避，之后保持 8 秒上限", () => {
    const clock = new VirtualClock();
    const policy = new RestartPolicy();

    expect(crashAfter(policy, clock, 100).delayMs).toBe(2_000);
    expect(crashAfter(policy, clock, 100).delayMs).toBe(4_000);
    expect(crashAfter(policy, clock, 100).delayMs).toBe(8_000);
    expect(crashAfter(policy, clock, 100).delayMs).toBe(8_000);
    expect(crashAfter(policy, clock, 100).delayMs).toBe(8_000);
  });

  it("★ 每次退避都不超过 NFR-R2 的 10 秒", () => {
    const clock = new VirtualClock();
    const policy = new RestartPolicy();

    for (let i = 0; i < 20; i += 1) {
      const plan = crashAfter(policy, clock, 50);
      expect(plan.delayMs).toBeLessThanOrEqual(RESTART_DEADLINE_MS);
    }
  });

  it("★ 连续失败 100 次后仍在重试，没有「放弃」分支", () => {
    const clock = new VirtualClock();
    const policy = new RestartPolicy();

    let plan = crashAfter(policy, clock, 10);
    for (let i = 1; i < 100; i += 1) {
      plan = crashAfter(policy, clock, 10);
    }

    expect(plan.attempt).toBe(100);
    expect(plan.delayMs).toBe(DEFAULT_RESTART_MAX_MS);
    expect(policy.consecutiveFailures).toBe(100);
  });

  it("★ 稳定运行 60 秒后崩溃，重新从 2 秒开始（失败计数被重置）", () => {
    const clock = new VirtualClock();
    const policy = new RestartPolicy();

    expect(crashAfter(policy, clock, 100)).toMatchObject({ attempt: 1, delayMs: 2_000 });
    expect(crashAfter(policy, clock, 100)).toMatchObject({ attempt: 2, delayMs: 4_000 });

    // 第三次拉起后稳定运行满 60 秒再崩溃 —— 应被视为一次新的故障
    const plan = crashAfter(policy, clock, 60_000);
    expect(plan).toMatchObject({ attempt: 1, delayMs: 2_000 });
    expect(policy.consecutiveFailures).toBe(1);
  });

  it("稳定阈值差 1 毫秒就不重置（边界）", () => {
    const clock = new VirtualClock();
    const policy = new RestartPolicy({ stableAfterMs: 60_000 });

    expect(crashAfter(policy, clock, 100)).toMatchObject({ attempt: 1 });
    expect(crashAfter(policy, clock, 59_999)).toMatchObject({ attempt: 2, delayMs: 4_000 });
  });

  it("未调用 markStarted 时按「启动即退出」计数", () => {
    const policy = new RestartPolicy();
    expect(policy.planAfterExit(1_000)).toMatchObject({ attempt: 1, delayMs: 2_000 });
    expect(policy.consecutiveFailures).toBe(1);
  });
});

describe("RestartPolicy 参数校验", () => {
  it("允许自定义退避序列", () => {
    const clock = new VirtualClock();
    const policy = new RestartPolicy({ baseDelayMs: 500, maxDelayMs: 1_000 });
    expect(crashAfter(policy, clock, 0).delayMs).toBe(500);
    expect(crashAfter(policy, clock, 0).delayMs).toBe(1_000);
    expect(crashAfter(policy, clock, 0).delayMs).toBe(1_000);
  });

  it("拒绝超过 NFR-R2 上限的配置（避免配置层破坏承诺）", () => {
    expect(() => new RestartPolicy({ maxDelayMs: RESTART_DEADLINE_MS + 1 })).toThrow(RangeError);
  });

  it("拒绝非法的 base / max / stableAfter", () => {
    const invalid: RestartPolicyOptions[] = [
      { baseDelayMs: 0 },
      { baseDelayMs: -1 },
      { baseDelayMs: 2_000, maxDelayMs: 1_000 },
      { stableAfterMs: -1 },
    ];
    for (const opts of invalid) {
      expect(() => new RestartPolicy(opts)).toThrow(RangeError);
    }
  });

  it("默认退避上限严格小于 10 秒，给进程启动留余量", () => {
    expect(DEFAULT_RESTART_MAX_MS).toBeLessThan(RESTART_DEADLINE_MS);
  });
});
