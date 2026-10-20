/**
 * M2 监测器运行时：把 Monitor 事实接到 Skill 规则引擎与通知域
 *
 * 启动时由 bootstrap 构造绑定（Monitor + 已校验的 Skills + 间隔），
 * 运行时负责定时扫描、去重/冷却、生成 `kind=monitor` 通知。
 *
 * 设计边界：
 *   - 监测器只产事实；这里不执行脚本、不调模型；
 *   - 冷却状态持久化在 `monitor_cooldown`，重启不会立刻重复告警；
 *   - 任何 Skill 评估/监测失败都写日志，不静默。
 */

import type { Clock } from "@aegis/clock";
import type { Monitor } from "@aegis/monitors";
import type { Scheduler } from "@aegis/scheduler";
import type { Skill } from "@aegis/skills";
import { evaluateSkill } from "@aegis/skills";
import { type Db, rowOf } from "@aegis/storage";

/** 一个监测器实例与它绑定的 Skill */
export interface MonitorBinding {
  monitor: Monitor;
  /** 配置里的监测器类型，供状态页展示 */
  kind: "files" | "system" | "web";
  skills: Skill[];
  /** 扫描间隔（毫秒） */
  intervalMs: number;
}

/** 单个监测器的运行状态 */
export interface MonitorStatus {
  id: string;
  kind: "files" | "system" | "web";
  intervalMs: number;
  skills: string[];
  lastScanAt: number | null;
  lastFacts: number;
  lastNotified: number;
  lastErrors: number;
  error: string | null;
  running: boolean;
}

/** 运行时日志出口；与 daemon 的结构化日志对齐 */
export type MonitorLog = (
  level: "debug" | "info" | "warn" | "error",
  event: string,
  detail?: Record<string, unknown>,
) => void;

/** 构造参数 */
export interface MonitorRuntimeOptions {
  db: Db;
  clock: Clock;
  scheduler: Scheduler;
  bindings: MonitorBinding[];
  onLog?: MonitorLog;
}

/** cooldown 字符串（6h / 30m / 1d）→ 毫秒 */
export function parseCooldown(value: string): number {
  const n = Number(value.slice(0, -1));
  const unit = value.slice(-1);
  const multiplier = unit === "s" ? 1_000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
  return Math.max(1, n * multiplier);
}

/** 监测器运行时 */
export class MonitorRuntime {
  readonly #db: Db;
  readonly #clock: Clock;
  readonly #scheduler: Scheduler;
  readonly #bindings: MonitorBinding[];
  readonly #log: MonitorLog;
  readonly #timers: NodeJS.Timeout[] = [];
  readonly #busy = new Set<string>();
  readonly #status = new Map<string, MonitorStatus>();

