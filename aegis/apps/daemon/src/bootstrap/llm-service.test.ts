/**
 * LlmService 测试：钥匙串状态、公开探针外发、审计落库。
 *
 * 使用假 SecretStore + 本机 HTTP server，不访问外网、不碰真实钥匙串。
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VirtualClock } from "@aegis/clock";
import type { SecretAvailability, SecretStore } from "@aegis/secrets";
import { AuditRepo, migrate, openDb } from "@aegis/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LlmService } from "./llm-service.js";

/** 内存 SecretStore，避免测试触碰系统钥匙串 */
class MemorySecrets implements SecretStore {
  readonly map = new Map<string, string>();
  async set(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }
  async get(key: string): Promise<string | null> {
    return this.map.get(key) ?? null;
  }
  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }
  async list(): Promise<string[]> {
    return [...this.map.keys()];
  }
  async available(): Promise<SecretAvailability> {
    return { ok: true, detail: "memory", backend: "memory" };
  }
}

let dir: string;
let db: ReturnType<typeof openDb>;
let server: Server;
let baseUrl: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "aegis-llm-"));
  db = openDb({ file: join(dir, "test.db") });
  migrate(db);
  server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "OK" } }], model: "test-model" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({
      version: 1,
      llm: { enabled: true, baseUrl, model: "test-model", timeoutMs: 5_000, maxOutboundClass: "L1" },
    }),
  );
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("LlmService", () => {
  it("测试外发经网关执行，并在 outbound_audit 留下 allowed 记录", async () => {
    const secrets = new MemorySecrets();
    const service = new LlmService({
      configFile: join(dir, "config.json"),
      db,
      clock: new VirtualClock(1_000),
      secrets,
    });
    expect((await service.get()).hasApiKey).toBe(false);

    await service.setApiKey("sk-test");
    expect((await service.get()).hasApiKey).toBe(true);

    const result = await service.test();
    expect(result).toMatchObject({ ok: true, text: "OK" });

    const audits = new AuditRepo(db).recent(10);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ purpose: "llm-test", outcome: "allowed", dataClass: "L0" });
    expect(JSON.stringify(audits)).not.toContain("sk-test");
    expect(await service.audit(10)).toHaveLength(1);
  });

  it("达到每日调用上限后不再调用 Provider", async () => {
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({
        version: 1,
        llm: {
          enabled: true,
          baseUrl,
          model: "test-model",
          timeoutMs: 5_000,
          maxOutboundClass: "L1",
          dailyCallLimit: 1,
        },
      }),
    );
    const service = new LlmService({
      configFile: join(dir, "config.json"),
      db,
      clock: new VirtualClock(1_000),
      secrets: new MemorySecrets(),
    });
    await service.setApiKey("sk-test");

    expect(await service.test()).toMatchObject({ ok: true });
    expect(await service.test()).toMatchObject({ ok: false, errorKind: "rate_limit" });
    const view = await service.get();
    expect(view.callsToday).toBe(1);
    expect(view.remainingCalls).toBe(0);
    expect(new AuditRepo(db).recent(10)).toHaveLength(1);
  });

  it("未配置 Key 时测试失败，但不调用 Provider", async () => {
    const service = new LlmService({
      configFile: join(dir, "config.json"),
      db,
      clock: new VirtualClock(1_000),
      secrets: new MemorySecrets(),
    });
    const result = await service.test();
    expect(result).toMatchObject({ ok: false, blocked: false, errorKind: "configuration" });
    expect(new AuditRepo(db).count()).toBe(0);
  });

  it("钥匙串读取失败会显示在视图里，而不是假装无 Key", async () => {
    const broken: SecretStore = {
      async set() {},
      async get() {
        throw new Error("keychain denied");
      },
      async delete() {},
      async list() {
        return [];
      },
      async available() {
        return { ok: false, detail: "denied", backend: "test" };
      },
    };
    const service = new LlmService({
      configFile: join(dir, "config.json"),
      db,
      clock: new VirtualClock(1_000),
      secrets: broken,
    });
    const view = await service.get();
    expect(view.hasApiKey).toBe(false);
    expect(view.keychainError).toContain("keychain denied");
  });
});
