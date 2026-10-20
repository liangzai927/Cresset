/**
 * SkillStore 测试：导入校验、坏文件可见、路径穿越拒绝、删除。
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillLoadError } from "@aegis/skills";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deleteSkill, importSkill, listSkills, SkillStoreError, skillsDir } from "./skill-store.js";

const VALID = `name: downloads-change
version: 1.0.0
description: 下载目录变化
permissions: [files.read]
cooldown: 5m
params: {}
trigger:
  type: change
  monitor: files.downloads
action:
  notify:
    priority: normal
    title: 有新文件
    body: "{{monitor.path}}"
`;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aegis-skill-store-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("skill-store", () => {
  it("导入后可在列表中看到完整摘要", () => {
    expect(listSkills(dir)).toEqual([]);
    const entry = importSkill(dir, "downloads.yaml", VALID);
    expect(entry).toMatchObject({
      file: "downloads.yaml",
      valid: true,
      name: "downloads-change",
      permissions: ["files.read"],
      triggerMonitor: "files.downloads",
    });
    expect(readFileSync(join(skillsDir(dir), "downloads.yaml"), "utf8")).toContain("downloads-change");
    expect(listSkills(dir)).toEqual([entry]);
  });

  it("坏 YAML 不落盘，且错误带问题列表", () => {
    expect(() => importSkill(dir, "bad.yaml", "name: [")).toThrow(SkillLoadError);
    expect(listSkills(dir)).toEqual([]);
  });

  it("拒绝路径穿越与绝对路径", () => {
    expect(() => importSkill(dir, "../evil.yaml", VALID)).toThrow(SkillStoreError);
    expect(() => importSkill(dir, "/tmp/evil.yaml", VALID)).toThrow(SkillStoreError);
  });

  it("坏文件仍在列表中，并带可见错误", () => {
    mkdirSync(join(dir, "skills"), { recursive: true });
    writeFileSync(join(dir, "skills", "broken.yaml"), "name: [", { flag: "w" });
    const entries = listSkills(dir);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.valid).toBe(false);
    expect(entries[0]?.error).toBeTruthy();
  });

  it("删除不存在的 Skill 返回 NOT_FOUND", () => {
    expect(() => deleteSkill(dir, "missing.yaml")).toThrow(SkillStoreError);
    importSkill(dir, "ok.yaml", VALID);
    deleteSkill(dir, "ok.yaml");
    expect(listSkills(dir)).toEqual([]);
  });
});
