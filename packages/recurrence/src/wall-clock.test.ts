/**
 * 墙钟/时区转换测试 —— DST 正确性的集中验证点
 *
 * 这里覆盖的是"看起来会跑、实际会错一小时"的问题，是本项目最容易出错、
 * 也最难靠人工发现的一类缺陷（提醒漂移一小时，用户当天可能都察觉不到）。
 *
 * 美国 2026 年 DST 边界（用于构造用例）：
 *   - 春季：3 月 8 日 02:00 → 03:00（EST -5 变为 EDT -4）
 *   - 秋季：11 月 1 日 02:00 → 01:00（EDT -4 变为 EST -5）
 * 中国无夏令时，用于验证"不受影响"的对照组。
 */

import { describe, expect, it } from "vitest";
import {
  addDays,
  addMinutes,
  addMonths,
  addYears,
  daysInMonth,
  formatUntil,
  formatWallClock,
  isoWeekday,
  isValidTimeZone,
  parseUntil,
  parseWallClock,
  resolveTimeZone,
  systemTimeZone,
  utcToWall,
  wallToUtc,
} from "./wall-clock.js";

describe("时区基础", () => {
  it("解析运行环境的本地时区（依赖完整 ICU）", () => {
    const tz = systemTimeZone();
    expect(typeof tz).toBe("string");
    expect(tz.length).toBeGreaterThan(0);
    // 本机为 Asia/Shanghai；即使 CI 在别处也不应退化成空串
    expect(tz).not.toBe("");
  });

  it("'system' 解析为本地时区（I1 决策的「跟随系统」开关）", () => {
    expect(resolveTimeZone("system")).toBe(systemTimeZone());
    expect(resolveTimeZone("")).toBe(systemTimeZone());
    expect(resolveTimeZone("Asia/Shanghai")).toBe("Asia/Shanghai");
  });

  it("校验 IANA 时区合法性", () => {
    expect(isValidTimeZone("Asia/Shanghai")).toBe(true);
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("system")).toBe(true);
    expect(isValidTimeZone("Not/AZone")).toBe(false);
    expect(isValidTimeZone("MM-5")).toBe(false);
  });
});

describe("正向换算：UTC → 墙上时间", () => {
  it("上海（无夏令时）固定 +08:00", () => {
    const wall = utcToWall(Date.UTC(2026, 2, 10, 1, 0, 0), "Asia/Shanghai");
    expect(wall).toEqual({ year: 2026, month: 3, day: 10, hour: 9, minute: 0, second: 0 });
  });

  it("纽约跨越春季 DST 后偏移变为 -4", () => {
    const before = utcToWall(Date.UTC(2026, 2, 7, 14, 0, 0), "America/New_York");
    const after = utcToWall(Date.UTC(2026, 2, 8, 13, 0, 0), "America/New_York");
    expect(before.hour).toBe(9);
    expect(after.hour).toBe(9);
  });
});

