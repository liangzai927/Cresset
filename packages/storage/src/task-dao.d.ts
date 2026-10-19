import { type RecurrenceRule, type Task } from "@aegis/contracts";
import { z } from "zod";
import type { Db } from "./db.js";
/**
 * 写入前的输入校验。
 * ⚠️ 必须在 INSERT 之前校验：否则非法数据会进库，直到读回（fromRow 的 Zod 解码）
 *    才暴露 —— 那时错误已经落盘，修复成本高得多。
 */
export declare const CreateTaskInputSchema: z.ZodObject<{
    title: z.ZodString;
    notes: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    priority: z.ZodOptional<z.ZodEnum<["normal", "important"]>>;
    enabled: z.ZodOptional<z.ZodBoolean>;
    recurrence: z.ZodObject<{
        rrule: z.ZodNullable<z.ZodString>;
        dtstartWall: z.ZodString;
        tzid: z.ZodDefault<z.ZodUnion<[z.ZodLiteral<"system">, z.ZodString]>>;
        untilWall: z.ZodDefault<z.ZodNullable<z.ZodString>>;
        countLimit: z.ZodDefault<z.ZodNullable<z.ZodNumber>>;
    }, "strict", z.ZodTypeAny, {
        rrule: string | null;
        dtstartWall: string;
        tzid: string;
        untilWall: string | null;
        countLimit: number | null;
    }, {
        rrule: string | null;
        dtstartWall: string;
        tzid?: string | undefined;
        untilWall?: string | null | undefined;
        countLimit?: number | null | undefined;
    }>;
    catchupWindowS: z.ZodOptional<z.ZodNumber>;
    snoozeDefaultS: z.ZodOptional<z.ZodNumber>;
    dndOverride: z.ZodOptional<z.ZodEnum<["inherit", "allow", "block"]>>;
}, "strict", z.ZodTypeAny, {
    title: string;
    recurrence: {
        rrule: string | null;
        dtstartWall: string;
        tzid: string;
        untilWall: string | null;
        countLimit: number | null;
    };
    notes?: string | null | undefined;
    priority?: "normal" | "important" | undefined;
    enabled?: boolean | undefined;
    catchupWindowS?: number | undefined;
    snoozeDefaultS?: number | undefined;
    dndOverride?: "inherit" | "allow" | "block" | undefined;
}, {
    title: string;
    recurrence: {
        rrule: string | null;
        dtstartWall: string;
        tzid?: string | undefined;
        untilWall?: string | null | undefined;
        countLimit?: number | null | undefined;
    };
    notes?: string | null | undefined;
    priority?: "normal" | "important" | undefined;
    enabled?: boolean | undefined;
    catchupWindowS?: number | undefined;
    snoozeDefaultS?: number | undefined;
    dndOverride?: "inherit" | "allow" | "block" | undefined;
}>;
/** 任务更新的入参校验；字段可选，未提供的字段不会被覆盖 */
export declare const UpdateTaskPatchSchema: z.ZodObject<{
    title: z.ZodOptional<z.ZodString>;
    notes: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    priority: z.ZodOptional<z.ZodEnum<["normal", "important"]>>;
    enabled: z.ZodOptional<z.ZodBoolean>;
    recurrence: z.ZodOptional<z.ZodObject<{
        rrule: z.ZodNullable<z.ZodString>;
        dtstartWall: z.ZodString;
        tzid: z.ZodDefault<z.ZodUnion<[z.ZodLiteral<"system">, z.ZodString]>>;
        untilWall: z.ZodDefault<z.ZodNullable<z.ZodString>>;
        countLimit: z.ZodDefault<z.ZodNullable<z.ZodNumber>>;
    }, "strict", z.ZodTypeAny, {
        rrule: string | null;
        dtstartWall: string;
        tzid: string;
        untilWall: string | null;
        countLimit: number | null;
    }, {
        rrule: string | null;
        dtstartWall: string;
        tzid?: string | undefined;
        untilWall?: string | null | undefined;
        countLimit?: number | null | undefined;
    }>>;
    catchupWindowS: z.ZodOptional<z.ZodNumber>;
    snoozeDefaultS: z.ZodOptional<z.ZodNumber>;
    dndOverride: z.ZodOptional<z.ZodEnum<["inherit", "allow", "block"]>>;
}, "strict", z.ZodTypeAny, {
    title?: string | undefined;
    notes?: string | null | undefined;
    priority?: "normal" | "important" | undefined;
    enabled?: boolean | undefined;
    recurrence?: {
        rrule: string | null;
        dtstartWall: string;
        tzid: string;
        untilWall: string | null;
        countLimit: number | null;
    } | undefined;
    catchupWindowS?: number | undefined;
    snoozeDefaultS?: number | undefined;
    dndOverride?: "inherit" | "allow" | "block" | undefined;
}, {
    title?: string | undefined;
    notes?: string | null | undefined;
    priority?: "normal" | "important" | undefined;
    enabled?: boolean | undefined;
    recurrence?: {
        rrule: string | null;
        dtstartWall: string;
        tzid?: string | undefined;
        untilWall?: string | null | undefined;
        countLimit?: number | null | undefined;
    } | undefined;
    catchupWindowS?: number | undefined;
    snoozeDefaultS?: number | undefined;
    dndOverride?: "inherit" | "allow" | "block" | undefined;
}>;
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
/**
 * 提醒任务 DAO。
 *
 * 约定：写入前 Zod 校验（避免脏数据落库）、读取出口 Zod 解码（格式漂移在边界暴露）、
 * 布尔字段显式在 INTEGER 与 boolean 之间转换、时间通过注入的 `now` 获取。
 */
export declare class TaskDao {
    #private;
    constructor(db: Db, now?: () => number);
    create(rawInput: CreateTaskInput): Task;
    getById(id: string): Task | null;
    list(filter?: ListTasksFilter): Task[];
    /** 部分更新；返回更新后的任务，任务不存在或已删除返回 null */
    update(id: string, rawPatch: UpdateTaskPatch): Task | null;
    /**
     * 设置任务对免打扰的覆盖策略。
     *
     * 单独成方法而不是走 `update`：`update` 的 patch 契约里刻意不含该字段
     * （它属于"全局设置"而非任务内容，避免 UI 误改）。
     */
    setDndOverride(id: string, override: "inherit" | "allow" | "block"): boolean;
    setEnabled(id: string, enabled: boolean): boolean;
    /** 软删除（默认）：保留历史与实例记录 */
    softDelete(id: string): boolean;
    /** 硬删除：级联删除实例/通知（谨慎使用） */
    hardDelete(id: string): boolean;
    /** 递增已触发次数（供调度器使用） */
    incrementFiredCount(id: string, by?: number): void;
    /**
     * 批量暂停/恢复全部未删除任务（对应 `ctrl.pauseAll` / `ctrl.resumeAll`）。
     *
     * 为什么用一条 SQL 而不是遍历：十万级任务遍历会产生同样多的提交；
     * 且"全暂停"必须是原子的 —— 中途失败留下"一半暂停"的状态会让用户困惑。
     *
     * @returns 受影响的任务数
     */
    setAllEnabled(enabled: boolean): number;
    count(): number;
}
//# sourceMappingURL=task-dao.d.ts.map