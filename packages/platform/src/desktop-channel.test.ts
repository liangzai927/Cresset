/**
 * 桌面通道发现逻辑测试
 *
 * 这些断言保护的是**安全边界**，不是普通功能：
 *   - endpoint 必须是回环地址（否则 channel.json 被篡改就会把通知内容发到外部）
 *   - token 必须匹配才能投递
 *   - 陈旧的 channel.json（进程已死）必须被清理，否则每次投递都白试一遍
 *
 * 之所以单独测这一层：`DesktopChannelSender` 的 send() 走网络，
 * 而发现逻辑是纯文件 + 进程探测，可以在没有 Electron 的情况下精确验证。
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverDesktopChannel } from "./desktop-channel.js";

let dir: string;
let channelPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aegis-chan-"));
  channelPath = join(dir, "channel.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 写一个 channel.json */
function writeChannel(content: unknown): void {
  writeFileSync(channelPath, JSON.stringify(content), "utf8");
}

describe("discoverDesktopChannel", () => {
  it("文件不存在时报告不可用（而不是抛错）", () => {
    const r = discoverDesktopChannel(channelPath);
    expect(r.available).toBe(false);
    if (!r.available) expect(r.reason).toContain("不存在");
  });

  it("合法文件（进程存活）时返回可用", () => {
    // 用当前进程的 pid 保证"存活"
    writeChannel({ endpoint: "http://127.0.0.1:12345", token: "abc", pid: process.pid, startedAt: 1 });
    const r = discoverDesktopChannel(channelPath);
    expect(r.available).toBe(true);
    if (r.available) expect(r.channel.endpoint).toBe("http://127.0.0.1:12345");
  });

  it("内容不是合法 JSON 时报告不可用", () => {
    writeFileSync(channelPath, "{ 半截", "utf8");
    const r = discoverDesktopChannel(channelPath);
    expect(r.available).toBe(false);
    if (!r.available) expect(r.reason).toContain("JSON");
  });

  it("缺少必需字段时报告不可用", () => {
    writeChannel({ endpoint: "http://127.0.0.1:1" }); // 缺 token 与 pid
    const r = discoverDesktopChannel(channelPath);
    expect(r.available).toBe(false);
    if (!r.available) expect(r.reason).toContain("必需字段");
  });

  describe("★ 安全：只接受回环地址", () => {
    const badEndpoints = [
      "http://evil.example.com:1234",
      "http://192.168.1.10:1234",
      "http://0.0.0.0:1234",
      "https://127.0.0.1:1234", // 协议不对
      "http://localhost:1234", // 不是字面量 127.0.0.1（避免 DNS 解析不确定性）
      "http://127.0.0.1", // 缺端口
    ];

    for (const endpoint of badEndpoints) {
      it(`拒绝 ${endpoint}`, () => {
        writeChannel({ endpoint, token: "t", pid: process.pid, startedAt: 1 });
        const r = discoverDesktopChannel(channelPath);
        expect(r.available).toBe(false);
        if (!r.available) expect(r.reason).toContain("不是本机地址");
      });
    }
  });

  it("★ 进程已退出时报告不可用，并清理陈旧文件", () => {
    // pid 取一个几乎不可能存在的值（> 系统 pid 上限）
    writeChannel({ endpoint: "http://127.0.0.1:12345", token: "t", pid: 999_999_999, startedAt: 1 });
    const r = discoverDesktopChannel(channelPath);
    expect(r.available).toBe(false);
    if (!r.available) expect(r.reason).toContain("已退出");

    // 陈旧文件应被删除（否则每次投递都要白试一次）
    const second = discoverDesktopChannel(channelPath);
    expect(second.available).toBe(false);
    if (!second.available) expect(second.reason).toContain("不存在");
  });

  it("可关闭陈旧文件清理（便于诊断时保留现场）", () => {
    writeChannel({ endpoint: "http://127.0.0.1:12345", token: "t", pid: 999_999_999, startedAt: 1 });
    const r = discoverDesktopChannel(channelPath, { removeStale: false });
    expect(r.available).toBe(false);
    // 文件仍存在（未被删除）
    expect(discoverDesktopChannel(channelPath).available).toBe(false);
  });
});
