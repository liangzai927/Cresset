/**
 * SystemMonitor 测试：固定采集器下的字段计算与失败可见。
 */

import { VirtualClock } from "@aegis/clock";
import { describe, expect, it } from "vitest";
import { SystemMonitor } from "./system-monitor.js";

const GB = 1024 ** 3;

describe("SystemMonitor", () => {
  it("把采集值转成 Skill 可用的百分比/GB 字段", async () => {
    const monitor = new SystemMonitor({
      clock: new VirtualClock(1_000),
      collectors: {
        loadavg: () => [1.5, 1.0, 0.5],
        memory: () => ({ totalBytes: 16 * GB, freeBytes: 4 * GB }),
        disk: () => ({ totalBytes: 100 * GB, freeBytes: 8 * GB }),
        uptime: () => 3_600,
        cpuCount: () => 8,
      },
    });

    const result = await monitor.scan();
    expect(result.errors).toEqual([]);
    expect(result.facts).toHaveLength(1);
    expect(result.facts[0]?.kind).toBe("system.threshold");
    expect(result.facts[0]?.fields).toMatchObject({
      load1: 1.5,
      memory_free_percent: 25,
      memory_free_gb: 4,
      disk_free_percent: 8,
      disk_free_gb: 8,
      cpu_count: 8,
      uptime_s: 3_600,
    });
  });

  it("采集失败进入 errors，而不是伪造 0 值", async () => {
    const monitor = new SystemMonitor({
      collectors: {
        disk: () => {
          throw new Error("statfs failed");
        },
      },
    });
    const result = await monitor.scan();
    expect(result.facts).toEqual([]);
    expect(result.errors[0]?.message).toContain("statfs failed");
  });
});