describe("反向换算：墙上时间 → UTC", () => {
  it("上海：每天 09:00 恒定对应 UTC 01:00", () => {
    for (const day of [1, 15, 28]) {
      const r = wallToUtc({ year: 2026, month: 6, day, hour: 9, minute: 0, second: 0 }, "Asia/Shanghai");
      expect(r.adjusted).toBe(false);
      expect(new Date(r.epochMs).toISOString()).toBe(`2026-06-${String(day).padStart(2, "0")}T01:00:00.000Z`);
    }
  });

  it("★ 纽约春季 DST：本地 09:00 的 UTC 偏移从 -5 变为 -4，但本地时间不变", () => {
    const before = wallToUtc(
      { year: 2026, month: 3, day: 7, hour: 9, minute: 0, second: 0 },
      "America/New_York",
    );
    const after = wallToUtc(
      { year: 2026, month: 3, day: 9, hour: 9, minute: 0, second: 0 },
      "America/New_York",
    );
    expect(before.adjusted).toBe(false);
    expect(after.adjusted).toBe(false);
    // 3/7 是 EST(-5)：09:00 本地 = 14:00Z；3/9 是 EDT(-4)：09:00 本地 = 13:00Z
    expect(new Date(before.epochMs).toISOString()).toBe("2026-03-07T14:00:00.000Z");
    expect(new Date(after.epochMs).toISOString()).toBe("2026-03-09T13:00:00.000Z");
    // 关键：两次的**本地墙上时间都是 09:00**
    expect(utcToWall(before.epochMs, "America/New_York").hour).toBe(9);
    expect(utcToWall(after.epochMs, "America/New_York").hour).toBe(9);
  });

  it("★ 纽约秋季 DST：本地 09:00 的 UTC 偏移从 -4 变回 -5", () => {
    const before = wallToUtc(
      { year: 2026, month: 10, day: 31, hour: 9, minute: 0, second: 0 },
      "America/New_York",
    );
    const after = wallToUtc(
      { year: 2026, month: 11, day: 2, hour: 9, minute: 0, second: 0 },
      "America/New_York",
    );
    expect(new Date(before.epochMs).toISOString()).toBe("2026-10-31T13:00:00.000Z");
    expect(new Date(after.epochMs).toISOString()).toBe("2026-11-02T14:00:00.000Z");
  });

  it("★ 春令时「不存在的时刻」被顺延并标记 adjusted（02:30 在 3/8 不存在）", () => {
    const r = wallToUtc({ year: 2026, month: 3, day: 8, hour: 2, minute: 30, second: 0 }, "America/New_York");
    expect(r.adjusted).toBe(true);
    // 顺延后的时刻仍应是当天、且墙上时间不早于 02:30（实际为 03:30）
    const wall = utcToWall(r.epochMs, "America/New_York");
    expect(wall.day).toBe(8);
    expect(wall.hour * 60 + wall.minute).toBeGreaterThanOrEqual(2 * 60 + 30);
  });

  it("★ 秋令时「重复的时刻」取第一次出现（保证同一墙钟时间只有一个实例）", () => {
    const r = wallToUtc(
      { year: 2026, month: 11, day: 1, hour: 1, minute: 30, second: 0 },
      "America/New_York",
    );
    expect(r.adjusted).toBe(false);
    // 第一次出现是 EDT(-4)：01:30 本地 = 05:30Z（第二次会是 06:30Z）
    expect(new Date(r.epochMs).toISOString()).toBe("2026-11-01T05:30:00.000Z");
  });

  it("往返一致性：任意时刻 → 墙上时间 → 回到同一 UTC（非 DST 空洞时）", () => {
    const samples = [
      "2026-01-01T00:00:00Z",
      "2026-06-15T12:34:56Z",
      "2026-12-31T23:59:59Z",
      "2027-03-14T07:00:00Z",
    ];
    for (const iso of samples) {
      for (const tz of ["Asia/Shanghai", "America/New_York", "Europe/London", "UTC"]) {
        const ms = Date.parse(iso);
        const back = wallToUtc(utcToWall(ms, tz), tz);
        expect(back.adjusted).toBe(false);
        expect(new Date(back.epochMs).toISOString()).toBe(new Date(ms).toISOString());
      }
    }
  });
});

