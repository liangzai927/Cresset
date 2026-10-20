/**
 * 规则引擎测试：阈值/字符串/变化触发、模板渲染与失败可见。
 */

import { describe, expect, it } from "vitest";
import { evaluateSkill, SkillEvaluationError } from "./engine.js";
import { parseSkill } from "./loader.js";
import { renderTemplate, TemplateError } from "./template.js";

const SAMPLE = `name: disk-space-guard
version: 1.0.0
description: 磁盘剩余空间低于阈值时告警
permissions: [system.read]
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

describe("evaluateSkill", () => {
  it("低于阈值时渲染通知正文", () => {
    const skill = parseSkill(SAMPLE);
    const decision = evaluateSkill(skill, {
      mount: "/",
      free_percent: 8,
      free_gb: 12.4,
    });
    expect(decision).toEqual({
      skill: "disk-space-guard",
      priority: "high",
      title: "磁盘空间不足",
      body: "/ 剩余 8%（12.4 GB）",
      cooldown: "24h",
    });
  });

  it("高于阈值时返回 null", () => {
    const skill = parseSkill(SAMPLE);
    expect(evaluateSkill(skill, { mount: "/", free_percent: 20, free_gb: 80 })).toBeNull();
  });

  it("缺少字段时抛错，而不是静默不命中", () => {
    const skill = parseSkill(SAMPLE);
    expect(() => evaluateSkill(skill, { mount: "/" })).toThrow(SkillEvaluationError);
  });

  it("change 触发直接产出决策", () => {
    const skill = parseSkill(
      SAMPLE.replace("type: threshold", "type: change").replace(
        / {2}field:.*\n {2}op:.*\n {2}value:.*\n/,
        "",
      ),
    );
    const decision = evaluateSkill(skill, { mount: "/", free_percent: 8, free_gb: 12.4 });
    expect(decision?.skill).toBe("disk-space-guard");
  });
});

describe("renderTemplate", () => {
  it("只允许 params/monitor 变量", () => {
    expect(renderTemplate("{{params.x}}", { params: { x: 3 }, monitor: {} })).toBe("3");
    expect(() => renderTemplate("{{process.env.HOME}}", { params: {}, monitor: {} })).toThrow(TemplateError);
    expect(() => renderTemplate("{{params.missing}}", { params: {}, monitor: {} })).toThrow(/参数不存在/);
  });
});
