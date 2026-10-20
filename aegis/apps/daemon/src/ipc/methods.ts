/**
 * RPC 方法实现 —— daemon 对外能力的唯一入口
 *
 * ## 这一层做什么
 *
 * 三个职责，缺一不可：
 *   1. **契约翻译**：把 UI 友好的 `repeat.mode`（如 `weekdays`）翻译成 RRULE，
 *      再把内部 `Task` 转成对外 `TaskView`（含人话描述与下次触发时刻）
 *   2. **服务端校验**：客户端传来的参数一律重新校验（不信任 IPC 另一端）
 *   3. **错误转译**：把领域错误转成带错误码的 RPC 错误，让 UI 能分辨"参数错"与"内部错"
 *
 * ## 为什么翻译放在这里而不是 scheduler
 *
 * `scheduler` 只认 RRULE（那是它的输入契约）。"工作日"这类产品概念属于**界面语义**，
 * 应当在这一层被翻译掉 —— 这样 M4 的员工层要建任务时也能直接给 RRULE，
 * 不必理解 UI 的模式枚举。
 */

import type { Task } from "@aegis/contracts";
import {
  DndSettingsSchema,
  type DndSettingsView,
  type NotificationView,
  type SystemHealthView,
  type TaskEditView,
  type TaskView,
} from "@aegis/ipc-contract";
import { SystemMonitor } from "@aegis/monitors";
import type { DataPaths } from "@aegis/product";
import {
  describeRecurrence,
  type RecurrenceSpec,
  resolveTimeZone,
  utcToWall,
  validateRecurrenceSpec,
} from "@aegis/recurrence";
import type { Scheduler } from "@aegis/scheduler";
import { SkillLoadError } from "@aegis/skills";
import type { AttemptSummary } from "@aegis/storage";
import { z } from "zod";
import { createBackup } from "../bootstrap/backup.js";
import type { MonitorStatus } from "../bootstrap/monitor-runtime.js";
import { deleteSkill, importSkill, listSkills, SkillStoreError } from "../bootstrap/skill-store.js";

/** RPC 处理失败：携带错误码，交由 IpcServer 序列化 */
export class MethodError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "MethodError";
  }
}

/** 与 ipc-contract 的 RpcErrorCode 保持一致（此处避免循环依赖，故重复声明常量） */
const E_INVALID_PARAMS = -32602;
const E_INTERNAL = -32603;

/** 客户端传入的创建任务参数（结构由 ipc-contract 校验，这里只做类型标注） */
interface CreateTaskParams {
  title: string;
  notes?: string;
  priority?: "normal" | "important";
  firstFireAtWall: string;
  repeat: {
    mode: string;
    byWeekday?: number[] | undefined;
    byMonthDay?: number | undefined;
    intervalMinutes?: number | undefined;
    rrule?: string | undefined;
  };
  catchupWindowS?: number;
  dndOverride?: "inherit" | "allow" | "block";
}

/** 更新任务 = 完整创建输入 + id（契约层已做 Zod 校验） */
type UpdateTaskParams = CreateTaskParams & { id: string };

/**
 * 把 UI 的重复模式翻译为 RRULE。
 *
 * 映射表（`repeat.mode` → RRULE）：
 * | mode | RRULE |
 * | --- | --- |
 * | `once` | null（一次性） |
 * | `daily` | `FREQ=DAILY` |
 * | `weekly` | `FREQ=WEEKLY;BYDAY=…`（未指定则用首次触发的星期） |
 * | `weekdays` | `FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR` |
 * | `monthly` | `FREQ=MONTHLY;BYMONTHDAY=…` |
 * | `every_minutes` | `FREQ=MINUTELY;INTERVAL=…` |
 * | `custom_rrule` | 原样透传（由求解器校验） |
 *
 * @throws MethodError 模式未知或必填参数缺失
 */