describe("墙钟序列化（契约格式）", () => {
  it("秒为 0 时省略秒，便于人工阅读", () => {
    expect(formatWallClock({ year: 2026, month: 3, day: 1, hour: 9, minute: 5, second: 0 })).toBe(
      "2026-03-01T09:05",
    );
    expect(formatWallClock({ year: 2026, month: 3, day: 1, hour: 9, minute: 5, second: 30 })).toBe(
      "2026-03-01T09:05:30",
    );
  });

  it("解析合法值并补齐秒", () => {
    expect(parseWallClock("2026-03-01T09:05")).toEqual({
      year: 2026,
      month: 3,
      day: 1,
      hour: 9,
      minute: 5,
      second: 0,
    });
  });

  it("拒绝非法取值（而不仅是非法格式）", () => {
    expect(parseWallClock("2026-02-30T09:00")).toBeNull(); // 2 月没有 30 号
    expect(parseWallClock("2025-02-29T09:00")).toBeNull(); // 平年
    expect(parseWallClock("2026-13-01T09:00")).toBeNull(); // 13 月
    expect(parseWallClock("2026-03-01T24:00")).toBeNull(); // 24 点
    expect(parseWallClock("2026/03/01 09:00")).toBeNull(); // 格式错误
    expect(parseWallClock("2024-02-29T09:00")).not.toBeNull(); // 闰年合法
  });

  it("UNTIL 往返（RFC 5545 的 UTC 紧凑格式）", () => {
    const ms = Date.UTC(2026, 11, 31, 23, 59, 59);
    expect(formatUntil(ms)).toBe("20261231T235959Z");
    expect(parseUntil("20261231T235959Z")).toBe(ms);
    expect(parseUntil("20261231")).toBe(Date.UTC(2026, 11, 31, 0, 0, 0));
    expect(parseUntil("乱写")).toBeNull();
  });
});

describe("日历运算（墙钟域）", () => {
  it("每月天数含闰年", () => {
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(2000, 2)).toBe(29); // 400 年闰
    expect(daysInMonth(1900, 2)).toBe(28); // 百年不闰
    expect(daysInMonth(2026, 4)).toBe(30);
    expect(daysInMonth(2026, 12)).toBe(31);
  });

  it("ISO 星期编号（1=周一 … 7=周日）", () => {
    expect(isoWeekday({ year: 2026, month: 3, day: 2 })).toBe(1); // 周一
    expect(isoWeekday({ year: 2026, month: 3, day: 6 })).toBe(5); // 周五
    expect(isoWeekday({ year: 2026, month: 3, day: 7 })).toBe(6); // 周六
    expect(isoWeekday({ year: 2026, month: 3, day: 8 })).toBe(7); // 周日
  });

  it("加天数跨月跨年", () => {
    const w = { year: 2026, month: 12, day: 31, hour: 9, minute: 0, second: 0 };
    expect(addDays(w, 1)).toMatchObject({ year: 2027, month: 1, day: 1, hour: 9 });
    expect(addDays(w, -365)).toMatchObject({ year: 2025, month: 12, day: 31 });
  });

  it("★ 加月份在小月返回 null（「每月 31 号」的跳过语义）", () => {
    const jan31 = { year: 2026, month: 1, day: 31, hour: 9, minute: 0, second: 0 };
    const feb = addMonths(jan31, 1);
    expect(feb).toBeNull(); // 2 月没有 31 号 → 跳过
    const feb28 = { year: 2026, month: 2, day: 28, hour: 9, minute: 0, second: 0 };
    expect(addMonths(feb28, 1)).toMatchObject({ month: 3, day: 28 }); // 正常路径
    expect(addMonths(feb28, 12)).toMatchObject({ year: 2027, month: 2, day: 28 });
  });

  it("★ 加年份在平年 2/29 返回 null", () => {
    const leap = { year: 2024, month: 2, day: 29, hour: 9, minute: 0, second: 0 };
    expect(addYears(leap, 1)).toBeNull(); // 2025 不是闰年
    expect(addYears(leap, 4)).toMatchObject({ year: 2028, month: 2, day: 29 });
  });

  it("加分钟跨日回卷", () => {
    const w = { year: 2026, month: 3, day: 1, hour: 23, minute: 50, second: 0 };
    expect(addMinutes(w, 20)).toMatchObject({ day: 2, hour: 0, minute: 10 });
    expect(addMinutes(w, -60)).toMatchObject({ day: 1, hour: 22, minute: 50 });
  });
});
