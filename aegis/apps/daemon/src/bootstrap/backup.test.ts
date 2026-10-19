/**
 * 数据备份导出测试（R4）
 *
 * 验证的是"备份能不能真的恢复出数据"，而不只是"目录被创建了"：
 *   - SQLite 快照在源库仍打开（WAL）时也包含已提交数据；
 *   - manifest 的 sha256 与文件一致；
 *   - 运行期鉴权/日志文件没有被带进备份；
 *   - 目录 0700、文件 0600（备份含个人数据）。
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { VirtualClock } from "@aegis/clock";
import { type DataPaths, resolveDataPaths } from "@aegis/product";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BACKUP_FORMAT_VERSION, BackupError, createBackup } from "./backup.js";

let dataDir: string;
let outParent: string;
let paths: DataPaths;
let sourceDb: DatabaseSync | null;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "aegis-backup-"));
  outParent = mkdtempSync(join(tmpdir(), "aegis-backup-out-"));
  paths = resolveDataPaths({ dataDir });

  mkdirSync(paths.blobsDir, { recursive: true });
  mkdirSync(paths.logsDir, { recursive: true });

  sourceDb = new DatabaseSync(paths.dbFile);
  sourceDb.exec("PRAGMA journal_mode = WAL");
  sourceDb.exec("CREATE TABLE sample (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
  sourceDb.exec("INSERT INTO sample (id, name) VALUES (1, 'kept')");

  writeFileSync(paths.configFile, JSON.stringify({ version: 1, tickMs: 1_500 }));
  writeFileSync(join(dataDir, "ui-onboarded.json"), JSON.stringify({ completedAt: 1, autostart: true }));
  writeFileSync(join(paths.blobsDir, "note.txt"), "blob-content");

  // 运行期材料：不应出现在备份中
  writeFileSync(paths.handshakeFile, "{}");
  writeFileSync(paths.channelFile, "{}");
  writeFileSync(paths.lockFile, "{}");
  writeFileSync(join(dataDir, "daemon.ready"), "{}");
  writeFileSync(join(dataDir, "desktop.log"), "log");
  writeFileSync(join(paths.logsDir, "desktop.log"), "log");
});

afterEach(() => {
  try {
    sourceDb?.close();
  } catch {
    /* 已关闭 */
  }
  sourceDb = null;
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(outParent, { recursive: true, force: true });
});

describe("createBackup", () => {
  it("生成一致性快照、配置与 blobs，并写出可校验的 manifest", () => {
    const clock = new VirtualClock();
    const outDir = join(outParent, "backup-1");
    const manifest = createBackup({ paths, outDir, clock, daemonVersion: "test-daemon" });

    expect(existsSync(outDir)).toBe(true);
    expect(manifest.formatVersion).toBe(BACKUP_FORMAT_VERSION);
    expect(manifest.createdAt).toBe(clock.wall());
    expect(manifest.daemonVersion).toBe("test-daemon");
    expect(manifest.totalBytes).toBe(manifest.files.reduce((sum, f) => sum + f.bytes, 0));

    const names = manifest.files.map((f) => f.path);
    expect(names).toEqual(
      expect.arrayContaining(["aegis.db", "config.json", "ui-onboarded.json", "blobs/note.txt"]),
    );
    expect(names.some((n) => n.includes("handshake"))).toBe(false);
    expect(names.some((n) => n.includes("channel"))).toBe(false);
    expect(names.some((n) => n.includes("daemon.lock"))).toBe(false);
    expect(names.some((n) => n.startsWith("logs/"))).toBe(false);
    expect(manifest.excludes.length).toBeGreaterThan(0);

    // 快照里能真的读出源库中已提交的数据（源库仍以 WAL 打开）
    const copy = new DatabaseSync(join(outDir, "aegis.db"));
    try {
      const row = copy.prepare("SELECT name FROM sample WHERE id = 1").get();
      expect(JSON.stringify(row)).toContain("kept");
    } finally {
      copy.close();
    }

    const configEntry = manifest.files.find((f) => f.path === "config.json");
    expect(configEntry).toBeDefined();
    const configBytes = readFileSync(join(outDir, "config.json"));
    expect(configEntry?.sha256).toBe(createHash("sha256").update(configBytes).digest("hex"));
  });

  it("备份目录与文件权限被收紧（0700 / 0600）", () => {
    const outDir = join(outParent, "backup-perm");
    createBackup({ paths, outDir, clock: new VirtualClock(), daemonVersion: "test" });

    expect(statSync(outDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(outDir, "aegis.db")).mode & 0o777).toBe(0o600);
    expect(statSync(join(outDir, "manifest.json")).mode & 0o777).toBe(0o600);
    expect(statSync(join(outDir, "blobs", "note.txt")).mode & 0o777).toBe(0o600);
  });

  it("目标已存在时拒绝覆盖", () => {
    const outDir = join(outParent, "backup-existing");
    mkdirSync(outDir);
    expect(() => createBackup({ paths, outDir, clock: new VirtualClock(), daemonVersion: "test" })).toThrow(
      BackupError,
    );
  });

  it("blobs 中出现符号链接时拒绝备份并清理半成品", () => {
    const outDir = join(outParent, "backup-symlink");
    symlinkSync("/etc/hosts", join(paths.blobsDir, "link"));

    expect(() => createBackup({ paths, outDir, clock: new VirtualClock(), daemonVersion: "test" })).toThrow(
      /符号链接/,
    );
    expect(existsSync(outDir)).toBe(false);
  });

  it("源数据库不存在时给出明确错误", () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "aegis-backup-empty-"));
    try {
      const emptyPaths = resolveDataPaths({ dataDir: emptyDir });
      expect(() =>
        createBackup({
          paths: emptyPaths,
          outDir: join(outParent, "backup-missing-db"),
          clock: new VirtualClock(),
          daemonVersion: "test",
        }),
      ).toThrow(/数据库不存在/);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});