  constructor(options: MonitorRuntimeOptions) {
    this.#db = options.db;
    this.#clock = options.clock;
    this.#scheduler = options.scheduler;
    this.#bindings = options.bindings;
    this.#log = options.onLog ?? (() => {});
    for (const binding of options.bindings) {
      this.#status.set(binding.monitor.id, {
        id: binding.monitor.id,
        kind: binding.kind,
        intervalMs: binding.intervalMs,
        skills: binding.skills.map((s) => s.name),
        lastScanAt: null,
        lastFacts: 0,
        lastNotified: 0,
        lastErrors: 0,
        error: null,
        running: false,
      });
    }
  }

  /** 启动扫描循环（立即扫一次，然后按 interval 轮询） */
  start(): void {
    for (const binding of this.#bindings) {
      void this.#scan(binding);
      const timer = setInterval(() => void this.#scan(binding), binding.intervalMs);
      this.#timers.push(timer);
    }
  }

  /** 停止所有定时器 */
  stop(): void {
    for (const timer of this.#timers) clearInterval(timer);
    this.#timers.length = 0;
  }

  /** 当前状态快照；供 `monitor.status` IPC 与设置页使用 */
  status(): MonitorStatus[] {
    return [...this.#status.values()].map((s) => ({ ...s, skills: [...s.skills] }));
  }

  /** 立即扫描指定的监测器；id 不存在时返回 null（由 IPC 转成 found=false） */
  async scanById(id: string): Promise<{ notified: number; errors: number } | null> {
    const binding = this.#bindings.find((b) => b.monitor.id === id);
    if (!binding) return null;
    return this.#scan(binding);
  }

  /** 测试/诊断入口：立即扫描全部绑定，返回本轮统计 */
  async scanOnce(): Promise<{ notified: number; errors: number }> {
    const totals = { notified: 0, errors: 0 };
    for (const binding of this.#bindings) {
      const r = await this.#scan(binding);
      totals.notified += r.notified;
      totals.errors += r.errors;
    }
    return totals;
  }

  /** 扫描一个绑定；带重入保护，避免上一轮未结束时叠加 */
  async #scan(binding: MonitorBinding): Promise<{ notified: number; errors: number }> {
    const id = binding.monitor.id;
    if (this.#busy.has(id)) {
      this.#log("warn", "monitor.scan_skipped", { monitor: id, reason: "上一轮尚未结束" });
      return { notified: 0, errors: 0 };
    }
    this.#busy.add(id);
    const status = this.#status.get(id);
    if (status) status.running = true;

    let facts = 0;
    let notified = 0;
    let errors = 0;
    let lastError: string | null = null;
    try {
      const result = await binding.monitor.scan();
      facts = result.facts.length;
      for (const err of result.errors) {
        errors += 1;
        lastError = `${err.path}: ${err.message}`;
        this.#log("warn", "monitor.scan_error", { monitor: id, path: err.path, error: err.message });
      }

      const now = this.#clock.wall();
      for (const fact of result.facts) {
        for (const skill of binding.skills) {
          if (skill.trigger.monitor !== binding.monitor.id) continue;
          if (!skill.permissions.includes(binding.monitor.permission)) {
            // 绑定阶段已过滤；这里再兜底，绝不让越权 Skill 执行
            this.#log("error", "monitor.permission_denied", {
              monitor: id,
              skill: skill.name,
              required: binding.monitor.permission,
            });
            errors += 1;
            continue;
          }

          try {
            const decision = evaluateSkill(skill, fact.fields);
            if (!decision) continue;

            const cooldownMs = parseCooldown(skill.cooldown);
            const subject = String(fact.fields.path ?? fact.fields.mount ?? fact.kind);
            const last = rowOf<{ last_notified_at: number }>(
              this.#db.prepare(
                "SELECT last_notified_at FROM monitor_cooldown WHERE skill_name = ? AND subject = ?",
              ),
              skill.name,
              subject,
            );
            if (last && now - last.last_notified_at < cooldownMs) continue;

            const bucket = Math.floor(now / cooldownMs);
            this.#scheduler.daos.notifications.createWithOutbox({
              kind: "monitor",
              title: decision.title,
              body: decision.body,
              priority: decision.priority,
              scheduledFor: now,
              dedupeKey: `monitor:${skill.name}:${subject}:${bucket}`,
            });

            this.#db
              .prepare(
                `INSERT INTO monitor_cooldown (skill_name, subject, last_notified_at)
                 VALUES (?, ?, ?)
                 ON CONFLICT(skill_name, subject) DO UPDATE SET last_notified_at = excluded.last_notified_at`,
              )
              .run(skill.name, subject, now);

            notified += 1;
            this.#log("info", "monitor.notified", {
              monitor: id,
              skill: skill.name,
              subject,
              title: decision.title,
            });
          } catch (err) {
            errors += 1;
            lastError = (err as Error).message;
            this.#log("error", "monitor.evaluate_error", {
              monitor: id,
              skill: skill.name,
              error: (err as Error).message,
            });
          }
        }
      }
    } catch (err) {
      errors += 1;
      lastError = (err as Error).message;
      this.#log("error", "monitor.scan_fatal", { monitor: id, error: (err as Error).message });
    } finally {
      this.#busy.delete(id);
      if (status) {
        status.running = false;
        status.lastScanAt = this.#clock.wall();
        status.lastFacts = facts;
        status.lastNotified = notified;
        status.lastErrors = errors;
        status.error = lastError;
      }
    }

    this.#log("debug", "monitor.scan_done", { monitor: id, facts, notified, errors });
    return { notified, errors };
  }
}
