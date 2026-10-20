/**
 * 系统健康监测器（M2 / PRD FR-B4）
 *
 * 一次采集产生一条 `system.threshold` 事实，字段供 Skill 的阈值触发器使用：
 * load1 / memory_free_percent / disk_free_percent / uptime_s …
 *
 * 采集器可注入：真实环境用 node:os + statfs，单测用固定值，
 * 避免测试依赖机器的 CPU/磁盘状态。
 */

import { statfsSync } from "node:fs";
import { cpus, freemem, loadavg, totalmem, uptime } from "node:os";
import { type Clock, SystemClock } from "@aegis/clock";
import type { Monitor, MonitorError, MonitorFact, MonitorScanResult } from "./types.js";

/** 一组可替换的系统采集函数 */
export interface SystemCollectors {
  loadavg: () => number[];
  memory: () => { totalBytes: number; freeBytes: number };
  disk: () => { totalBytes: number; freeBytes: number };
  uptime: () => number;
  cpuCount: () => number;
}

/** 系统监测器配置 */
export interface SystemMonitorOptions {
  id?: string;
  mount?: string;
  clock?: Clock;
  collectors?: Partial<SystemCollectors>;
}

/** 百分比，保留一位小数；分母为 0 时返回 0 */
function percent(part: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((part / total) * 1_000) / 10;
}

/** GB，保留一位小数 */
function gb(bytes: number): number {
  return Math.round((bytes / 1024 / 1024 / 1024) * 10) / 10;
}

/** 真实系统采集器 */
function defaultCollectors(mount: string): SystemCollectors {
  return {
    loadavg: () => loadavg(),
    memory: () => ({ totalBytes: totalmem(), freeBytes: freemem() }),
    disk: () => {
      const st = statfsSync(mount);
      const blockSize = Number(st.bsize);
      return {
        totalBytes: Number(st.blocks) * blockSize,
        freeBytes: Number(st.bavail) * blockSize,
      };
    },
    uptime: () => uptime(),
    cpuCount: () => cpus().length,
  };
}

/** 系统监测器实现 */
export class SystemMonitor implements Monitor {
  readonly id: string;
  readonly permission = "system.read" as const;
  readonly #clock: Clock;
  readonly #collectors: SystemCollectors;
  readonly #mount: string;

  constructor(options: SystemMonitorOptions = {}) {
    this.id = options.id ?? "system.host";
    this.#mount = options.mount ?? "/";
    this.#clock = options.clock ?? new SystemClock();
    this.#collectors = { ...defaultCollectors(this.#mount), ...(options.collectors ?? {}) };
  }

  /** 采集一次系统指标；任何一项失败都进入 errors，不静默 */
  async scan(): Promise<MonitorScanResult> {
    const facts: MonitorFact[] = [];
    const errors: MonitorError[] = [];
    const at = this.#clock.wall();

    try {
      const load = this.#collectors.loadavg();
      const memory = this.#collectors.memory();
      const disk = this.#collectors.disk();
      const cpuCount = this.#collectors.cpuCount();

      facts.push({
        monitor: this.id,
        kind: "system.threshold",
        at,
        fields: {
          mount: this.#mount,
          cpu_count: cpuCount,
          load1: load[0] ?? 0,
          load5: load[1] ?? 0,
          load15: load[2] ?? 0,
          memory_total_gb: gb(memory.totalBytes),
          memory_free_gb: gb(memory.freeBytes),
          memory_free_percent: percent(memory.freeBytes, memory.totalBytes),
          disk_total_gb: gb(disk.totalBytes),
          disk_free_gb: gb(disk.freeBytes),
          disk_free_percent: percent(disk.freeBytes, disk.totalBytes),
          uptime_s: Math.round(this.#collectors.uptime()),
          at,
        },
      });
    } catch (err) {
      errors.push({ path: this.#mount, message: (err as Error).message });
    }

    return { facts, errors };
  }
}
