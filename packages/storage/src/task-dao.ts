/**
 * 任务 DAO（R1）
 *
 * 约定：
 *   - 行的读取**一律经 Zod 解码**（`TaskSchema`），任何格式漂移都会在边界暴露，
 *     而不是悄悄带着 undefined 流到业务层。
 *   - 布尔在 SQLite 里是 INTEGER，出入库都要显式转换（不要依赖真值判断）。
 *   - 软删除：`deleted_at` 非空即视为已删除，列表查询默认过滤。
 */
import { randomUUID } from "node:crypto";
import {
  DndOverrideSchema,
  PrioritySchema,
  type RecurrenceRule,
  RecurrenceRuleSchema,
  type Task,
  TaskSchema,
} from "@aegis/contracts";
import { z } from "zod";
import type { Db } from "./db.js";
import { rowOf, rowsOf } from "./rows.js";

/**
 * 写入前的输入校验。
 * ⚠️ 必须在 INSERT 之前校验：否则非法数据会进库，直到读回（fromRow 的 Zod 解码）
 *    才暴露 —— 那时错误已经落盘，修复成本高得多。
 */
export const CreateTaskInputSchema = z
  .object({
    title: z.string().min(1).max(200),
    notes: z.string().max(4_000).nullable().optional(),
    priority: PrioritySchema.optional(),
    enabled: z.boolean().optional(),
    recurrence: RecurrenceRuleSchema,
    catchupWindowS: z.number().int().nonnegative().optional(),
    snoozeDefaultS: z.number().int().positive().optional(),
    dndOverride: DndOverrideSchema.optional(),
  })
  .strict();

/** 任务更新的入参校验；字段可选，未提供的字段不会被覆盖 */
export const UpdateTaskPatchSchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    notes: z.string().max(4_000).nullable().optional(),
    priority: PrioritySchema.optional(),
    enabled: z.boolean().optional(),
    recurrence: RecurrenceRuleSchema.optional(),
    catchupWindowS: z.number().int().nonnegative().optional(),
    snoozeDefaultS: z.number().int().positive().optional(),
    dndOverride: DndOverrideSchema.optional(),
  })
  .strict();

/** 创建任务的入参（调用方视角，id/时间戳由 DAO 生成） */
export interface CreateTaskInput {
  title: string;
  notes?: string | null;
  priority?: Task["priority"];
  enabled?: boolean;
  recurrence: RecurrenceRule;
  catchupWindowS?: number;
  snoozeDefaultS?: number;
  dndOverride?: Task["dndOverride"];
}

/** 任务部分更新；`recurrence` 提供时整体替换重复规则 */
export interface UpdateTaskPatch {
  title?: string;
  notes?: string | null;
  priority?: Task["priority"];
  enabled?: boolean;
  recurrence?: RecurrenceRule;
  catchupWindowS?: number;
  snoozeDefaultS?: number;
  dndOverride?: Task["dndOverride"];
}

/** 任务列表过滤条件 */
export interface ListTasksFilter {
  /** 只看启用且未删除的 */
  onlyEnabled?: boolean;
  /** 包含已软删除的 */
  includeDeleted?: boolean;
  limit?: number;
}

interface TaskRow {
  id: string;
  title: string;
  notes: string | null;
  priority: string;
  enabled: number;
  rrule: string | null;
  dtstart_wall: string;
  tzid: string;
  until_wall: string | null;
  count_limit: number | null;
  fired_count: number;
  catchup_window_s: number;
  snooze_default_s: number;
  dnd_override: string;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

function fromRow(row: TaskRow): Task {
  // 经 Zod 解码：字段缺失/类型漂移会在这里抛错，而不是流入业务逻辑
  return TaskSchema.parse({
    id: row.id,
    title: row.title,
    notes: row.notes,
    priority: row.priority,
    enabled: row.enabled === 1,
    recurrence: {
      rrule: row.rrule,
      dtstartWall: row.dtstart_wall,
      tzid: row.tzid,
      untilWall: row.until_wall,
      countLimit: row.count_limit,
    },
    catchupWindowS: row.catchup_window_s,
    snoozeDefaultS: row.snooze_default_s,
    dndOverride: row.dnd_override,
    firedCount: row.fired_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  });
}

const SELECT_COLUMNS = `id, title, notes, priority, enabled, rrule, dtstart_wall, tzid,
  until_wall, count_limit, fired_count, catchup_window_s, snooze_default_s,
  dnd_override, created_at, updated_at, deleted_at`;

/**
 * 提醒任务 DAO。
 *
 * 约定：写入前 Zod 校验（避免脏数据落库）、读取出口 Zod 解码（格式漂移在边界暴露）、
 * 布尔字段显式在 INTEGER 与 boolean 之间转换、时间通过注入的 `now` 获取。
 */
export class TaskDao {
  readonly #db: Db;
  readonly #now: () => number;

  constructor(db: Db, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
  }

