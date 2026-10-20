/**
 * Skill 文件存储（M2 / FR-C2）
 *
 * 数据目录下的 `skills/` 是用户 Skill 的唯一落点；本模块只做：
 *   - 安全文件名校验；
 *   - YAML 解析/契约校验（复用 @aegis/skills）；
 *   - 原子写入与删除；
 *   - 列表（坏文件也要返回，让 UI 能看到错误，而不是消失）。
 *
 * 本文件不负责：监测器绑定（属 monitor-bindings）、执行/调度（属 monitor-runtime）。
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseSkill, type Skill, SkillLoadError } from "@aegis/skills";

/** 数据目录下存放 Skill 的子目录 */
export const SKILLS_DIR = "skills";

/** 列表项；坏文件也用 valid=false + error 返回 */
export interface SkillListEntry {
  file: string;
  valid: boolean;
  name: string | null;
  version: string | null;
  description: string | null;
  permissions: string[];
  triggerMonitor: string | null;
  error: string | null;
}

/** 存储层错误；与 YAML 契约错误分开，方便 IPC 映射 */
export class SkillStoreError extends Error {
  constructor(
    readonly code: "INVALID_FILENAME" | "TOO_LARGE" | "NOT_FOUND" | "WRITE_FAILED" | "LIST_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "SkillStoreError";
  }
}

/** Skill 文件大小上限：256KB，防止误导入巨型文件 */
const MAX_SKILL_BYTES = 256 * 1024;

/** 只允许单层、YAML 后缀、安全字符；拒绝 `../`、绝对路径与隐藏文件 */
function assertFilename(filename: string): void {
  if (
    filename.length === 0 ||
    filename.length > 128 ||
    basename(filename) !== filename ||
    filename.startsWith(".") ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.ya?ml$/i.test(filename)
  ) {
    throw new SkillStoreError("INVALID_FILENAME", `非法 Skill 文件名：${filename}`);
  }
}

/** 由 Skill 定义生成列表项 */
function toEntry(file: string, skill: Skill): SkillListEntry {
  return {
    file,
    valid: true,
    name: skill.name,
    version: skill.version,
    description: skill.description,
    permissions: [...skill.permissions],
    triggerMonitor: skill.trigger.monitor,
    error: null,
  };
}

/** 解析失败时生成可展示的坏项 */
function toInvalidEntry(file: string, err: unknown): SkillListEntry {
  const message =
    err instanceof SkillLoadError
      ? `${err.message}${err.issues.length > 0 ? `：${err.issues.join("；")}` : ""}`
      : (err as Error).message;
  return {
    file,
    valid: false,
    name: null,
    version: null,
    description: null,
    permissions: [],
    triggerMonitor: null,
    error: message,
  };
}

/** 列出所有 Skill；目录不存在时返回空而不是报错 */
export function listSkills(dataDir: string): SkillListEntry[] {
  const dir = join(dataDir, SKILLS_DIR);
  if (!existsSync(dir)) return [];

  let files: string[];
  try {
    files = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && /\.ya?ml$/i.test(e.name))
      .map((e) => e.name)
      .sort();
  } catch (err) {
    throw new SkillStoreError("LIST_FAILED", `读取 skills 目录失败：${(err as Error).message}`);
  }

  return files.map((file) => {
    try {
      const skill = parseSkill(readFileSync(join(dir, file), "utf8"));
      return toEntry(file, skill);
    } catch (err) {
      return toInvalidEntry(file, err);
    }
  });
}

/**
 * 导入/更新一个 Skill。
 *
 * @throws SkillLoadError YAML/契约不合法
 * @throws SkillStoreError 文件名非法、内容过大、写入失败
 */
export function importSkill(dataDir: string, filename: string, content: string): SkillListEntry {
  assertFilename(filename);
  if (Buffer.byteLength(content, "utf8") > MAX_SKILL_BYTES) {
    throw new SkillStoreError("TOO_LARGE", `Skill 文件超过 ${MAX_SKILL_BYTES} 字节`);
  }

  // 先校验再落盘：坏 YAML 永远不进入 skills/
  const skill = parseSkill(content);
  const dir = join(dataDir, SKILLS_DIR);
  const target = join(dir, filename);
  const temp = join(dir, `.${filename}.${randomUUID()}.tmp`);

  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(temp, content, { encoding: "utf8", mode: 0o600 });
    renameSync(temp, target);
  } catch (err) {
    try {
      rmSync(temp, { force: true });
    } catch {
      /* 清理失败不应覆盖原始错误 */
    }
    throw new SkillStoreError("WRITE_FAILED", `写入 Skill 失败：${(err as Error).message}`);
  }

  return toEntry(filename, skill);
}

/** 删除一个 Skill；不存在时抛 NOT_FOUND，避免 UI 假装成功 */
export function deleteSkill(dataDir: string, filename: string): void {
  assertFilename(filename);
  const target = join(dataDir, SKILLS_DIR, filename);
  if (!existsSync(target)) throw new SkillStoreError("NOT_FOUND", `Skill 不存在：${filename}`);
  try {
    rmSync(target);
  } catch (err) {
    throw new SkillStoreError("WRITE_FAILED", `删除 Skill 失败：${(err as Error).message}`);
  }
}

/** 供测试/诊断：Skill 目录的绝对路径 */
export function skillsDir(dataDir: string): string {
  return join(dataDir, SKILLS_DIR);
}
