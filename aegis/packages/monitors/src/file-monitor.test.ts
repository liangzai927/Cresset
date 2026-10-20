/**
 * FileMonitor 测试：基线、稳定期、新增/修改/删除、glob/ignore。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VirtualClock } from "@aegis/clock";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileMonitor } from "./file-monitor.js";

let dir: string;
let clock: VirtualClock;
let monitor: FileMonitor;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aegis-monitor-"));
  clock = new VirtualClock();
  monitor = new FileMonitor({ id: "files.test", root: dir, stableMs: 1_000, clock });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("FileMonitor", () => {
  it("首次扫描只建基线，不把已有文件当新增", async () => {
    writeFileSync(join(dir, "existing.txt"), "old");
    const first = await monitor.scan();
    expect(first.facts).toEqual([]);
    expect(first.errors).toEqual([]);
  });

  it("emitInitial 可把现有文件作为 dry-run 事实返回", async () => {
    writeFileSync(join(dir, "existing.txt"), "old");
    const dry = new FileMonitor({
      id: "files.dry",
      root: dir,
      stableMs: 0,
      emitInitial: true,
      clock,
    });
    const result = await dry.scan();
    expect(result.facts).toHaveLength(1);
    expect(result.facts[0]?.kind).toBe("file.added");
  });

  it("新增文件经过稳定期才产生 file.added", async () => {
    await monitor.scan();
    writeFileSync(join(dir, "new.txt"), "hello");
    const early = await monitor.scan();
    expect(early.facts).toEqual([]);

    await clock.advance(1_000);
    const later = await monitor.scan();
    expect(later.facts).toHaveLength(1);
    expect(later.facts[0]?.kind).toBe("file.added");
    expect(later.facts[0]?.fields.path).toBe("new.txt");
  });

  it("内容变化经过稳定期产生 file.modified，删除立即产生 file.deleted", async () => {
    await monitor.scan();
    writeFileSync(join(dir, "a.txt"), "v1");
    await monitor.scan();
    await clock.advance(1_000);
    await monitor.scan();

    writeFileSync(join(dir, "a.txt"), "v2");
    await monitor.scan();
    await clock.advance(1_000);
    const modified = await monitor.scan();
    expect(modified.facts).toHaveLength(1);
    expect(modified.facts[0]?.kind).toBe("file.modified");

    rmSync(join(dir, "a.txt"));
    const deleted = await monitor.scan();
    expect(deleted.facts).toHaveLength(1);
    expect(deleted.facts[0]?.kind).toBe("file.deleted");
  });

  it("支持 glob 过滤与 ignore", async () => {
    const filtered = new FileMonitor({
      id: "files.filtered",
      root: dir,
      patterns: ["**/*.txt"],
      ignore: ["skip/**"],
      stableMs: 0,
      clock,
    });
    await filtered.scan();
    mkdirSync(join(dir, "keep"));
    mkdirSync(join(dir, "skip"));
    writeFileSync(join(dir, "keep", "a.txt"), "yes");
    writeFileSync(join(dir, "keep", "b.md"), "no");
    writeFileSync(join(dir, "skip", "c.txt"), "no");
    const result = await filtered.scan();
    expect(result.facts.map((f) => f.fields.path)).toEqual(["keep/a.txt"]);
  });
});