  create(rawInput: CreateTaskInput): Task {
    // 写入前校验：非法输入直接抛错，绝不落盘
    const input = CreateTaskInputSchema.parse(rawInput);
    const id = randomUUID();
    const at = this.#now();
    const r = input.recurrence;

    this.#db
      .prepare(
        `INSERT INTO task
           (id, title, notes, priority, enabled, rrule, dtstart_wall, tzid,
            until_wall, count_limit, fired_count, catchup_window_s, snooze_default_s,
            dnd_override, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        id,
        input.title,
        input.notes ?? null,
        input.priority ?? "normal",
        (input.enabled ?? true) ? 1 : 0,
        r.rrule,
        r.dtstartWall,
        r.tzid,
        r.untilWall,
        r.countLimit,
        input.catchupWindowS ?? 43_200,
        input.snoozeDefaultS ?? 600,
        input.dndOverride ?? "inherit",
        at,
        at,
      );

    const created = this.getById(id);
    if (!created) throw new Error(`任务创建后无法读回：${id}`);
    return created;
  }

  getById(id: string): Task | null {
    const row = rowOf<TaskRow>(this.#db.prepare(`SELECT ${SELECT_COLUMNS} FROM task WHERE id = ?`), id);
    return row ? fromRow(row) : null;
  }

  list(filter: ListTasksFilter = {}): Task[] {
    const where: string[] = [];
    if (!filter.includeDeleted) where.push("deleted_at IS NULL");
    if (filter.onlyEnabled) where.push("enabled = 1");
    const sql = `SELECT ${SELECT_COLUMNS} FROM task
      ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY dtstart_wall ASC LIMIT ?`;
    const rows = rowsOf<TaskRow>(this.#db.prepare(sql), filter.limit ?? 500);
    return rows.map(fromRow);
  }

  /** 部分更新；返回更新后的任务，任务不存在或已删除返回 null */
  update(id: string, rawPatch: UpdateTaskPatch): Task | null {
    const patch = UpdateTaskPatchSchema.parse(rawPatch);
    const current = this.getById(id);
    if (!current || current.deletedAt !== null) return null;

    const sets: string[] = [];
    const args: Array<string | number | null> = [];
    const push = (col: string, value: string | number | null): void => {
      sets.push(`${col} = ?`);
      args.push(value);
    };

    if (patch.title !== undefined) push("title", patch.title);
    if (patch.notes !== undefined) push("notes", patch.notes);
    if (patch.priority !== undefined) push("priority", patch.priority);
    if (patch.enabled !== undefined) push("enabled", patch.enabled ? 1 : 0);
    if (patch.catchupWindowS !== undefined) push("catchup_window_s", patch.catchupWindowS);
    if (patch.snoozeDefaultS !== undefined) push("snooze_default_s", patch.snoozeDefaultS);
    if (patch.dndOverride !== undefined) push("dnd_override", patch.dndOverride);

    if (patch.recurrence !== undefined) {
      const r = patch.recurrence;
      push("rrule", r.rrule);
      push("dtstart_wall", r.dtstartWall);
      push("tzid", r.tzid);
      push("until_wall", r.untilWall);
      push("count_limit", r.countLimit);
    }

    if (sets.length === 0) return current;

    const at = this.#now();
    push("updated_at", at);
    args.push(id);

    this.#db.prepare(`UPDATE task SET ${sets.join(", ")} WHERE id = ?`).run(...args);
    return this.getById(id);
  }

  /**
   * 设置任务对免打扰的覆盖策略。
   *
   * 单独成方法而不是走 `update`：`update` 的 patch 契约里刻意不含该字段
   * （它属于"全局设置"而非任务内容，避免 UI 误改）。
   */
  setDndOverride(id: string, override: "inherit" | "allow" | "block"): boolean {
    const res = this.#db
      .prepare("UPDATE task SET dnd_override = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL")
      .run(override, this.#now(), id);
    return Number(res.changes) > 0;
  }

  setEnabled(id: string, enabled: boolean): boolean {
    const at = this.#now();
    const res = this.#db
      .prepare("UPDATE task SET enabled = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL")
      .run(enabled ? 1 : 0, at, id);
    return Number(res.changes) > 0;
  }

  /** 软删除（默认）：保留历史与实例记录 */
  softDelete(id: string): boolean {
    const at = this.#now();
    const res = this.#db
      .prepare(
        "UPDATE task SET deleted_at = ?, enabled = 0, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
      )
      .run(at, at, id);
    return Number(res.changes) > 0;
  }

  /** 硬删除：级联删除实例/通知（谨慎使用） */
  hardDelete(id: string): boolean {
    const res = this.#db.prepare("DELETE FROM task WHERE id = ?").run(id);
    return Number(res.changes) > 0;
  }

  /** 递增已触发次数（供调度器使用） */
  incrementFiredCount(id: string, by = 1): void {
    const at = this.#now();
    this.#db
      .prepare("UPDATE task SET fired_count = fired_count + ?, updated_at = ? WHERE id = ?")
      .run(by, at, id);
  }

  /**
   * 批量暂停/恢复全部未删除任务（对应 `ctrl.pauseAll` / `ctrl.resumeAll`）。
   *
   * 为什么用一条 SQL 而不是遍历：十万级任务遍历会产生同样多的提交；
   * 且"全暂停"必须是原子的 —— 中途失败留下"一半暂停"的状态会让用户困惑。
   *
   * @returns 受影响的任务数
   */
  setAllEnabled(enabled: boolean): number {
    const res = this.#db
      .prepare("UPDATE task SET enabled = ?, updated_at = ? WHERE deleted_at IS NULL AND enabled <> ?")
      .run(enabled ? 1 : 0, this.#now(), enabled ? 1 : 0);
    return Number(res.changes);
  }

  count(): number {
    const row = rowOf<{ n: number }>(
      this.#db.prepare("SELECT COUNT(*) AS n FROM task WHERE deleted_at IS NULL"),
    );
    return row?.n ?? 0;
  }
}
