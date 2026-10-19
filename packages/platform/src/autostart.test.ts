/**
 * 开机自启（LaunchAgent）测试
 *
 * 重点验证 plist 内容正确性 —— 写错 plist 的后果是"开机后静默不启动"，
 * 而用户不会收到任何错误提示。因此这里逐字段断言。
 *
 * 真实 launchctl 的 install/uninstall 不在单测里跑（会改系统状态），
 * 由 tools/verify-desktop.mjs 之外的独立手工验证覆盖。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AutostartOptions, buildLaunchAgentPlist, isAutostartEnabled, plistPath } from "./autostart.js";

let dir: string;
let opts: AutostartOptions;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aegis-auto-"));
  opts = {
    label: "com.aegis.daemon",
    execPath: "/usr/local/bin/node",
    args: ["/path/to/daemon/main.js", "--data-dir", "/Users/x/Library/Application Support/Aegis"],
    launchAgentsDir: dir,
  };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("buildLaunchAgentPlist", () => {
  it("包含必需的三个键：Label / ProgramArguments / RunAtLoad", () => {
    const xml = buildLaunchAgentPlist(opts);
    expect(xml).toContain("<key>Label</key>");
    expect(xml).toContain("<string>com.aegis.daemon</string>");
    expect(xml).toContain("<key>ProgramArguments</key>");
    expect(xml).toContain("<key>RunAtLoad</key>");
    expect(xml).toContain("<true/>");
  });

  it("★ KeepAlive 必须为 true（崩溃自恢复的保障）", () => {
    const xml = buildLaunchAgentPlist(opts);
    expect(xml).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
  });

  it("可执行文件与每个参数各占一个 <string>", () => {
    const xml = buildLaunchAgentPlist(opts);
    expect(xml).toContain("<string>/usr/local/bin/node</string>");
    expect(xml).toContain("<string>/path/to/daemon/main.js</string>");
    expect(xml).toContain("<string>--data-dir</string>");
    // 数据目录含空格，必须完整出现在一个 string 里（不是被拆开）
    expect(xml).toContain("<string>/Users/x/Library/Application Support/Aegis</string>");
  });

  it("★ XML 特殊字符被转义（否则 plist 解析失败 → 静默不自启）", () => {
    const xml = buildLaunchAgentPlist({
      ...opts,
      args: ["/tmp/a&b/main.js", "--data-dir", "/tmp/<x>"],
    });
    expect(xml).toContain("/tmp/a&amp;b/main.js");
    expect(xml).toContain("/tmp/&lt;x&gt;");
    // 不能出现未转义的裸字符
    expect(xml).not.toContain("/tmp/a&b/main.js");
  });

  it("ProcessType 为 Background（不抢占前台资源）", () => {
    expect(buildLaunchAgentPlist(opts)).toMatch(/<key>ProcessType<\/key>\s*<string>Background<\/string>/);
  });

  it("是合法的 XML 声明结构", () => {
    const xml = buildLaunchAgentPlist(opts);
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('<plist version="1.0">');
    expect(xml.trim().endsWith("</plist>")).toBe(true);
    // 标签成对（粗糙但有效的平衡检查）
    const opens = (xml.match(/<dict>/g) ?? []).length;
    const closes = (xml.match(/<\/dict>/g) ?? []).length;
    expect(opens).toBe(closes);
  });
});

describe("plistPath / isAutostartEnabled", () => {
  it("路径为 <dir>/<label>.plist", () => {
    expect(plistPath(opts)).toBe(join(dir, "com.aegis.daemon.plist"));
  });

  it("未安装时为 false", () => {
    expect(isAutostartEnabled(opts)).toBe(false);
  });
});
