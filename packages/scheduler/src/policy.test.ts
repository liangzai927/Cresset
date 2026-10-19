/**
 * 调度策略测试（纯函数）—— 边界条件的集中验证点
 *
 * 这些判断一旦出错，表现是"半夜被吵醒"或"该提醒的没提醒"，都是用户直接可感的。
 * 因此它们被抽成纯函数，用精确断言覆盖边界（含跨午夜、周五→周六、优先级穿透）。
 */

import { describe, expect, it } from "vitest";
import {
  buildCatchupSummary,
  CATCHUP_MERGE_THRESHOLD,
  DND_BREAKTHROUGH_PRIORITIES,
  type DndSettings,
  dndEndsAt,
  isWithinCatchupWindow,
  isWithinDnd,
  minuteOfDay,
  parseHhMm,
  shouldDeferForDnd,
  shouldFallbackToNextChannel,
  shouldMergeCatchup,
} from "./policy.js";

describe("时间工具", () => {
  it("minuteOfDay 换算", () => {
    expect(minuteOfDay(0, 0)).toBe(0);
    expect(minuteOfDay(9, 30)).toBe(570);
    expect(minuteOfDay(23, 59)).toBe(1439);
  });

  it("parseHhMm 解析与拒绝非法值", () => {
    expect(parseHhMm("09:30")).toBe(570);
    expect(parseHhMm("9:05")).toBe(545); // 允许单位数小时
    expect(parseHhMm("22:00")).toBe(1320);
    expect(parseHhMm("24:00")).toBeNull();
    expect(parseHhMm("12:60")).toBeNull();
    expect(parseHhMm("随便")).toBeNull();
  });
});

describe("补偿窗口（FR-A3）", () => {
  const HOUR = 3_600_000;
  const window12h = 12 * 3600;

  it("窗口内可以补发", () => {
    const scheduled = 1_000_000;
    expect(isWithinCatchupWindow(scheduled, scheduled + 3600_000, window12h)).toBe(true);
    expect(isWithinCatchupWindow(scheduled, scheduled + 12 * HOUR, window12h)).toBe(true); // 边界含
  });

  it("超出窗口不再补发（避免半夜弹一堆旧提醒）", () => {
    const scheduled = 1_000_000;
    expect(isWithinCatchupWindow(scheduled, scheduled + 12 * HOUR + 1, window12h)).toBe(false);
    expect(isWithinCatchupWindow(scheduled, scheduled + 20 * HOUR, window12h)).toBe(false);
  });

  it("窗口为 0 表示不允许补偿（一次性立即型任务）", () => {
    expect(isWithinCatchupWindow(1_000, 1_000, 0)).toBe(false);
    expect(isWithinCatchupWindow(1_000, 1_000, -1)).toBe(false);
  });

  it("尚未到期的实例总是在窗口内（提前派发也安全）", () => {
    // scheduled 在未来 → scheduled + window >= now 必然成立
    expect(isWithinCatchupWindow(5_000_000, 1_000_000, window12h)).toBe(true);
  });
});

describe("免打扰：同日窗口", () => {
  const settings: DndSettings = {
    enabled: true,
    windows: [{ days: [1, 2, 3, 4, 5, 6, 7], from: "22:00", to: "23:30" }],
  };

  it("窗口内命中", () => {
    expect(isWithinDnd({ hour: 22, minute: 0 }, 3, settings)).toBe(true); // 边界含起点
    expect(isWithinDnd({ hour: 23, minute: 0 }, 3, settings)).toBe(true);
  });

  it("窗口外不命中（终点不含）", () => {
    expect(isWithinDnd({ hour: 21, minute: 59 }, 3, settings)).toBe(false);
    expect(isWithinDnd({ hour: 23, minute: 30 }, 3, settings)).toBe(false);
  });

  it("未指定的星期不命中", () => {
    const onlyMonday: DndSettings = { enabled: true, windows: [{ days: [1], from: "22:00", to: "23:30" }] };
    expect(isWithinDnd({ hour: 22, minute: 30 }, 1, onlyMonday)).toBe(true);
    expect(isWithinDnd({ hour: 22, minute: 30 }, 2, onlyMonday)).toBe(false);
  });
});

