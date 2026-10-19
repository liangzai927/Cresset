/**
 * 调度策略 —— **纯函数**，调度决策的全部判断逻辑都在这里
 *
 * ## 为什么把判断抽成纯函数
 *
 * 调度的难点不是"写代码"而是"判断对不对"：补偿窗口、免打扰、批量合并这些规则
 * 一旦混进数据库读写，就只能靠集成测试覆盖，而集成测试很难枚举边界。
 * 抽成纯函数后，"12 小时窗口的第 12 小时零 1 分该不该补发"这种问题可以被精确断言。
 *
 * ## 三个决策点（对应详细设计 §6.3–§6.4）
 *
 * 1. **补偿窗口**：错过的实例是否还值得补发（FR-A3）
 * 2. **免打扰**：该通知是否应被推迟到 DND 结束（FR-A7 / TC-M1-12）
 * 3. **批量合并**：补偿时多条通知是否合成一条摘要（I2 决策）
 */

/** 一天中的分钟数（0-1439） */
export function minuteOfDay(hour: number, minute: number): number {
  return hour * 60 + minute;
}

/** 把 `HH:mm` 解析为一天中的分钟；格式非法返回 null */
export function parseHhMm(text: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return minuteOfDay(h, min);
}

// ── 补偿窗口（FR-A3） ────────────────────────────────────────────────────

/**
 * 判断一条错过的实例是否仍在补偿窗口内。
 *
 * 语义：`scheduledAt + catchupWindowS * 1000 >= now` 才补发。
 * 超出窗口的实例应当被标记为 `skipped`（记入历史但不打扰用户），
 * 这是"宁可漏报也不在半年后突然弹一堆旧提醒"的取舍。
 *
 * @param scheduledAt 原定触发时刻（UTC 毫秒）
 * @param now 当前时刻（UTC 毫秒）
 * @param catchupWindowS 补偿窗口（秒）；0 表示不允许补偿
 */
export function isWithinCatchupWindow(scheduledAt: number, now: number, catchupWindowS: number): boolean {
  if (catchupWindowS <= 0) return false;
  return scheduledAt + catchupWindowS * 1_000 >= now;
}

// ── 免打扰（FR-A7） ──────────────────────────────────────────────────────

/** 一个免打扰时段（可跨午夜，如 22:00 → 08:00） */
export interface DndWindow {
  /** ISO 星期编号：1=周一 … 7=周日 */
  days: number[];
  /** `HH:mm` */
  from: string;
  /** `HH:mm` */
  to: string;
}

/** 免打扰设置；`windows` 支持多段（如午休 + 夜间），且允许跨午夜 */
export interface DndSettings {
  enabled: boolean;
  windows: DndWindow[];
}

/**
 * 判断某个墙上时刻是否落在免打扰时段内。
 *
 * 支持跨午夜（`from > to` 表示跨越 24:00）。注意**跨午夜时"归属哪一天"**：
 * 22:00–08:00 这个窗口，凌晨 3 点属于"前一天"的窗口。
 * 例如 `days=[1]`（周一）从 22:00 到 08:00，则周二凌晨 3 点仍在窗口内 ——
 * 这正是用户"周一晚上别打扰我"的直觉。
 *
 * @param wall 待判断的墙上时间（已按任务时区换算）
 */
export function isWithinDnd(
  wall: { hour: number; minute: number },
  isoWeekday: number,
  settings: DndSettings,
): boolean {
  if (!settings.enabled) return false;
  const nowMin = minuteOfDay(wall.hour, wall.minute);

  for (const w of settings.windows) {
    const from = parseHhMm(w.from);
    const to = parseHhMm(w.to);
    if (from === null || to === null) continue; // 非法配置跳过，不阻断调度

    if (from <= to) {
      // 同日窗口：[from, to)
      if (nowMin >= from && nowMin < to && w.days.includes(isoWeekday)) return true;
    } else {
      // 跨午夜窗口：今天 [from, 24:00) 或 明天 [00:00, to)
      if (nowMin >= from && w.days.includes(isoWeekday)) return true;
      const prevDay = isoWeekday === 1 ? 7 : isoWeekday - 1;
      if (nowMin < to && w.days.includes(prevDay)) return true;
    }
  }
  return false;
}

/**
 * 计算当前处于的免打扰时段的结束时刻（UTC 毫秒）。
 *
 * @returns 不在 DND 内返回 null；否则返回该时段的结束时刻
 *
 * ⚠️ 实现细节：逐分钟向前扫描（上限 24 小时）。
 * 这样做的原因是跨午夜 + 多窗口 + 星期边界让"解析求解"容易出错，
 * 而扫描最多 1440 次、只在真正命中 DND 时才发生，代价可忽略。
 */
