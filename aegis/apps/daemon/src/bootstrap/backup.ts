/**
 * 数据备份导出（R4）
 *
 * ## 备份什么
 *
 * - `aegis.db`：用 SQLite `VACUUM INTO` 生成的**一致性快照**（包含 WAL 中已提交的数据）
 * - `config.json` / `ui-onboarded.json`：用户配置与首次向导状态
 * - `blobs/`：数据库里引用的大对象（M3 起才可能非空）
 * - `manifest.json`：格式版本、时间、daemon 版本、每个文件的 sha256
 *
 * ## 不备份什么
 *
 * - 钥匙串里的凭据（**永远不导出**；API Key 必须存钥匙串）
 * - `handshake.json` / `channel.json` / `daemon.lock` / socket：运行期鉴权材料
 * - `logs/`、`desktop.log`：日志可能含运行细节，不属于数据
 * - `-wal` / `-shm`：快照已经包含已提交数据，单独拷贝反而容易不一致
 *
 * ## 失败语义
 *
 * 先写临时目录，校验通过后 `rename` 到目标路径；中途失败会删除临时目录，
 * 不会留下一个看起来完整、实际缺文件的备份。
 *
 * 本文件不负责上传/压缩/恢复；恢复属于 M8。
 */

import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type Clock, SystemClock } from "@aegis/clock";
import type { DataPaths } from "@aegis/product";

/** 备份格式版本；格式变化时递增，恢复端据此拒绝不认识的备份 */
export const BACKUP_FORMAT_VERSION = 1;

/** 运行期文件；明确列在 manifest 里，便于恢复时知道"这些不在备份中" */
export const BACKUP_EXCLUDES = [
  "handshake.json",
  "channel.json",
  "daemon.lock",
  "daemon.ready",
  "daemon.sock",
  "desktop.log",
  "logs/",
  "aegis.db-wal",
  "aegis.db-shm",
] as const;

/** 一个被备份的文件 */
export interface BackupFile {
  /** 相对备份根目录的路径，统一用 `/` */
  path: string;
  bytes: number;
  sha256: string;
}

/** `manifest.json` 的内容；不包含任何原文/凭据 */
export interface BackupManifest {
  formatVersion: typeof BACKUP_FORMAT_VERSION;
  /** 备份创建时刻（epoch ms） */
  createdAt: number;
  daemonVersion: string;
  sourceDataDir: string;
  files: BackupFile[];
  totalBytes: number;
  excludes: readonly string[];
}

/** `createBackup` 的输入 */
export interface CreateBackupOptions {
  paths: DataPaths;
  /** 输出目录；必须不存在（避免覆盖已有备份） */
  outDir: string;
  /** 时间来源；manifest 的 createdAt 必须可测试 */
  clock?: Clock;
  /** daemon 版本；不传时由调用方负责（本模块不依赖 daemon 启动代码） */
  daemonVersion: string;
}

/** 备份失败（目标已存在、源库缺失、完整性校验失败等） */
export class BackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackupError";
  }
}

/**
 * 创建一个备份目录。
 *
 * @throws {@link BackupError} 源数据库不存在、目标已存在、快照失败或完整性校验失败
 */