describe("★ 免打扰：跨午夜窗口（最容易写错的地方）", () => {
  // 22:00 → 08:00，仅周一：意味着"周一晚 22 点开始的这一夜"
  const settings: DndSettings = { enabled: true, windows: [{ days: [1], from: "22:00", to: "08:00" }] };

  it("周一 22:00 命中", () => {
    expect(isWithinDnd({ hour: 22, minute: 0 }, 1, settings)).toBe(true);
  });

  it("周一 23:59 命中", () => {
    expect(isWithinDnd({ hour: 23, minute: 59 }, 1, settings)).toBe(true);
  });

  it("★ 周二凌晨 3 点仍命中（属于周一那一夜）", () => {
    expect(isWithinDnd({ hour: 3, minute: 0 }, 2, settings)).toBe(true);
  });

  it("周二 08:00 不再命中（终点不含）", () => {
    expect(isWithinDnd({ hour: 8, minute: 0 }, 2, settings)).toBe(false);
  });

  it("周二 21:00 不命中", () => {
    expect(isWithinDnd({ hour: 21, minute: 0 }, 2, settings)).toBe(false);
  });

  it("★ 参数顺序陷阱：周五窗口不延伸到周日（星期回卷只在相邻日）", () => {
    const friday: DndSettings = { enabled: true, windows: [{ days: [5], from: "23:00", to: "07:00" }] };
    expect(isWithinDnd({ hour: 2, minute: 0 }, 6, friday)).toBe(true); // 周六凌晨属于周五夜
    expect(isWithinDnd({ hour: 2, minute: 0 }, 7, friday)).toBe(false); // 周日凌晨不属于
  });

  it("禁用时不命中", () => {
    const off: DndSettings = { ...settings, enabled: false };
    expect(isWithinDnd({ hour: 23, minute: 0 }, 1, off)).toBe(false);
  });

  it("非法时间配置被跳过，不阻断调度", () => {
    const broken: DndSettings = { enabled: true, windows: [{ days: [1], from: "乱写", to: "08:00" }] };
    expect(isWithinDnd({ hour: 23, minute: 0 }, 1, broken)).toBe(false);
  });

  it("多窗口叠加", () => {
    const multi: DndSettings = {
      enabled: true,
      windows: [
        { days: [1, 2, 3, 4, 5], from: "12:00", to: "13:00" }, // 午休
        { days: [1, 2, 3, 4, 5, 6, 7], from: "23:00", to: "07:00" }, // 夜间
      ],
    };
    expect(isWithinDnd({ hour: 12, minute: 30 }, 3, multi)).toBe(true);
    expect(isWithinDnd({ hour: 3, minute: 0 }, 3, multi)).toBe(true);
    expect(isWithinDnd({ hour: 15, minute: 0 }, 3, multi)).toBe(false);
  });
});

describe("dndEndsAt：计算 DND 结束时刻", () => {
  const settings: DndSettings = {
    enabled: true,
    windows: [{ days: [1, 2, 3, 4, 5, 6, 7], from: "22:00", to: "08:00" }],
  };

  /** 假的墙钟换算器：把 UTC 毫秒当成"本地时间"，便于构造精确用例 */
  const fakeWall = (epochMs: number) => {
    const d = new Date(epochMs);
    const dow = d.getUTCDay();
    return { hour: d.getUTCHours(), minute: d.getUTCMinutes(), isoWeekday: dow === 0 ? 7 : dow };
  };

  it("★ 23:00 处于 DND → 结束于次日 08:00", () => {
    const t0 = Date.UTC(2026, 2, 3, 23, 0, 0); // 周二 23:00
    const end = dndEndsAt(t0, settings, fakeWall);
    expect(end).not.toBeNull();
    const d = new Date(end as number);
    expect(d.getUTCHours()).toBe(8);
    expect(d.getUTCDate()).toBe(4); // 次日
  });

  it("不在 DND 内返回 null", () => {
    const t0 = Date.UTC(2026, 2, 3, 15, 0, 0);
    expect(dndEndsAt(t0, settings, fakeWall)).toBeNull();
  });

  it("禁用或空窗口返回 null", () => {
    expect(
      dndEndsAt(Date.UTC(2026, 2, 3, 23, 0), { enabled: false, windows: settings.windows }, fakeWall),
    ).toBeNull();
    expect(dndEndsAt(Date.UTC(2026, 2, 3, 23, 0), { enabled: true, windows: [] }, fakeWall)).toBeNull();
  });
});

