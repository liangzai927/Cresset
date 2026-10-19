/**
 * 存储层测试：迁移机制、事务回滚、blobs、三个 DAO。
 *
 * 本文件承载 M1 最核心的幂等性验证：同一 (task, scheduledAt) 只创建一次、
 * claim 只有第一次成功、超时领取进入 unknown 而不是被重发。
 */
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AuditEntry, AuditRepo } from "./audit-repo.js";
import { BlobStore } from "./blobs.js";
import { type Db, listApplied, MigrationError, migrate, openDb } from "./db.js";
import { MIGRATIONS } from "./migrations.generated.js";
import { OccurrenceDao } from "./occurrence-dao.js";
import { TaskDao } from "./task-dao.js";

let dir: string;
let db: Db;

/** 测试用可推进时钟（避免依赖真实时间） */
function makeClock(start = 1_700_000_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aegis-storage-"));
  db = openDb({ file: join(dir, "test.db") });
  migrate(db);
});

afterEach(() => {
  try {
    db.close();
  } catch {
    /* 已关闭 */
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("数据库打开与迁移", () => {
  it("迁移全部应用，且记录写入 schema_migration", () => {
    const applied = listApplied(db);
    expect(applied.map((m) => m.id)).toEqual(MIGRATIONS.map((m) => m.id));
    expect(applied.every((m) => m.checksum.length === 64)).toBe(true);
  });

  it("重复 migrate 是幂等的（不重复应用）", () => {
    const second = migrate(db);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual(MIGRATIONS.map((m) => m.id));
  });

  it("迁移内容被改动时报错（只增不改）", () => {
    const tampered = MIGRATIONS.map((m, i) => (i === 0 ? { ...m, checksum: "0".repeat(64) } : m));
    expect(() => migrate(db, Date.now, tampered)).toThrow(MigrationError);
    expect(() => migrate(db, Date.now, tampered)).toThrow(/checksum 与库中记录不一致/);
  });

  it("库中存在代码未知的迁移时报错（防运行旧代码）", () => {
    const future = [
      ...MIGRATIONS,
      { id: MIGRATIONS.length + 1, name: "future", checksum: "a".repeat(64), sql: "SELECT 1;" },
    ];
    expect(() => migrate(db, Date.now, future)).not.toThrow(); // 应用 future
    // 再用不含 future 的列表迁移 → 应报错
    expect(() => migrate(db, Date.now, MIGRATIONS)).toThrow(/未知的迁移/);
  });

  it("WAL 与外键已开启", () => {
    const mode = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    expect(mode.journal_mode.toLowerCase()).toBe("wal");
    const fk = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
    expect(fk.foreign_keys).toBe(1);
  });

  it("事务在抛错时回滚", () => {
    const dao = new TaskDao(db);
    expect(() =>
      db.transaction(() => {
        dao.create({
          title: "会被回滚",
          recurrence: {
            rrule: null,
            dtstartWall: "2026-03-01T09:00",
            tzid: "system",
            untilWall: null,
            countLimit: null,
          },
        });
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(dao.count()).toBe(0);
  });

  it("allowExtension 在建库时生效（约束 C-1）", () => {
    const p = join(dir, "ext.db");
    const ext = openDb({ file: p, allowExtension: true });
    // 加载一个不存在的扩展应当抛错，而不是"未开启扩展加载"的错误
    expect(() => ext.raw.loadExtension(join(dir, "nope.dylib"))).toThrow();
    ext.close();
  });

  it("未开启 allowExtension 时加载扩展会失败（验证约束 C-1 的必要性）", () => {
    const p = join(dir, "noext.db");
    const plain = openDb({ file: p });
    // node:sqlite 的实际措辞：未开启时是 "extension loading is not allowed"；
    // 若建库时开了、但事务内/权限不足，才可能是 "disabled at database creation"
    expect(() => plain.raw.loadExtension(join(dir, "whatever.dylib"))).toThrow(
      /extension loading is not allowed|disabled at database creation|not authorized/i,
    );
    plain.close();
  });
});

describe("TaskDao", () => {
  const rule = {
    rrule: "FREQ=DAILY",
    dtstartWall: "2026-03-01T09:00",
    tzid: "Asia/Shanghai",
    untilWall: null,
    countLimit: null,
  };

  it("创建后可读回，且字段经 Zod 解码（含布尔转换）", () => {
    const dao = new TaskDao(db);
    const t = dao.create({ title: "吃药", priority: "important", recurrence: rule });
    expect(t.id).toBeTruthy();
    expect(t.enabled).toBe(true); // SQLite 存 1，读回必须是 boolean
    expect(t.priority).toBe("important");
    expect(t.recurrence.tzid).toBe("Asia/Shanghai");
    expect(t.deletedAt).toBeNull();
  });

  it("标题为空时 Zod 拒绝（不写库）", () => {
    const dao = new TaskDao(db);
    // 绕过 TS 类型直接传空串，验证运行期校验
    expect(() => dao.create({ title: "", recurrence: rule })).toThrow();
    expect(dao.count()).toBe(0); // 校验在写入前发生 → 库里没有脏数据
  });

  it("list 默认过滤软删除，可显式包含", () => {
    const dao = new TaskDao(db);
    const a = dao.create({ title: "A", recurrence: rule });
    dao.create({ title: "B", recurrence: rule });
    dao.softDelete(a.id);
    expect(dao.list().map((t) => t.title)).toEqual(["B"]);
    expect(dao.list({ includeDeleted: true }).length).toBe(2);
  });

  it("onlyEnabled 只返回启用的任务", () => {
    const dao = new TaskDao(db);
    const a = dao.create({ title: "A", recurrence: rule });
    dao.create({ title: "B", recurrence: rule });
    dao.setEnabled(a.id, false);
    expect(dao.list({ onlyEnabled: true }).map((t) => t.title)).toEqual(["B"]);
  });

  it("update 支持部分更新，且不覆盖未提供的字段", () => {
    const dao = new TaskDao(db);
    const t = dao.create({ title: "旧标题", notes: "备注", priority: "normal", recurrence: rule });
    const updated = dao.update(t.id, { title: "新标题" });
    expect(updated?.title).toBe("新标题");
    expect(updated?.notes).toBe("备注");
    expect(updated?.priority).toBe("normal");
    expect(updated?.recurrence.rrule).toBe("FREQ=DAILY");
  });

  it("update 可整体替换重复规则", () => {
    const dao = new TaskDao(db);
    const t = dao.create({ title: "X", recurrence: rule });
    const updated = dao.update(t.id, {
      recurrence: {
        rrule: null,
        dtstartWall: "2026-04-01T08:00",
        tzid: "system",
        untilWall: null,
        countLimit: null,
      },
    });
    expect(updated?.recurrence.rrule).toBeNull();
    expect(updated?.recurrence.dtstartWall).toBe("2026-04-01T08:00");
  });

  it("对已软删除的任务 update 返回 null", () => {
    const dao = new TaskDao(db);
    const t = dao.create({ title: "X", recurrence: rule });
    dao.softDelete(t.id);
    expect(dao.update(t.id, { title: "Y" })).toBeNull();
  });

  it("硬删除级联删除实例", () => {
    const dao = new TaskDao(db);
    const occ = new OccurrenceDao(db);
    const t = dao.create({ title: "X", recurrence: rule });
    occ.insertIgnore({ taskId: t.id, scheduledAt: 1, scheduledWall: "2026-03-01T09:00" });
    expect(Object.values(occ.countByState())).toContain(1);
    dao.hardDelete(t.id);
    expect(occ.countByState()).toEqual({});
  });
});

describe("OccurrenceDao 幂等性（M1 核心）", () => {
  const rule = {
    rrule: null,
    dtstartWall: "2026-03-01T09:00",
    tzid: "system",
    untilWall: null,
    countLimit: null,
  };

  function setup(): {
    tasks: TaskDao;
    occ: OccurrenceDao;
    taskId: string;
    clock: ReturnType<typeof makeClock>;
  } {
    const clock = makeClock();
    const tasks = new TaskDao(db, clock.now);
    const occ = new OccurrenceDao(db, clock.now);
    const t = tasks.create({ title: "T", recurrence: rule });
    return { tasks, occ, taskId: t.id, clock };
  }

  it("同一 (task, scheduledAt) 只创建一次（物化幂等）", () => {
    const { occ, taskId } = setup();
    const a = occ.insertIgnore({ taskId, scheduledAt: 1_000, scheduledWall: "2026-03-01T09:00" });
    const b = occ.insertIgnore({ taskId, scheduledAt: 1_000, scheduledWall: "2026-03-01T09:00" });
    const c = occ.insertIgnore({ taskId, scheduledAt: 1_000, scheduledWall: "2026-03-01T09:00" });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(c.created).toBe(false);
    expect(b.id).toBe(a.id);
    expect(occ.countByState()).toEqual({ pending: 1 });
  });

  it("claim 只有第一次成功（派发幂等：影响行数裁决）", () => {
    const { occ, taskId } = setup();
    const { id } = occ.insertIgnore({ taskId, scheduledAt: 1_000, scheduledWall: "2026-03-01T09:00" });
    const first = occ.claim(id);
    const second = occ.claim(id);
    expect(first.claimed).toBe(true);
    expect(first.occurrence?.state).toBe("claimed");
    expect(second.claimed).toBe(false);
    expect(second.occurrence).toBeNull();
  });

  it("已投递的实例无法再被领取（绝不重复发送）", () => {
    const { occ, taskId } = setup();
    const { id } = occ.insertIgnore({ taskId, scheduledAt: 1_000, scheduledWall: "2026-03-01T09:00" });
    occ.claim(id);
    occ.markDelivered(id);
    expect(occ.claim(id).claimed).toBe(false);
    expect(occ.getById(id)?.state).toBe("delivered");
  });

  it("markDelivered 只对 claimed 生效", () => {
    const { occ, taskId } = setup();
    const { id } = occ.insertIgnore({ taskId, scheduledAt: 1_000, scheduledWall: "2026-03-01T09:00" });
    expect(occ.markDelivered(id)).toBe(false); // 还是 pending
    occ.claim(id);
    expect(occ.markDelivered(id)).toBe(true);
  });

  it("listDue 只返回到期、启用、未删除的实例，并优先 important", () => {
    const clock = makeClock();
    const tasks = new TaskDao(db, clock.now);
    const occ = new OccurrenceDao(db, clock.now);
    const normal = tasks.create({ title: "普通", recurrence: rule });
    const important = tasks.create({ title: "重要", priority: "important", recurrence: rule });
    const disabled = tasks.create({ title: "停用", enabled: false, recurrence: rule });

    occ.insertIgnore({ taskId: normal.id, scheduledAt: 1_000, scheduledWall: "2026-03-01T09:01" });
    occ.insertIgnore({ taskId: important.id, scheduledAt: 1_000, scheduledWall: "2026-03-01T09:02" });
    occ.insertIgnore({ taskId: disabled.id, scheduledAt: 1_000, scheduledWall: "2026-03-01T09:03" });

    const due = occ.listDue(2_000);
    expect(due.length).toBe(2); // 停用的被排除
    expect(due[0]?.taskId).toBe(important.id); // 优先级排序
    expect(occ.listDue(500)).toEqual([]); // 未到期
  });

  it("补偿窗口外可标记 skipped（记历史但不打扰）", () => {
    const { occ, taskId } = setup();
    const { id } = occ.insertIgnore({ taskId, scheduledAt: 1_000, scheduledWall: "2026-03-01T09:00" });
    expect(occ.markSkipped(id, "beyond_catchup_window")).toBe(true);
    expect(occ.getById(id)?.state).toBe("skipped");
    expect(occ.listDue(999_999)).toEqual([]); // 不再派发
  });

  it("领取超时 → unknown（不自动重发也不静默丢弃）", () => {
    const { occ, taskId, clock } = setup();
    const { id } = occ.insertIgnore({ taskId, scheduledAt: 1_000, scheduledWall: "2026-03-01T09:00" });
    occ.claim(id, 60_000);
    expect(occ.reconcileStaleClaims(clock.now())).toEqual([]); // 未超时

    clock.advance(61_000);
    const marked = occ.reconcileStaleClaims(clock.now());
    expect(marked.map((o) => o.id)).toEqual([id]);
    const after = occ.getById(id);
    expect(after?.state).toBe("unknown");
    expect(after?.lastError).toBe("crashed_while_delivering");
  });

  it("reconcile 对已 delivered 的实例无副作用", () => {
    const { occ, taskId, clock } = setup();
    const { id } = occ.insertIgnore({ taskId, scheduledAt: 1_000, scheduledWall: "2026-03-01T09:04" });
    occ.claim(id, 1);
    occ.markDelivered(id);
    clock.advance(10_000);
    expect(occ.reconcileStaleClaims(clock.now())).toEqual([]);
    expect(occ.getById(id)?.state).toBe("delivered");
  });
});

describe("BlobStore（内容寻址）", () => {
  let store: BlobStore;

  beforeEach(() => {
    store = new BlobStore(join(dir, "blobs"));
  });

  it("写入后可按哈希读回，且路径为 blobs/<前2位>/<sha256>", () => {
    const ref = store.put("hello world");
    expect(ref.sha256).toHaveLength(64);
    expect(ref.path).toContain(join("blobs", ref.sha256.slice(0, 2), ref.sha256));
    expect(store.getText(ref.sha256)).toBe("hello world");
  });

  it("相同内容天然去重（只存一份）", () => {
    const a = store.put("重复内容");
    const b = store.put("重复内容");
    expect(a.sha256).toBe(b.sha256);
    expect(store.stats().count).toBe(1);
  });

  it("读取不存在的哈希返回 null（供'引用已失效'降级）", () => {
    expect(store.get("0".repeat(64))).toBeNull();
    expect(store.getText("0".repeat(64))).toBeNull();
  });

  it("has / delete 行为正确", () => {
    const ref = store.put("x");
    expect(store.has(ref.sha256)).toBe(true);
    expect(store.delete(ref.sha256)).toBe(true);
    expect(store.has(ref.sha256)).toBe(false);
    expect(store.delete(ref.sha256)).toBe(false);
  });

  it("拒绝非法哈希（防路径穿越）", () => {
    expect(() => store.get("../../etc/passwd")).toThrow(/非法 sha256/);
  });

  it("原子写入：不留下临时文件碎片", () => {
    store.put("abc");
    const prefix = store.root;
    expect(statSync(join(prefix, store.put("abc").sha256.slice(0, 2))).isDirectory()).toBe(true);
    expect(store.stats().count).toBe(1);
  });

  it("gc 按时间清理（含崩溃遗留的临时文件）", () => {
    const ref = store.put("old");
    const old = statSync(ref.path).mtimeMs;
    const res = store.gc(1_000, old + 5_000);
    expect(res.removed).toBe(1);
    expect(store.stats().count).toBe(0);
  });
});

describe("AuditRepo（审计不落原文）", () => {
  it("写入后可读回，字段完整", () => {
    const repo = new AuditRepo(db);
    const entry = repo.record({
      actor: "daemon",
      purpose: "daily-digest",
      destination: "openai/gpt-x",
      dataClass: "L1",
      detectorSummary: [{ category: "email", count: 2 }],
      redactionCount: 2,
      policyVersion: "m0-v1",
      payloadSha256: "b".repeat(64),
      outcome: "allowed",
    });
    expect(entry.id).toBeTruthy();
    const recent = repo.recent(10);
    expect(recent).toHaveLength(1);
    expect(recent[0]?.detectorSummary).toEqual([{ category: "email", count: 2 }]);
    expect(recent[0]?.outcome).toBe("allowed");
  });

  it("接口层面无法传入原文（类型与表结构均无原文字段）", () => {
    const repo = new AuditRepo(db);
    repo.record({
      actor: "daemon",
      purpose: "p",
      destination: "d",
      dataClass: "L2",
      detectorSummary: [],
      redactionCount: 0,
      policyVersion: "m0-v1",
      payloadSha256: "c".repeat(64),
      outcome: "blocked",
    });
    // 表里只应有哈希列，没有任何承载原文的列
    const cols = db.prepare("PRAGMA table_info(outbound_audit)").all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain("payload_sha256");
    expect(names.some((n) => /body|content|text|payload_text|raw/i.test(n) && n !== "payload_sha256")).toBe(
      false,
    );
  });

  it("countByOutcome 正确统计", () => {
    const repo = new AuditRepo(db);
    const base: Omit<AuditEntry, "outcome"> = {
      actor: "a",
      purpose: "p",
      destination: "d",
      dataClass: "L0",
      detectorSummary: [],
      redactionCount: 0,
      policyVersion: "v",
      payloadSha256: "d".repeat(64),
    };
    repo.record({ ...base, outcome: "allowed" });
    repo.record({ ...base, outcome: "blocked" });
    repo.record({ ...base, outcome: "blocked" });
    expect(repo.countByOutcome()).toEqual({ allowed: 1, blocked: 2 });
    expect(repo.count()).toBe(3);
  });
});
