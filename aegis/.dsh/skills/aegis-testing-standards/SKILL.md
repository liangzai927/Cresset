---
name: aegis-testing-standards
description: Aegis 的测试规范。**写测试、修 bug、实现任何有时序/并发/重试/幂等语义的逻辑时加载**。它规定必测清单（幂等/边界/失败路径/时间相关）、虚拟时钟的强制用法、临时目录与资源清理约定、测试命名与结构、以及"如何为崩溃恢复与 30 天长跑写测试"。当你不知道某个功能该怎么测、或要修一个不易复现的缺陷时，加载本技能。
---

# Aegis 测试规范

## 1. 本项目的测试哲学

> **这个项目的核心承诺是"无人看管下连续数月可靠"。**
> 因此测试的重点**不是覆盖率**，而是**把不可复现的场景变成可复现的**。

四个必须能被测试证明的命题：

| 命题 | 对应需求 | 测试手段 |
| --- | --- | --- |
| 绝不重复发送 | FR-A4 | 唯一索引 + 影响行数；重复调用断言只产生一条 |
| 休眠/关机后能补偿 | FR-A3 | **虚拟时钟**推进，而非真实等待 |
| 崩溃后能恢复且不丢活 | NFR-R2/W1 | 手工制造 `claimed` 超时 / 陈旧锁 / 中断态 |
| 30 天 0 漏报 0 重报 | NFR-R1 | 虚拟时钟秒级跑完 30 天（TC-M1-20） |

## 2. 铁律：时间必须走 `Clock`

**禁止**在业务代码与测试里直接使用 `Date.now()` / `new Date()` / `setTimeout`。

```ts
// ✅ 生产代码：从外部注入
export class TaskDao {
  constructor(db: Db, private readonly now: () => number = Date.now) {}
}

// ✅ 测试：用可推进的虚拟时钟
const clock = new VirtualClock();
const dao = new TaskDao(db, () => clock.wall());
await clock.advance(60_000);
```

### 2.1 ⚠️ 传递类方法时必须 bind（真实踩过的坑）

`Clock` 的 `wall`/`monotonic` 是类方法，**直接作为回调传递会丢失 `this`**：

```ts
// ❌ 运行时报 "Cannot read properties of undefined (reading '#wall')"
lock.acquire(note, clock.wall);

// ✅ 用箭头函数包装（本项目统一写法）
const now = (): number => clock.wall();
lock.acquire(note, now);
```

这类错误**只在传参时出现**，如果测试都用内联箭头函数就发现不了 —— 所以测试要覆盖"注入外部 clock"的路径。

### 2.2 VirtualClock 的三个能力

| 方法 | 用途 |
| --- | --- |
| `advance(ms)` | 推进时间并按到期顺序触发定时器 |
| `suspend(wallMs)` | **只改墙钟不改单调钟** → 模拟系统休眠（补偿逻辑的触发条件） |
| `jumpWall(delta)` | 只改墙钟 → 模拟 NTP 校正 / 用户改时间 |

配合 `detectSkew()` 断言"判定为 suspended 还是 wall_jumped"。

### 2.3 ⚠️ 断言"两端 undefined"会假通过

```ts
// ❌ 如果映射/透传坏了，两边都是 undefined，这条断言仍然通过
expect(native.sent[0]?.occurrenceId).toBe(delivered?.occurrenceId);
```

跨进程/跨层字段（`occurrenceId`、token、路径）必须至少有一端断言类型或非空：

```ts
expect(delivered?.occurrenceId).toEqual(expect.any(String));
expect(native.sent[0]?.occurrenceId).toBe(delivered?.occurrenceId);
```

同理，链路测试不能只测"两端函数各自正常"：用真实 `/notify` 请求或 daemon RPC
把 `daemon → channel → renderer` 串起来跑一次。

## 3. 每个改动必测的四类用例