describe("shouldDeferForDnd：优先级穿透（TC-M1-12 / TC-M1-13）", () => {
  it("普通通知在 DND 内被推迟", () => {
    expect(shouldDeferForDnd({ priority: "normal", dndOverride: "inherit", inDnd: true })).toBe(true);
    expect(shouldDeferForDnd({ priority: "low", dndOverride: "inherit", inDnd: true })).toBe(true);
  });

  it("★ 高优先级穿透（不被推迟）", () => {
    for (const p of DND_BREAKTHROUGH_PRIORITIES) {
      expect(shouldDeferForDnd({ priority: p, dndOverride: "inherit", inDnd: true })).toBe(false);
    }
  });

  it("不在 DND 内一律不推迟", () => {
    expect(shouldDeferForDnd({ priority: "normal", dndOverride: "inherit", inDnd: false })).toBe(false);
    expect(shouldDeferForDnd({ priority: "low", dndOverride: "block", inDnd: false })).toBe(false);
  });

  it("dndOverride=allow 强制放行（即使低优先级）", () => {
    expect(shouldDeferForDnd({ priority: "low", dndOverride: "allow", inDnd: true })).toBe(false);
  });

  it("dndOverride=block 强制抑制（即使高优先级也不能穿透）", () => {
    expect(shouldDeferForDnd({ priority: "urgent", dndOverride: "block", inDnd: true })).toBe(true);
  });
});

describe("批量合并（I2 决策：≥3 条才合并）", () => {
  it("阈值默认 3", () => {
    expect(CATCHUP_MERGE_THRESHOLD).toBe(3);
  });

  it("1–2 条不合并（保留精确时间感）", () => {
    expect(shouldMergeCatchup(1)).toBe(false);
    expect(shouldMergeCatchup(2)).toBe(false);
  });

  it("≥3 条合并为摘要", () => {
    expect(shouldMergeCatchup(3)).toBe(true);
    expect(shouldMergeCatchup(20)).toBe(true);
  });

  it("阈值可配，且非法阈值不会退化为永不合并", () => {
    expect(shouldMergeCatchup(2, 2)).toBe(true);
    expect(shouldMergeCatchup(1, 0)).toBe(true); // 下限钳到 1
  });
});

describe("buildCatchupSummary：摘要正文", () => {
  it("逐条列出原定时间与标题", () => {
    const body = buildCatchupSummary([
      { scheduledWall: "2026-03-01T09:00", title: "交周报" },
      { scheduledWall: "2026-03-01T10:30", title: "站会" },
      { scheduledWall: "2026-03-01T18:00", title: "吃药" },
    ]);
    expect(body).toBe("· 09:00 交周报\n· 10:30 站会\n· 18:00 吃药");
  });

  it("超出上限时折叠并给出剩余条数（避免摘要本身过长）", () => {
    const items = Array.from({ length: 15 }, (_, i) => ({
      scheduledWall: `2026-03-01T${String(i).padStart(2, "0")}:00`,
      title: `提醒 ${i}`,
    }));
    const body = buildCatchupSummary(items, { maxItems: 10 });
    expect(body.split("\n")).toHaveLength(11); // 10 条 + 1 行「另有」
    expect(body).toContain("… 另有 5 条");
  });

  it("空列表产出空正文（不抛错）", () => {
    expect(buildCatchupSummary([])).toBe("");
  });
});

describe("shouldFallbackToNextChannel：降级时机", () => {
  it("永久错误与超时立刻降级", () => {
    expect(shouldFallbackToNextChannel("permanent_error")).toBe(true);
    expect(shouldFallbackToNextChannel("timeout")).toBe(true);
  });

  it("★ 瞬时错误先重试同一渠道（不降级，避免抖动）", () => {
    expect(shouldFallbackToNextChannel("transient_error")).toBe(false);
  });

  it("成功不降级", () => {
    expect(shouldFallbackToNextChannel("success")).toBe(false);
  });
});