export function translateRepeat(params: CreateTaskParams["repeat"], firstFireAtWall: string): string | null {
  switch (params.mode) {
    case "once":
      return null;
    case "daily":
      return "FREQ=DAILY";
    case "weekdays":
      return "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR";
    case "weekly": {
      const days = params.byWeekday;
      if (!days || days.length === 0) {
        // 未指定星期 → 用首次触发那天的星期（"每周的今天"）
        const w = parseWallParts(firstFireAtWall);
        if (!w) throw new MethodError(E_INVALID_PARAMS, `首次触发时间格式非法：${firstFireAtWall}`);
        const dow = new Date(Date.UTC(w.year, w.month - 1, w.day)).getUTCDay();
        const iso = dow === 0 ? 7 : dow;
        return `FREQ=WEEKLY;BYDAY=${isoName(iso)}`;
      }
      const names = [...new Set(days)].sort((a, b) => a - b).map(isoName);
      return `FREQ=WEEKLY;BYDAY=${names.join(",")}`;
    }
    case "monthly": {
      if (!params.byMonthDay) {
        const w = parseWallParts(firstFireAtWall);
        if (!w) throw new MethodError(E_INVALID_PARAMS, `首次触发时间格式非法：${firstFireAtWall}`);
        // 首次触发日在 29–31 号时，小月会被跳过（已在求解器与 PRD 中约定）
        return `FREQ=MONTHLY;BYMONTHDAY=${w.day}`;
      }
      return `FREQ=MONTHLY;BYMONTHDAY=${params.byMonthDay}`;
    }
    case "every_minutes": {
      const n = params.intervalMinutes;
      if (!n) throw new MethodError(E_INVALID_PARAMS, "every_minutes 模式必须提供 intervalMinutes");
      return n === 60 ? "FREQ=HOURLY" : `FREQ=MINUTELY;INTERVAL=${n}`;
    }
    case "custom_rrule": {
      if (!params.rrule) throw new MethodError(E_INVALID_PARAMS, "custom_rrule 模式必须提供 rrule");
      return params.rrule;
    }
    default:
      throw new MethodError(E_INVALID_PARAMS, `未知的重复模式：${params.mode}`);
  }
}

function isoName(iso: number): string {
  return (["MO", "TU", "WE", "TH", "FR", "SA", "SU"][iso - 1] ?? "MO") as string;
}

