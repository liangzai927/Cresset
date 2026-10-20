/**
 * 监测器统一接口（M2 / PRD FR-B1）
 *
 * 所有数据源都实现同一套 `Monitor`：调用方只认"扫描一次 → 得到事实/错误"，
 * 不关心底层是文件、网页还是系统指标。调度、限流、去重都由上层负责。
 */

/** M2 监测器可能声明的权限；与 Skill 权限使用同一套字符串 */
export type MonitorPermission = "files.read" | "system.read" | "network.read";

/** 一条监测事实；`fields` 直接交给规则引擎做条件判断 */
export type MonitorFactKind =
  | "file.added"
  | "file.modified"
  | "file.deleted"
  | "file.renamed"
  | "web.changed"
  | "system.threshold";

/** 监测事实 */
export interface MonitorFact {
  /** 监测器 id，对应 Skill trigger.monitor */
  monitor: string;
  kind: MonitorFactKind;
  /** 事实产生时刻（注入的 Clock） */
  at: number;
  fields: Record<string, unknown>;
}

/** 单个文件/条目的采集错误；不能静默跳过 */
export interface MonitorError {
  path: string;
  message: string;
}

/** 一次扫描结果 */
export interface MonitorScanResult {
  facts: MonitorFact[];
  errors: MonitorError[];
}

/** 监测器接口：每次 scan 都是无状态调用，状态由实现内部维护 */
export interface Monitor {
  readonly id: string;
  readonly permission: MonitorPermission;
  scan(): Promise<MonitorScanResult>;
}
