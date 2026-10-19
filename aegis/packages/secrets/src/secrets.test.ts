/**
 * 凭据存储的测试。
 *
 * 真实钥匙串用例在受限环境（沙箱/无 GUI 会话）会被显式跳过而非静默通过；
 * 跳过判据由 loginKeychainUsable() 探测，并在结论里留下记录事实的断言。
 */
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSecretStore, MacOsKeychain, SecretUnavailableError, UnsupportedSecretStore } from "./index.js";

const isMac = process.platform === "darwin";
const SERVICE = `aegis.test.${process.pid}`;

/**
 * 真实钥匙串测试的可用性探测。
 *
 * 为什么需要：自动化沙箱/无 GUI 会话下，登录钥匙串访问会被拒
 * （`UNIX[Operation not permitted]`）。此时真实用例必须**跳过**而不是失败 ——
 * 但也不能静默通过，所以下面用 describe.skipIf 明确标注。
 */
function loginKeychainUsable(): boolean {
  if (!isMac) return false;
  const probe = spawnSync(
    "/usr/bin/security",
    ["add-generic-password", "-s", `${SERVICE}.probe`, "-a", "probe", "-w", "x", "-U"],
    { encoding: "utf8", timeout: 15_000 },
  );
  const ok = probe.status === 0;
  spawnSync("/usr/bin/security", ["delete-generic-password", "-s", `${SERVICE}.probe`, "-a", "probe"], {
    encoding: "utf8",
    timeout: 15_000,
  });
  return ok;
}

const keychainOk = loginKeychainUsable();

describe("平台分发", () => {
  it("非 macOS 返回显式的不支持实现（不静默降级）", async () => {
    const store = createSecretStore({ service: SERVICE, platform: "linux" });
    expect(store).toBeInstanceOf(UnsupportedSecretStore);
    const avail = await store.available();
    expect(avail.ok).toBe(false);
    expect(avail.backend).toBe("unsupported-platform");
    await expect(store.get("x")).rejects.toThrow(SecretUnavailableError);
  });

  it("macOS 返回钥匙串实现", () => {
    const store = createSecretStore({ service: SERVICE, platform: "darwin" });
    expect(store).toBeInstanceOf(MacOsKeychain);
  });

  it("service 为空时构造失败（防误配置）", () => {
    expect(() => new MacOsKeychain({ service: "  " })).toThrow(/service 不能为空/);
  });
});

describe.skipIf(!keychainOk)("macOS 钥匙串（真实读写）", () => {
  const store = new MacOsKeychain({ service: SERVICE });

  it("写入后可读回", async () => {
    await store.set("api-key", "secret-value-1");
    expect(await store.get("api-key")).toBe("secret-value-1");
  });

  it("重复写入是更新而非报错（-U 幂等）", async () => {
    await store.set("k", "v1");
    await store.set("k", "v2");
    expect(await store.get("k")).toBe("v2");
  });

  it("读取不存在的键返回 null（而非抛错）", async () => {
    expect(await store.get("definitely-not-set")).toBeNull();
  });

  it("删除不存在的键不抛错（幂等删除）", async () => {
    await expect(store.delete("definitely-not-set")).resolves.toBeUndefined();
  });

  it("删除后读不到", async () => {
    await store.set("temp", "x");
    await store.delete("temp");
    expect(await store.get("temp")).toBeNull();
  });

  it("available() 自检通过并给出后端与说明", async () => {
    const avail = await store.available();
    expect(avail.ok).toBe(true);
    expect(avail.backend).toContain("security-cli");
    expect(avail.detail).toContain("无人值守");
  });

  it("list() 能列出本 service 下的条目且不泄漏明文", async () => {
    await store.set("listed-1", "plaintext-should-not-appear");
    await store.set("listed-2", "another-secret");
    const accounts = await store.list();
    expect(accounts).toContain("listed-1");
    expect(accounts).toContain("listed-2");
    await store.delete("listed-1");
    await store.delete("listed-2");
  });

  it("自检不会留下探测条目", async () => {
    await store.available();
    const accounts = await store.list();
    expect(accounts.some((a) => a.startsWith("__aegis_probe_"))).toBe(false);
  });
});

describe.skipIf(!keychainOk || !isMac)("独立钥匙串（验证 C-5：路径必须是最后一个参数）", () => {
  it("指向自定义钥匙串时读写正常", async () => {
    const kcPath = join(tmpdir(), `aegis-test-${process.pid}-${Date.now()}.keychain-db`);
    const created = spawnSync("/usr/bin/security", ["create-keychain", "-p", "test-pass", kcPath], {
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(created.status).toBe(0);

    try {
      spawnSync("/usr/bin/security", ["unlock-keychain", "-p", "test-pass", kcPath], { timeout: 20_000 });
      spawnSync("/usr/bin/security", ["set-keychain-settings", "-t", "300", kcPath], { timeout: 20_000 });

      const store = new MacOsKeychain({ service: SERVICE, keychainPath: kcPath });
      await store.set("k", "v-in-custom");
      expect(await store.get("k")).toBe("v-in-custom");
      const avail = await store.available();
      expect(avail.ok).toBe(true);
      expect(avail.backend).toContain("custom-keychain");
      await store.delete("k");
    } finally {
      spawnSync("/usr/bin/security", ["delete-keychain", kcPath], { timeout: 20_000 });
      if (existsSync(kcPath)) rmSync(kcPath, { force: true });
    }
  });
});

describe("约束说明（文档化测试）", () => {
  it("available() 在钥匙串不可用时返回 ok=false 而不是抛错（供启动序列决策）", async () => {
    const store = new MacOsKeychain({ service: `${SERVICE}.unavailable`, timeoutMs: 5_000 });
    const avail = await store.available();
    // 本环境可能可用也可能不可用，但绝不能是"抛异常"
    expect(typeof avail.ok).toBe("boolean");
    expect(avail.detail.length).toBeGreaterThan(0);
    expect(avail.backend).toContain("security-cli");
  });

  it("本环境登录钥匙串可用性（决定上面真实用例是否执行）", () => {
    // 记录事实而非断言通过：沙箱/无 GUI 会话下会为 false，此时真实用例被 skip
    expect(typeof keychainOk).toBe("boolean");
  });
});