function parseWallParts(wall: string): { year: number; month: number; day: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(wall);
  if (!m) return null;
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

/** 把内部 Task 转成对外视图（含人话描述与下次触发时刻） */
export function toTaskView(task: Task, scheduler: Scheduler): TaskView {
  const spec: RecurrenceSpec = {
    rrule: task.recurrence.rrule,
    dtstartWall: task.recurrence.dtstartWall,
    tzid: task.recurrence.tzid,
    untilWall: task.recurrence.untilWall,
    countLimit: task.recurrence.countLimit,
  };
  const recurrenceNext = scheduler.nextFireAt(task);
  // 「稍后提醒」是独立通知，不修改任务 recurrence；把 pending snooze 也算作下一次，
  // 否则一次性任务一旦触发就会从列表消失，用户会以为 snooze 被清除了。
  const pendingNext = scheduler.daos.notifications.earliestPendingForTask(task.id);
  const nextFireAt =
    recurrenceNext === null
      ? pendingNext
      : pendingNext === null
        ? recurrenceNext
        : Math.min(recurrenceNext, pendingNext);
  const nextFireWall = nextFireAt === null ? null : wallString(utcToWall(nextFireAt, task.recurrence.tzid));

  return {
    id: task.id,
    title: task.title,
    notes: task.notes,
    priority: task.priority,
    enabled: task.enabled,
    repeatLabel: describeRecurrence(spec),
    nextFireAt,
    nextFireWall,
    lastFiredAt: scheduler.daos.occurrences.lastDeliveredAt(task.id),
    firedCount: task.firedCount,
  };
}

/** RRULE 的 BYDAY 代码 → ISO 星期 */
const BYDAY_NUM: Record<string, number> = { MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6, SU: 7 };

/**
 * 把数据库中的 RRULE 反解为 UI 的 repeat 形态。
 *
 * 只覆盖 `translateRepeat` 产生的规范形式；未知/第三方 RRULE 走 `custom_rrule`，
 * 由界面原样展示，避免编辑时静默改坏规则。
 */
function repeatOfTask(task: Task): TaskEditView["repeat"] {
  const rrule = task.recurrence.rrule;
  if (!rrule) return { mode: "once" };
  if (rrule === "FREQ=DAILY") return { mode: "daily" };

  const weekly = /^FREQ=WEEKLY;BYDAY=([A-Z,]+)$/.exec(rrule);
  if (weekly) {
    const codes = weekly[1]?.split(",") ?? [];
    const days = codes.map((c) => BYDAY_NUM[c]).filter((d): d is number => d !== undefined);
    if (days.length === 5 && [1, 2, 3, 4, 5].every((d) => days.includes(d))) {
      return { mode: "weekdays" };
    }
    return { mode: "weekly", byWeekday: days };
  }

  const monthly = /^FREQ=MONTHLY;BYMONTHDAY=(\d+)$/.exec(rrule);
  if (monthly) return { mode: "monthly", byMonthDay: Number(monthly[1]) };

  const minutely = /^FREQ=MINUTELY;INTERVAL=(\d+)$/.exec(rrule);
  if (minutely) return { mode: "every_minutes", intervalMinutes: Number(minutely[1]) };

  return { mode: "custom_rrule", rrule };
}

/** 把任务转成编辑对话框要回填的完整结构 */
function toTaskEditView(task: Task): TaskEditView {
  return {
    id: task.id,
    title: task.title,
    notes: task.notes,
    priority: task.priority,
    firstFireAtWall: task.recurrence.dtstartWall,
    repeat: repeatOfTask(task),
    catchupWindowS: task.catchupWindowS,
    dndOverride: task.dndOverride,
  };
}

function wallString(w: { year: number; month: number; day: number; hour: number; minute: number }): string {
  const p2 = (n: number): string => String(n).padStart(2, "0");
  return `${w.year}-${p2(w.month)}-${p2(w.day)}T${p2(w.hour)}:${p2(w.minute)}`;
}

/** `backup.export` 需要的运行期上下文（由 daemon 启动时注入） */
export interface BackupMethodsContext {
  paths: DataPaths;
  daemonVersion: string;
}

/** `dnd.set` 需要的运行期上下文：持久化 + 通知 scheduler 立即生效 */
export interface DndMethodsContext {
  updateDnd: (settings: DndSettingsView) => void;
}

/** `monitor.status` 需要的运行期上下文 */
export interface MonitorMethodsContext {
  status: () => MonitorStatus[];
}

/** Skill 文件管理需要的运行期上下文 */
export interface SkillsMethodsContext {
  dataDir: string;
}

/** 构造 RPC handler 时注入的可选运行期能力 */
export interface MethodsContext {
  backup?: BackupMethodsContext;
  dnd?: DndMethodsContext;
  monitors?: MonitorMethodsContext;
  skills?: SkillsMethodsContext;
}

/** 构造全部 RPC handler。返回对象直接交给 IpcServer 的 `methods` 选项 */
export function createMethods(
  scheduler: Scheduler,
  context: MethodsContext = {},
): Record<string, (params: unknown) => Promise<unknown>> {
  const { tasks, notifications } = scheduler.daos;
  const attempts = scheduler.daos.attempts;

  return {
    // ── 任务 ────────────────────────────────────────────────────────────
    "task.list": async (params) => {
      const p = z
        .object({
          filter: z.enum(["today", "all", "paused"]).optional(),
          cursor: z.string().optional(),
          limit: z.number().int().min(1).max(500).optional(),
        })
        .strict()
        .parse(params ?? {});

      const onlyEnabled = p.filter !== "paused";
      // 默认/今天视图只显示"还会再响"的任务（含等待中的 snooze）；已结束的一次性任务
      // 留在通知历史里，不占提醒列表。显式传 all 才把它们列出来（CLI/诊断用）。
      const list = tasks
        .list({ onlyEnabled })
        .map((t) => toTaskView(t, scheduler))
        .filter((v) => p.filter === "all" || p.filter === "paused" || v.nextFireAt !== null);
      const limit = p.limit ?? 100;
      // 分页用偏移量编码在 cursor 里（游标语义简单化：本阶段数据量小，偏移足够）
      const offset = p.cursor ? Number(p.cursor) || 0 : 0;
      const page = list.slice(offset, offset + limit);
      const nextOffset = offset + page.length;
      return {
        items: page,
        nextCursor: nextOffset < list.length ? String(nextOffset) : null,
      };
    },

    "task.create": async (params) => {
      const p = params as CreateTaskParams;
      const rrule = translateRepeat(p.repeat, p.firstFireAtWall);
      const tzid = resolveTimeZone("system"); // R2：任务默认跟随系统时区（UI 可后续覆盖）

      const spec: RecurrenceSpec = {
        rrule,
        dtstartWall: p.firstFireAtWall,
        tzid,
        untilWall: null,
        countLimit: null,
      };

      // ★ 服务端重新校验：不信任 IPC 另一端传来的规则
      const problem = validateRecurrenceSpec(spec);
      if (problem) throw new MethodError(E_INVALID_PARAMS, problem);

      try {
        const task = scheduler.createTask({
          title: p.title,
          notes: p.notes ?? null,
          priority: p.priority === "important" ? "important" : "normal",
          recurrence: spec,
          ...(p.catchupWindowS !== undefined ? { catchupWindowS: p.catchupWindowS } : {}),
        });
        if (p.dndOverride) tasks.setDndOverride(task.id, p.dndOverride);
        return { id: task.id };
      } catch (err) {
        throw new MethodError(E_INTERNAL, err instanceof Error ? err.message : String(err));
      }
    },

    "task.pause": async (params) => {
      const p = z.object({ id: z.string() }).strict().parse(params);
      return { ok: tasks.setEnabled(p.id, false) };
    },

    "task.resume": async (params) => {
      const p = z.object({ id: z.string() }).strict().parse(params);
      return { ok: tasks.setEnabled(p.id, true) };
    },

    "task.delete": async (params) => {
      const p = z.object({ id: z.string(), hard: z.boolean().optional() }).strict().parse(params);
      return { ok: p.hard === true ? tasks.hardDelete(p.id) : tasks.softDelete(p.id) };
    },

    // ── 备份 ────────────────────────────────────────────────────────────
    "backup.export": async (params) => {
      const p = z
        .object({ targetDir: z.string().min(1), includeHistory: z.boolean().optional() })
        .strict()
        .parse(params);
      if (!context.backup) {
        throw new MethodError(E_INTERNAL, "备份服务未配置（daemon 缺少 dataDir/version）");
      }
      if (p.includeHistory === false) {
        // 数据库快照天然包含历史；暂不支持"排除历史"的语义，避免静默做出错误承诺
        throw new MethodError(E_INVALID_PARAMS, "backup.export 暂不支持 includeHistory=false");
      }
      const manifest = createBackup({
        paths: context.backup.paths,
        outDir: p.targetDir,
        daemonVersion: context.backup.daemonVersion,
      });
      return {
        path: p.targetDir,
        files: manifest.files.length,
        totalBytes: manifest.totalBytes,
      };
    },

    "task.get": async (params) => {
      const p = z.object({ id: z.string() }).strict().parse(params);
      const task = tasks.getById(p.id);
      if (!task || task.deletedAt !== null) {
        throw new MethodError(E_INVALID_PARAMS, `任务不存在：${p.id}`);
      }
      return toTaskEditView(task);
    },

    "task.update": async (params) => {
      const p = params as UpdateTaskParams;
      const task = tasks.getById(p.id);
      if (!task || task.deletedAt !== null) {
        throw new MethodError(E_INVALID_PARAMS, `任务不存在：${p.id}`);
      }

      const rrule = translateRepeat(p.repeat, p.firstFireAtWall);
      const recurrenceChanged =
        rrule !== task.recurrence.rrule || p.firstFireAtWall !== task.recurrence.dtstartWall;

      if (recurrenceChanged) {
        // 旧计划的未来实例必须先清掉，再更新 recurrence；否则两套计划会同时物化。
        // 通知先置为 suppressed，让已入 outbox 的投递项在下一轮直接完成，不误发旧时间。
        notifications.suppressPendingForTask(task.id);
        scheduler.daos.occurrences.deletePendingFuture(task.id, scheduler.now());
      }

      const updated = tasks.update(task.id, {
        title: p.title,
        notes: p.notes ?? null,
        priority: p.priority === "important" ? "important" : "normal",
        ...(recurrenceChanged
          ? {
              recurrence: {
                rrule,
                dtstartWall: p.firstFireAtWall,
                tzid: resolveTimeZone("system"),
                // 编辑 UI 不修改截止条件，保留原任务的 until/count
                untilWall: task.recurrence.untilWall,
                countLimit: task.recurrence.countLimit,
              },
            }
          : {}),
        ...(p.catchupWindowS !== undefined ? { catchupWindowS: p.catchupWindowS } : {}),
        ...(p.dndOverride !== undefined ? { dndOverride: p.dndOverride } : {}),
      });
      if (!updated) throw new MethodError(E_INTERNAL, `更新任务失败：${task.id}`);
      return { id: updated.id };
    },

    "task.complete": async (params) => {
      const p = z.object({ occurrenceId: z.string() }).strict().parse(params);
      const occ = scheduler.daos.occurrences.getById(p.occurrenceId);
      const task = occ ? tasks.getById(occ.taskId) : null;
      // "完成"= 把该实例标记为已投递并从待办中移除（不再补发）
      const ok = scheduler.daos.occurrences.markCompleted(p.occurrenceId);
      // 一次性提醒完成后没有"下一次"了：软删除任务，让它退出提醒列表；
      // 通知历史仍在。重复提醒只结束本次实例，任务保留。
      if (task?.recurrence.rrule === null) {
        const removed = tasks.softDelete(task.id);
        return { ok: ok || removed };
      }
      return { ok };
    },

    "task.snooze": async (params) => {
      const p = z
        .object({ occurrenceId: z.string(), minutes: z.number().int().min(1).max(1_440) })
        .strict()
        .parse(params);
      const occ = scheduler.daos.occurrences.getById(p.occurrenceId);
      if (!occ) throw new MethodError(E_INVALID_PARAMS, `实例不存在：${p.occurrenceId}`);
      // 稍后提醒：新建一条一次性通知，而不改动原实例（保留"原定时刻"的历史）
      const task = tasks.getById(occ.taskId);
      const at = scheduler.daos.notifications.createWithOutbox({
        occurrenceId: occ.id,
        kind: "reminder",
        title: task?.title ?? "稍后提醒",
        body: task?.notes ?? null,
        priority: "normal",
        // 从**现在**起算，而不是 occ.scheduledAt：延迟投递的提醒否则会立刻再次到期
        scheduledFor: scheduler.now() + p.minutes * 60_000,
      });
      return { id: at.id };
    },

    // ── 通知 ────────────────────────────────────────────────────────────
    "notify.history": async (params) => {
      const p = z
        .object({
          cursor: z.string().optional(),
          limit: z.number().int().min(1).max(200).optional(),
          kind: z.string().optional(),
        })
        .strict()
        .parse(params ?? {});
      const limit = p.limit ?? 50;
      const offset = p.cursor ? Number(p.cursor) || 0 : 0;
      const all = notifications.listRecent(1_000, p.kind as never);
      const page = all.slice(offset, offset + limit);
      // 批量取投递摘要：避免列表接口产生 N+1 查询
      const summaries = attempts.summaryForMany(page.map((n) => n.id));
      return {
        items: page.map((n) => toNotificationView(n, summaries.get(n.id) ?? [])),
        nextCursor: offset + page.length < all.length ? String(offset + page.length) : null,
      };
    },

    // ── 全局控制 ────────────────────────────────────────────────────────
    "ctrl.pauseAll": async (params) => {
      const p = z
        .object({ untilAt: z.number().int().optional() })
        .strict()
        .parse(params ?? {});
      // 注意：`untilAt`（"暂停到某个时刻"）需要独立的定时恢复逻辑，
      // 属 M2 的监测器暂停能力；R2 只做"立即全暂停"，因此这里显式拒绝而不是静默忽略。
      if (p.untilAt !== undefined) {
        throw new MethodError(E_INVALID_PARAMS, "定时恢复（untilAt）尚未实现，请使用不带参数的立即暂停");
      }
      return { ok: tasks.setAllEnabled(false) >= 0 };
    },

    "ctrl.resumeAll": async () => {
      tasks.setAllEnabled(true);
      return { ok: true };
    },

    "monitor.status": async () => {
      return { monitors: context.monitors?.status() ?? [] };
    },

    "skill.list": async () => {
      return { skills: context.skills ? listSkills(context.skills.dataDir) : [] };
    },

    "skill.import": async (params) => {
      const p = z
        .object({ filename: z.string().min(1).max(128), content: z.string().min(1).max(300_000) })
        .strict()
        .parse(params);
      if (!context.skills) throw new MethodError(E_INTERNAL, "Skill 存储未初始化");
      try {
        return { skill: importSkill(context.skills.dataDir, p.filename, p.content) };
      } catch (err) {
        if (err instanceof SkillLoadError) {
          const issues = err.issues.length > 0 ? `：${err.issues.join("；")}` : "";
          throw new MethodError(E_INVALID_PARAMS, `Skill 校验失败：${err.message}${issues}`);
        }
        if (err instanceof SkillStoreError) {
          throw new MethodError(E_INVALID_PARAMS, err.message);
        }
        throw new MethodError(E_INTERNAL, `导入 Skill 失败：${(err as Error).message}`);
      }
    },

    "skill.delete": async (params) => {
      const p = z
        .object({ filename: z.string().min(1).max(128) })
        .strict()
        .parse(params);
      if (!context.skills) throw new MethodError(E_INTERNAL, "Skill 存储未初始化");
      try {
        deleteSkill(context.skills.dataDir, p.filename);
        return { ok: true };
      } catch (err) {
        if (err instanceof SkillStoreError) {
          throw new MethodError(E_INVALID_PARAMS, err.message);
        }
        throw new MethodError(E_INTERNAL, `删除 Skill 失败：${(err as Error).message}`);
      }
    },

    "monitor.system": async () => {
      const result = await new SystemMonitor().scan();
      const fields = result.facts[0]?.fields;
      if (!fields) {
        const detail = result.errors.map((e) => `${e.path}: ${e.message}`).join("; ");
        throw new MethodError(E_INTERNAL, `系统指标不可用${detail ? `：${detail}` : ""}`);
      }
      const health: SystemHealthView = {
        at: Number(fields.at),
        mount: String(fields.mount),
        cpuCount: Number(fields.cpu_count),
        load1: Number(fields.load1),
        load5: Number(fields.load5),
        load15: Number(fields.load15),
        memoryTotalGb: Number(fields.memory_total_gb),
        memoryFreeGb: Number(fields.memory_free_gb),
        memoryFreePercent: Number(fields.memory_free_percent),
        diskTotalGb: Number(fields.disk_total_gb),
        diskFreeGb: Number(fields.disk_free_gb),
        diskFreePercent: Number(fields.disk_free_percent),
        uptimeS: Number(fields.uptime_s),
      };
      return { health, errors: result.errors };
    },

    "dnd.get": async () => {
      const d = scheduler.dndSettings;
      return {
        enabled: d.enabled,
        windows: d.windows.map((w) => ({ days: [...w.days], from: w.from, to: w.to })),
      };
    },

    "dnd.set": async (params) => {
      const p = DndSettingsSchema.parse(params);
      if (!context.dnd) {
        throw new MethodError(E_INTERNAL, "免打扰设置服务未配置");
      }
      // 先持久化，成功后再改内存；写失败时 daemon 仍保持旧设置
      context.dnd.updateDnd(p);
      return { ok: true };
    },

    "notify.test": async () => {
      // 立即投递一条测试通知（首次启动向导用它让用户验证"它真的会响"）
      const at = scheduler.daos.notifications.createWithOutbox({
        kind: "digest",
        title: "这是一条测试提醒",
        body: "如果你看到它，说明通知通道工作正常。",
        priority: "high",
        scheduledFor: Date.now(),
      });
      await scheduler.deliver();
      return { ok: at.created };
    },
  };
}

function toNotificationView(
  n: {
    id: string;
    kind: string;
    title: string;
    body: string | null;
    scheduledFor: number;
    state: string;
    occurrenceId: string | null;
  },
  attempts: AttemptSummary[],
): NotificationView {
  return {
    id: n.id,
    kind: n.kind as NotificationView["kind"],
    title: n.title,
    body: n.body,
    scheduledFor: n.scheduledFor,
    state: n.state as NotificationView["state"],
    attempts,
    // 补偿补发与不确定投递要能在界面上被区分出来（详细设计 §6.5）
    isCatchup: n.kind === "catchup_batch",
    isUncertain: false,
  };
}
