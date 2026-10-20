/**
 * Skill 加载器测试：合法 YAML、未知字段、非法权限、文件读取。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSkillFile, parseSkill, SkillLoadError } from "./loader.js";

const SAMPLE = `name: disk-space-guard
version: 1.0.0
description: 磁盘剩余空间低于阈值时告警
author: aegis
permissions: [system.read]
cooldown: 6h
params:
  threshold_percent: 10
trigger:
  type: threshold
  monitor: system.disk
  field: free_percent
  op: "<"
  value: "{{params.threshold_percent}}"
action:
  notify:
    priority: high
    title: "磁盘空间不足"
    body: "{{monitor.mount}} 剩余 {{monitor.free_percent}}%（{{monitor.free_gb}} GB）"
`;

describe("parseSkill", () => {
  it("加载 PRD 示例并应用默认值", () => {
    const skill = parseSkill(SAMPLE);
    expect(skill.name).toBe("disk-space-guard");
    expect(skill.cooldown).toBe("6h");
    expect(skill.permissions).toEqual(["system.read"]);
  });

  it("拒绝未知字段（避免写错但静默不生效）", () => {
    expect(() => parseSkill(`${SAMPLE}\nunknown_field: true\n`)).toThrow(SkillLoadError);
  });

  it("拒绝非法权限", () => {
    expect(() => parseSkill(SAMPLE.replace("[system.read]", "[root.everything]"))).toThrow(
      /Skill 字段校验失败/,
    );
  });

  it("YAML 语法错误带明确 code", () => {
    try {
      parseSkill("name: [unclosed");
      expect.unreachable("应当抛错");
    } catch (err) {
      expect(err).toBeInstanceOf(SkillLoadError);
      expect((err as SkillLoadError).code).toBe("YAML_PARSE");
    }
  });

  it("仓库里的示例文件可加载", () => {
    const path = join(import.meta.dirname, "..", "examples", "disk-space-guard.yaml");
    const skill = loadSkillFile(path);
    expect(skill.name).toBe("disk-space-guard");
    expect(skill.trigger.type).toBe("threshold");
    expect(readFileSync(path, "utf8").length).toBeGreaterThan(0);
  });
});