export function dndEndsAt(
  nowMs: number,
  settings: DndSettings,
  toWall: (epochMs: number) => { hour: number; minute: number; isoWeekday: number },
): number | null {
  if (!settings.enabled || settings.windows.length === 0) return null;

  const stepMs = 60_000;
  const maxSteps = 24 * 60; // 最多扫 24 小时
  const startWall = toWall(nowMs);
  if (!isWithinDnd(startWall, startWall.isoWeekday, settings)) return null;

  for (let i = 1; i <= maxSteps; i++) {
    const probe = nowMs + i * stepMs;
    const wall = toWall(probe);
    if (!isWithinDnd(wall, wall.isoWeekday, settings)) {
      // 找到离开 DND 的第一分钟；对齐到该分钟的起点
      return probe - (probe % stepMs);
    }
  }
  // 配置异常（如覆盖全天）时退化为 24 小时后再看
  return nowMs + 24 * 3_600_000;
}

/** DND 期间可以穿透的最低优先级（I 决策：high 与 urgent 可穿透） */
export const DND_BREAKTHROUGH_PRIORITIES: readonly string[] = ["high", "urgent"];

/**
 * 判断一条通知是否应当被免打扰推迟。
 *
 * 规则来自 FR-A7 + TC-M1-13：
 *   - 通知优先级为 high/urgent → **不推迟**（穿透）
 *   - 任务的 `dndOverride='allow'` → 不推迟
 *   - 任务的 `dndOverride='block'` → 一定推迟（即使高优先级）
 *   - 其余情况按全局 DND 设置判断
 */
export function shouldDeferForDnd(params: {
  /** 通知优先级 */
  priority: string;
  /** 任务对 DND 的覆盖策略 */
  dndOverride: "inherit" | "allow" | "block";
  /** 是否处于 DND 时段 */
  inDnd: boolean;
}): boolean {
  if (params.dndOverride === "allow") return false;
  if (params.dndOverride === "block") return params.inDnd;
  if (!params.inDnd) return false;
  return !DND_BREAKTHROUGH_PRIORITIES.includes(params.priority);
}

// ── 批量合并（I2 决策） ─────────────────────────────────────────────────

/** 补偿批量的合并阈值（I2：≥3 条才合并为摘要） */
export const CATCHUP_MERGE_THRESHOLD = 3;

/**
 * 判断一批补偿通知是否应当合并为一条摘要。
 *
 * I2 决策：**1–2 条逐条发**（保留精确的时间感），**≥3 条合并**（避免一次弹 20 条）。
 * 阈值可配（`notify.catchupMergeThreshold`）。
 */
export function shouldMergeCatchup(count: number, threshold: number = CATCHUP_MERGE_THRESHOLD): boolean {
  return count >= Math.max(1, threshold);
}

/**
 * 拼装补偿摘要的正文。
 *
 * 设计意图：**让用户一眼看到"我错过了什么"**，而不是一条笼统的"你有 3 条提醒"。
 * 因此逐条列出原定时间与标题，并按时间升序。
 */
export function buildCatchupSummary(
  items: Array<{ scheduledWall: string; title: string }>,
  opts: { maxItems?: number } = {},
): string {
  const max = opts.maxItems ?? 10;
  const lines = items.slice(0, max).map((it) => {
    // 墙上时间是 `YYYY-MM-DDTHH:mm`，只需要 HH:mm 部分
    const time = it.scheduledWall.includes("T") ? (it.scheduledWall.split("T")[1] ?? "") : it.scheduledWall;
    return `· ${time} ${it.title}`;
  });
  const rest = items.length - Math.min(items.length, max);
  if (rest > 0) lines.push(`… 另有 ${rest} 条`);
  return lines.join("\n");
}

// ── 投递渠道选择 ────────────────────────────────────────────────────────

/**
 * 渠道失败后是否应当降级到下一个渠道。
 *
 * 规则：
 *   - `permanent_error` / `timeout` → 立刻降级（重试同一渠道没有意义）
 *   - `transient_error` → **先重试同一渠道**（由 outbox 退避控制），不立即降级
 *   - `success` → 不降级
 */
export function shouldFallbackToNextChannel(outcome: string): boolean {
  return outcome === "permanent_error" || outcome === "timeout";
}