export function createBackup(opts: CreateBackupOptions): BackupManifest {
  const outDir = resolve(opts.outDir);
  if (existsSync(outDir)) {
    throw new BackupError(`备份目标已存在，拒绝覆盖：${outDir}`);
  }
  if (!existsSync(opts.paths.dbFile)) {
    throw new BackupError(`数据库不存在：${opts.paths.dbFile}（daemon 可能从未启动过）`);
  }
  if (!lstatSync(opts.paths.dbFile).isFile()) {
    throw new BackupError(`数据库路径不是普通文件，拒绝备份：${opts.paths.dbFile}`);
  }

  const clock = opts.clock ?? new SystemClock();
  const parent = dirname(outDir);
  mkdirSync(parent, { recursive: true });
  const stage = mkdtempSync(join(parent, `.${basename(outDir)}.tmp-`));

  try {
    const dbTarget = join(stage, "aegis.db");
    snapshotDatabase(opts.paths.dbFile, dbTarget);
    chmodSync(dbTarget, 0o600);
    verifyDatabase(dbTarget);

    copyIfExists(opts.paths.configFile, join(stage, "config.json"));
    copyIfExists(join(opts.paths.dataDir, "ui-onboarded.json"), join(stage, "ui-onboarded.json"));

    if (existsSync(opts.paths.blobsDir)) {
      const blobsTarget = join(stage, "blobs");
      // dereference:false —— 符号链接原样复制，随后 listFiles 会拒绝它
      cpSync(opts.paths.blobsDir, blobsTarget, { recursive: true, dereference: false });
      hardenTree(blobsTarget);
    }

    const files = listFiles(stage).map((file) => {
      const absolute = join(stage, file);
      return {
        path: file,
        bytes: statSync(absolute).size,
        sha256: sha256File(absolute),
      };
    });

    const manifest: BackupManifest = {
      formatVersion: BACKUP_FORMAT_VERSION,
      createdAt: clock.wall(),
      daemonVersion: opts.daemonVersion,
      sourceDataDir: opts.paths.dataDir,
      files,
      totalBytes: files.reduce((sum, f) => sum + f.bytes, 0),
      excludes: BACKUP_EXCLUDES,
    };
    const manifestPath = join(stage, "manifest.json");
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    chmodSync(manifestPath, 0o600);
    chmodSync(stage, 0o700);

    renameSync(stage, outDir);
    return manifest;
  } catch (err) {
    // 清理半成品；这里吞掉清理异常是安全的：原始错误更重要
    try {
      rmSync(stage, { recursive: true, force: true });
    } catch {
      /* 清理失败不掩盖原始错误 */
    }
    if (err instanceof BackupError) throw err;
    throw new BackupError(`备份失败：${err instanceof Error ? err.message : String(err)}`);
  }
}

/** SQLite 一致性快照；VACUUM INTO 会把 WAL 中已提交的数据一起写进去 */
function snapshotDatabase(source: string, target: string): void {
  const db = new DatabaseSync(source);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    // VACUUM INTO 的路径是 SQL 字面量；单引号转义，避免路径中的 ' 破坏语句
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  } catch (err) {
    throw new BackupError(`数据库快照失败：${err instanceof Error ? err.message : String(err)}`);
  } finally {
    db.close();
  }
}

/** 对快照做一次 integrity_check；损坏的备份比没有备份更危险 */
function verifyDatabase(file: string): void {
  const db = new DatabaseSync(file);
  try {
    const rows = db.prepare("PRAGMA integrity_check").all();
    const first: unknown = rows[0];
    const ok =
      typeof first === "object" &&
      first !== null &&
      (first as Record<string, unknown>).integrity_check === "ok";
    if (!ok) throw new BackupError("数据库快照 integrity_check 未通过");
  } finally {
    db.close();
  }
}

/** 拷贝可选文件并收紧权限；不存在时静默跳过（配置/向导标记本来就可能没有） */
function copyIfExists(source: string, target: string): void {
  if (!existsSync(source)) return;
  if (!lstatSync(source).isFile()) {
    throw new BackupError(`备份只接受普通文件：${source}`);
  }
  copyFileSync(source, target);
  chmodSync(target, 0o600);
}

/** 递归收紧目录权限：备份含个人数据，不能让同机其他用户读 */
function hardenTree(dir: string): void {
  chmodSync(dir, 0o700);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) hardenTree(path);
    else if (entry.isFile()) chmodSync(path, 0o600);
  }
}

/** 列出备份目录中的文件（相对路径，统一 `/`），按路径排序 */
function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.isFile()) {
        out.push(relative(root, path).split(sep).join("/"));
      } else if (entry.isSymbolicLink()) {
        // 备份里出现符号链接会让恢复端读到备份目录之外的内容；直接拒绝
        throw new BackupError(`备份不支持符号链接：${path}`);
      }
    }
  };
  walk(root);
  return out.sort();
}

/** 计算文件 sha256；M1 的数据库很小，直接读入内存足够 */
function sha256File(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}
