/**
 * 审计仓储（M0 骨架）
 *
 * 铁律（NFR-SP5 / PRD §8.2）：审计记录**只存哈希与检测器摘要，绝不存原文**。
 * 因此本模块的写入接口根本不接受原文参数 —— 从类型层面杜绝误写。
 */
import { randomUUID } from "node:crypto";
import type { Db } from "./db.js";
import { rowOf, rowsOf } from "./rows.js";

/** 一条外发审计；接口层面无法传入原文（刻意的类型约束，见 NFR-SP5） */
export interface AuditEntry {
  /** 发起方：daemon / user / 未来的 employee id */
  actor: string;
  purpose: string;
  /** 目标：provider/model */
  destination: string;
  /** 数据分级 L0..L3 */
  dataClass: string;
  /** 命中的检测器摘要（类别 + 次数），不含原文 */
  detectorSummary: Array<{ category: string; count: number }>;
  redactionCount: number;
  policyVersion: string;
  /** 载荷哈希（唯一允许保留的"内容身份"） */
  payloadSha256: string;
  outcome: "allowed" | "blocked" | "failed";
}

/** 已落库的审计记录（含生成的 id 与落库时间） */
export interface StoredAuditEntry extends AuditEntry {
  id: string;
  at: number;
}

interface AuditRow {
  id: string;
  at: number;
  actor: string;
  purpose: string;
  destination: string;
  data_class: string;
  detectors_hit: string | null;
  redaction_count: number;
  policy_version: string;
  payload_sha256: string;
  outcome: string;
}

/** 外发审计读写；只存哈希与检测器摘要，绝不存原文 */
export class AuditRepo {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /**
   * 写入一条外发审计。
   * 注意：入参没有任何字段可以携带原文 —— 这是刻意的设计约束。
   */
  record(entry: AuditEntry, now: number = Date.now()): StoredAuditEntry {
    const id = randomUUID();
    this.#db
      .prepare(
        `INSERT INTO outbound_audit
           (id, at, actor, purpose, destination, data_class, detectors_hit,
            redaction_count, policy_version, payload_sha256, outcome)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        now,
        entry.actor,
        entry.purpose,
        entry.destination,
        entry.dataClass,
        JSON.stringify(entry.detectorSummary),
        entry.redactionCount,
        entry.policyVersion,
        entry.payloadSha256,
        entry.outcome,
      );
    return { ...entry, id, at: now };
  }

  recent(limit = 50): StoredAuditEntry[] {
    const rows = rowsOf<AuditRow>(
      this.#db.prepare(
        `SELECT id, at, actor, purpose, destination, data_class, detectors_hit,
                redaction_count, policy_version, payload_sha256, outcome
           FROM outbound_audit ORDER BY at DESC LIMIT ?`,
      ),
      limit,
    );
    return rows.map(toEntry);
  }

  /** 统计：按结果分组（用于"零绕过/零外泄"指标的日常核对） */
  countByOutcome(): Record<string, number> {
    const rows = rowsOf<{ outcome: string; n: number }>(
      this.#db.prepare("SELECT outcome, COUNT(*) AS n FROM outbound_audit GROUP BY outcome"),
    );
    return Object.fromEntries(rows.map((r) => [r.outcome, r.n]));
  }

  count(): number {
    const row = rowOf<{ n: number }>(this.#db.prepare("SELECT COUNT(*) AS n FROM outbound_audit"));
    return row?.n ?? 0;
  }
}

function toEntry(r: AuditRow): StoredAuditEntry {
  let summary: Array<{ category: string; count: number }> = [];
  if (r.detectors_hit) {
    try {
      const parsed: unknown = JSON.parse(r.detectors_hit);
      if (Array.isArray(parsed)) summary = parsed as Array<{ category: string; count: number }>;
    } catch {
      summary = [];
    }
  }
  return {
    id: r.id,
    at: r.at,
    actor: r.actor,
    purpose: r.purpose,
    destination: r.destination,
    dataClass: r.data_class,
    detectorSummary: summary,
    redactionCount: r.redaction_count,
    policyVersion: r.policy_version,
    payloadSha256: r.payload_sha256,
    outcome: r.outcome as AuditEntry["outcome"],
  };
}