| # | 类型 | 判据 | 例子 |
| --- | --- | --- | --- |
| 1 | **正常路径** | 功能可用 | 创建任务后能读回，且布尔字段是 boolean 而非 0/1 |
| 2 | **幂等/重复调用** | 第二次调用不产生副作用 | 同一 `(taskId, scheduledAt)` 调 3 次 `insertIgnore`，只有 1 条实例 |
| 3 | **边界与失败路径** | 非法输入被拒绝且**不落库** | 空标题在 INSERT 前被 Zod 拦下，`count()` 仍为 0 |
| 4 | **恢复路径** | 中断后能收敛 | claim 后不投递 → 推进超时 → 断言进入 `unknown` 而非被重发 |

**修复缺陷时必须补第 5 类**：一个**能复现该缺陷**的测试。没有它，这个 bug 会回来。

## 4. 测试结构约定

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let dir: string;          // 每个用例独立的临时目录
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aegis-<area>-"));
  db = openDb({ file: join(dir, "test.db") });
  migrate(db);
});

afterEach(() => {
  try { db.close(); } catch { /* 已关闭 */ }
  rmSync(dir, { recursive: true, force: true });   // ★ 必须清理，不留 /tmp 垃圾
});
```

- **测试描述用中文**：`it("同一 (task, scheduledAt) 只创建一次（物化幂等）")`
- **测试文件与被测文件同级**：`src/task-dao.ts` → `src/task-dao.test.ts`（或聚合成 `<area>.test.ts`）
- **`describe` 按行为分组**，不按函数分组
- **断言要表明意图**：`expect(t.enabled).toBe(true)   // SQLite 存 1，读回必须是 boolean`

## 5. 资源清理与环境约束

| 资源 | 约定 |
| --- | --- |
| 临时目录 | `mkdtempSync(join(tmpdir(), "aegis-<area>-"))`，`afterEach` 删除 |
| 数据库 | 用临时目录下的文件（不要 `:memory:`，因为要验证 WAL 行为） |
| 网络/端口 | 用 UDS + 临时目录；**不要用固定端口**（并发测试会撞） |
| 钥匙串 | 用 `describe.skipIf(!keychainUsable())` 明确标注，**不要静默跳过** |
| 系统级操作 | 写 plist / launchd 等需真实会话的用例，必须在沙箱外运行 |

### 5.1 ⚠️ 安装类操作必须在 pnpm 工作区之外

R0 踩过的坑：在仓库内目录执行 `pnpm add` 会向上继承仓库的 `lockfile`/`node_modules`，
导致间歇性失败与"单独跑通过、整套跑失败"的不可信结论。

```ts
// ✅ 正确：安装目录放系统临时目录
const STAGE = join(tmpdir(), `aegis-spike-${process.pid}`);
```

### 5.2 沙箱内会被跳过的用例要显式标注

```ts
const keychainOk = loginKeychainUsable();          // 先探测
describe.skipIf(!keychainOk)("macOS 钥匙串（真实读写）", () => { ... });
```

并在 `it` 里留一条**记录事实**的断言，让"为什么跳过"在报告里可见。

## 6. 长跑与稳定性测试

- **不要真等**：用 `VirtualClock` 把 30 天压成秒级。
- **内存/句柄泄漏**：长跑用例中每 N 步采样 `process.memoryUsage().rss`，断言无持续增长。
- **定时器泄漏**：`VirtualClock.pendingTimers()` 断言期望值与实际一致。
- **并发**：同一操作并发调用（`Promise.all`）后断言副作用只有一次。

## 7. 命名与断言风格

```ts
// ✅ 断言消息要能自解释失败原因
expect(run.startup.appliedMigrations).toEqual([1, 2]);   // 迁移未应用时，失败信息直接指出
expect(hs.token.length).toBeGreaterThan(20);             // token 太短说明生成逻辑有问题

// ❌ 笼统断言：失败时不知道为什么
expect(result).toBeTruthy();
expect(arr.length).toBeGreaterThan(0);
```

优先断言**具体值与结构**，而不是 `toBeTruthy()`。失败信息是给未来的自己看的。

## 8. 门禁与命令

```bash
pnpm test                      # 全部测试
pnpm test -- packages/storage  # 只跑某个包
pnpm verify                    # 提交前必跑（含测试）
```

**测试不通过 = 未完成。** 不允许 `it.skip` 掩盖失败；确需跳过必须在提交 body 里说明原因与补齐计划。
