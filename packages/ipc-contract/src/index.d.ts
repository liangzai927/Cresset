/**
 * daemon ↔ UI 的 IPC 契约（两侧共享单一真相源）
 *
 * 依据《M0+M1 详细设计》§7：
 *   - 传输：UDS（macOS/Linux）/ NamedPipe（Windows），NDJSON 分帧，JSON-RPC 2.0
 *   - 鉴权：握手 token（首帧必须是 sys.hello）
 *   - 事件：daemon → UI 单向推送
 *
 * ⚠️ 契约变更必须同步快照测试，避免两侧版本漂移。
 */
import { z } from "zod";
/** 协议版本：不匹配时 UI 必须提示升级，而不是静默错乱 */
export declare const PROTOCOL_VERSION = 1;
/** JSON-RPC 错误码；客户端应优先用 code 判断，message 仅作展示 */
export declare const RpcErrorCode: {
    readonly E_PROTOCOL: -32000;
    readonly E_AUTH: -32001;
    readonly E_METHOD_NOT_FOUND: -32601;
    readonly E_INVALID_PARAMS: -32602;
    readonly E_INTERNAL: -32603;
};
/** 需要用户选择重复方式时的输入形态（UI 友好，服务端翻译成 RRULE） */
export declare const RepeatModeSchema: z.ZodEnum<{
    once: "once";
    daily: "daily";
    weekly: "weekly";
    monthly: "monthly";
    weekdays: "weekdays";
    every_minutes: "every_minutes";
    custom_rrule: "custom_rrule";
}>;
export type RepeatMode = z.infer<typeof RepeatModeSchema>;
/** 创建任务的入参（UI 友好形态：repeat.mode 由服务端翻译成 RRULE） */
export declare const CreateTaskInputSchema: z.ZodObject<{
    title: z.ZodString;
    notes: z.ZodOptional<z.ZodString>;
    priority: import("zod").ZodOptional<import("zod").ZodEnum<["normal", "important"]>>;
    firstFireAtWall: import("zod").ZodString;
    repeat: z.ZodObject<{
        mode: z.ZodEnum<{
            once: "once";
            daily: "daily";
            weekly: "weekly";
            monthly: "monthly";
            weekdays: "weekdays";
            every_minutes: "every_minutes";
            custom_rrule: "custom_rrule";
        }>;
        byWeekday: z.ZodOptional<z.ZodArray<z.ZodNumber>>;
        byMonthDay: z.ZodOptional<z.ZodNumber>;
        intervalMinutes: z.ZodOptional<z.ZodNumber>;
        rrule: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>;
    catchupWindowS: z.ZodOptional<z.ZodNumber>;
    dndOverride: z.ZodOptional<z.ZodEnum<{
        inherit: "inherit";
        allow: "allow";
        block: "block";
    }>>;
}, z.core.$strict>;
export type CreateTaskInput = z.infer<typeof CreateTaskInputSchema>;
/**
 * 任务的对外视图。
 *
 * ⚠️ 刻意与数据库行类型解耦：视图只暴露 UI 需要的字段，并附带 `repeatLabel`
 * 这类**已计算好的人话描述**，避免把展示逻辑泄漏到 UI 层。
 */
export declare const TaskViewSchema: z.ZodObject<{
    id: z.ZodString;
    title: z.ZodString;
    notes: z.ZodNullable<z.ZodString>;
    priority: import("zod").ZodEnum<["normal", "important"]>;
    enabled: z.ZodBoolean;
    repeatLabel: z.ZodString;
    nextFireAt: z.ZodNullable<z.ZodNumber>;
    nextFireWall: import("zod").ZodNullable<import("zod").ZodString>;
    lastFiredAt: z.ZodNullable<z.ZodNumber>;
    firedCount: z.ZodNumber;
}, z.core.$strict>;
export type TaskView = z.infer<typeof TaskViewSchema>;
/** 通知的对外视图；`isCatchup`/`isUncertain` 用于在界面上区分补偿补发与不确定投递 */
export declare const NotificationViewSchema: z.ZodObject<{
    id: z.ZodString;
    kind: import("zod").ZodEnum<["reminder", "catchup_batch", "system_gap", "failure", "digest"]>;
    title: z.ZodString;
    body: z.ZodNullable<z.ZodString>;
    scheduledFor: z.ZodNumber;
    state: z.ZodEnum<{
        pending: "pending";
        delivered: "delivered";
        failed: "failed";
        delivering: "delivering";
        suppressed: "suppressed";
    }>;
    attempts: z.ZodArray<z.ZodObject<{
        channel: z.ZodString;
        outcome: z.ZodString;
        error: z.ZodNullable<z.ZodString>;
    }, z.core.$strip>>;
    isCatchup: z.ZodBoolean;
    isUncertain: z.ZodBoolean;
}, z.core.$strict>;
export type NotificationView = z.infer<typeof NotificationViewSchema>;
/** 健康检查视图；`degradedReasons` 非空时界面必须显式提示（不允许静默降级） */
export declare const HealthViewSchema: z.ZodObject<{
    ok: z.ZodBoolean;
    uptimeS: z.ZodNumber;
    tickCount: z.ZodNumber;
    lastTickAt: z.ZodNullable<z.ZodNumber>;
    nextDueAt: z.ZodNullable<z.ZodNumber>;
    rssBytes: z.ZodNullable<z.ZodNumber>;
    openFds: z.ZodNullable<z.ZodNumber>;
    degradedReasons: z.ZodArray<z.ZodString>;
}, z.core.$strict>;
export type HealthView = z.infer<typeof HealthViewSchema>;
/** RPC 方法表：方法名 → 入参 / 出参 schema（供两侧类型推导与运行时校验） */
export declare const RPC_METHODS: {
    readonly "sys.hello": {
        readonly params: z.ZodObject<{
            token: z.ZodString;
            clientVersion: z.ZodString;
        }, z.core.$strict>;
        readonly result: z.ZodObject<{
            protocolVersion: z.ZodNumber;
            daemonVersion: z.ZodString;
            dataDir: z.ZodString;
            startedAt: z.ZodNumber;
        }, z.core.$strict>;
    };
    readonly "sys.health": {
        readonly params: z.ZodObject<{}, z.core.$strict>;
        readonly result: z.ZodObject<{
            ok: z.ZodBoolean;
            uptimeS: z.ZodNumber;
            tickCount: z.ZodNumber;
            lastTickAt: z.ZodNullable<z.ZodNumber>;
            nextDueAt: z.ZodNullable<z.ZodNumber>;
            rssBytes: z.ZodNullable<z.ZodNumber>;
            openFds: z.ZodNullable<z.ZodNumber>;
            degradedReasons: z.ZodArray<z.ZodString>;
        }, z.core.$strict>;
    };
    readonly "task.list": {
        readonly params: z.ZodObject<{
            filter: z.ZodOptional<z.ZodEnum<{
                today: "today";
                all: "all";
                paused: "paused";
            }>>;
            cursor: z.ZodOptional<z.ZodString>;
            limit: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>;
        readonly result: z.ZodObject<{
            items: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                title: z.ZodString;
                notes: z.ZodNullable<z.ZodString>;
                priority: import("zod").ZodEnum<["normal", "important"]>;
                enabled: z.ZodBoolean;
                repeatLabel: z.ZodString;
                nextFireAt: z.ZodNullable<z.ZodNumber>;
                nextFireWall: import("zod").ZodNullable<import("zod").ZodString>;
                lastFiredAt: z.ZodNullable<z.ZodNumber>;
                firedCount: z.ZodNumber;
            }, z.core.$strict>>;
            nextCursor: z.ZodNullable<z.ZodString>;
        }, z.core.$strict>;
    };
    readonly "task.create": {
        readonly params: z.ZodObject<{
            title: z.ZodString;
            notes: z.ZodOptional<z.ZodString>;
            priority: import("zod").ZodOptional<import("zod").ZodEnum<["normal", "important"]>>;
            firstFireAtWall: import("zod").ZodString;
            repeat: z.ZodObject<{
                mode: z.ZodEnum<{
                    once: "once";
                    daily: "daily";
                    weekly: "weekly";
                    monthly: "monthly";
                    weekdays: "weekdays";
                    every_minutes: "every_minutes";
                    custom_rrule: "custom_rrule";
                }>;
                byWeekday: z.ZodOptional<z.ZodArray<z.ZodNumber>>;
                byMonthDay: z.ZodOptional<z.ZodNumber>;
                intervalMinutes: z.ZodOptional<z.ZodNumber>;
                rrule: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>;
            catchupWindowS: z.ZodOptional<z.ZodNumber>;
            dndOverride: z.ZodOptional<z.ZodEnum<{
                inherit: "inherit";
                allow: "allow";
                block: "block";
            }>>;
        }, z.core.$strict>;
        readonly result: z.ZodObject<{
            id: z.ZodString;
        }, z.core.$strict>;
    };
    readonly "task.complete": {
        readonly params: z.ZodObject<{
            occurrenceId: z.ZodString;
        }, z.core.$strict>;
        readonly result: z.ZodObject<{
            ok: z.ZodBoolean;
        }, z.core.$strict>;
    };
    readonly "task.snooze": {
        readonly params: z.ZodObject<{
            occurrenceId: z.ZodString;
            minutes: z.ZodNumber;
        }, z.core.$strict>;
        readonly result: z.ZodObject<{
            id: z.ZodString;
        }, z.core.$strict>;
    };
    readonly "task.pause": {
        readonly params: z.ZodObject<{
            id: z.ZodString;
        }, z.core.$strict>;
        readonly result: z.ZodObject<{
            ok: z.ZodBoolean;
        }, z.core.$strict>;
    };
    readonly "task.resume": {
        readonly params: z.ZodObject<{
            id: z.ZodString;
        }, z.core.$strict>;
        readonly result: z.ZodObject<{
            ok: z.ZodBoolean;
        }, z.core.$strict>;
    };
    readonly "task.delete": {
        readonly params: z.ZodObject<{
            id: z.ZodString;
            hard: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>;
        readonly result: z.ZodObject<{
            ok: z.ZodBoolean;
        }, z.core.$strict>;
    };
    readonly "notify.history": {
        readonly params: z.ZodObject<{
            cursor: z.ZodOptional<z.ZodString>;
            limit: z.ZodOptional<z.ZodNumber>;
            kind: import("zod").ZodOptional<import("zod").ZodEnum<["reminder", "catchup_batch", "system_gap", "failure", "digest"]>>;
        }, z.core.$strict>;
        readonly result: z.ZodObject<{
            items: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                kind: import("zod").ZodEnum<["reminder", "catchup_batch", "system_gap", "failure", "digest"]>;
                title: z.ZodString;
                body: z.ZodNullable<z.ZodString>;
                scheduledFor: z.ZodNumber;
                state: z.ZodEnum<{
                    pending: "pending";
                    delivered: "delivered";
                    failed: "failed";
                    delivering: "delivering";
                    suppressed: "suppressed";
                }>;
                attempts: z.ZodArray<z.ZodObject<{
                    channel: z.ZodString;
                    outcome: z.ZodString;
                    error: z.ZodNullable<z.ZodString>;
                }, z.core.$strip>>;
                isCatchup: z.ZodBoolean;
                isUncertain: z.ZodBoolean;
            }, z.core.$strict>>;
            nextCursor: z.ZodNullable<z.ZodString>;
        }, z.core.$strict>;
    };
    /** 测试通知：首次启动向导用它让用户立刻验证"它真的会响" */
    readonly "notify.test": {
        readonly params: z.ZodObject<{}, z.core.$strict>;
        readonly result: z.ZodObject<{
            ok: z.ZodBoolean;
        }, z.core.$strict>;
    };
    readonly "ctrl.pauseAll": {
        readonly params: z.ZodObject<{
            untilAt: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>;
        readonly result: z.ZodObject<{
            ok: z.ZodBoolean;
        }, z.core.$strict>;
    };
    readonly "ctrl.resumeAll": {
        readonly params: z.ZodObject<{}, z.core.$strict>;
        readonly result: z.ZodObject<{
            ok: z.ZodBoolean;
        }, z.core.$strict>;
    };
    readonly "dnd.get": {
        readonly params: z.ZodObject<{}, z.core.$strict>;
        readonly result: z.ZodObject<{
            enabled: z.ZodBoolean;
            windows: z.ZodArray<z.ZodObject<{
                days: z.ZodArray<z.ZodNumber>;
                from: z.ZodString;
                to: z.ZodString;
            }, z.core.$strict>>;
        }, z.core.$strict>;
    };
    readonly "platform.permissionStatus": {
        readonly params: z.ZodObject<{}, z.core.$strict>;
        readonly result: z.ZodObject<{
            notifications: z.ZodEnum<{
                unknown: "unknown";
                granted: "granted";
                denied: "denied";
            }>;
        }, z.core.$strict>;
    };
    readonly "platform.autostartSet": {
        readonly params: z.ZodObject<{
            enabled: z.ZodBoolean;
        }, z.core.$strict>;
        readonly result: z.ZodObject<{
            ok: z.ZodBoolean;
            error: z.ZodNullable<z.ZodString>;
        }, z.core.$strict>;
    };
    readonly "backup.export": {
        readonly params: z.ZodObject<{
            targetDir: z.ZodString;
            includeHistory: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>;
        readonly result: z.ZodObject<{
            path: z.ZodString;
        }, z.core.$strict>;
    };
    readonly "diag.recentLogs": {
        readonly params: z.ZodObject<{
            limit: z.ZodNumber;
        }, z.core.$strict>;
        readonly result: z.ZodObject<{
            lines: z.ZodArray<z.ZodString>;
        }, z.core.$strict>;
    };
};
export type RpcMethod = keyof typeof RPC_METHODS;
/** 事件流：daemon → UI */
export declare const EVENTS: {
    readonly "task.changed": z.ZodObject<{
        id: z.ZodString;
        reason: z.ZodEnum<{
            created: "created";
            updated: "updated";
            deleted: "deleted";
            fired: "fired";
        }>;
    }, z.core.$strict>;
    readonly "occurrence.changed": z.ZodObject<{
        id: z.ZodString;
        taskId: z.ZodString;
        state: z.ZodString;
    }, z.core.$strict>;
    readonly "notification.fired": z.ZodObject<{
        notificationId: z.ZodString;
        taskId: z.ZodNullable<z.ZodString>;
        title: z.ZodString;
    }, z.core.$strict>;
    /** 投递失败必须显式暴露，不允许静默（PRD NFR-W2） */
    readonly "notification.failed": z.ZodObject<{
        notificationId: z.ZodString;
        channel: z.ZodString;
        error: z.ZodString;
    }, z.core.$strict>;
    readonly "runtime.gap": z.ZodObject<{
        gapStart: z.ZodNumber;
        gapEnd: z.ZodNumber;
        cause: z.ZodString;
    }, z.core.$strict>;
    readonly "runtime.degraded": z.ZodObject<{
        reason: z.ZodString;
    }, z.core.$strict>;
};
export type EventName = keyof typeof EVENTS;
//# sourceMappingURL=index.d.ts.map