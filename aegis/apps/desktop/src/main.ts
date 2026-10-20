/**
 * Electron 主进程 —— 应用外壳与能力中枢
 *
 * ## 这一层做什么
 *
 * ```
 * ┌──────────────────────────────────────────────┐
 * │ Electron 主进程（本文件）                      │
 * │  ① 创建窗口 / 托盘                             │
 * │  ② 启动 desktop 通道服务（接收 daemon 的投递） │
 * │  ③ 监督 daemon（拉起、健康检查、重启）         │
 * │  ④ 持有 IPC 客户端（唯一能连 daemon 的地方）   │
 * │  ⑤ 处理 renderer 的 RPC 请求（经 preload 白名单）│
 * └──────────────────────────────────────────────┘
 * ```
 *
 * ## 为什么 IPC 客户端在主进程而不是 renderer
 *
 * daemon 的 UDS 上的 token 只存在 `handshake.json`。若 renderer 能直接拿到 token，
 * 一旦页面被 XSS 影响，攻击者就能绕过所有界面约束直接操作 daemon。
 * 因此 token 只留在主进程，renderer 只能调用语义化的方法。
 *
 * ## 窗口关闭 ≠ 应用退出
 *
 * 本产品是 24 小时陪伴型工具：关闭窗口后应留在托盘继续工作。
 * 只有显式"退出"才真正结束应用（但**仍然不杀 daemon**，见 supervisor.ts）。
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { IpcClient } from "@aegis/daemon/ipc-client";
import {
  type AutostartOptions,
  createDesktopChannelSender,
  type DesktopChannelSender,
  desktopChannelProbe,
  installAutostart,
  isAutostartEnabled,
  type Notifier,
  uninstallAutostart,
} from "@aegis/platform";
import { type DataPaths, resolveDataPaths } from "@aegis/product";
import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, nativeImage, shell, Tray } from "electron";
import type {
  BackupExportResult,
  BriefingSettings,
  CalendarSettings,
  ChannelStatus,
  CreateTaskPayload,
  DiagnosticInfo,
  DndSettingsView,
  KnowledgeAnswerResult,
  KnowledgeDocument,
  KnowledgeHit,
  LlmAuditEntry,
  LlmSettingsView,
  LlmTestResult,
  LlmView,
  MonitorConfigView,
  MonitorStatusItem,
  NotificationItem,
  NotifySettings,
  SkillExportResult,
  SkillListEntry,
  SystemHealthView,
  TaskEditItem,
  TaskItem,
  UpdateInfo,
  UpdateTaskPayload,
} from "./api-types.js";
import { deliverWithAttention, probeSystemNotification } from "./attention.js";
import { type ChannelHostHandle, createElectronPresenter, startChannelHost } from "./channel-host.js";
import { DaemonSupervisor, resolveDaemonEntry, resolveNodeExecPath } from "./supervisor.js";

/** 应用版本（与 package.json 同步） */
const APP_VERSION = "0.3.0-r3";

/** daemon RPC 结果的结构（只声明用到的字段，保持与 ipc-contract 对齐） */
interface TaskView {
  id: string;
  title: string;
  notes: string | null;
  priority: "normal" | "important";
  enabled: boolean;
  repeatLabel: string;
  nextFireWall: string | null;
  firedCount: number;
  lastFiredAt: number | null;
}

interface NotificationView {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  scheduledFor: number;
  state: string;
  attempts: Array<{ channel: string; outcome: string; error: string | null }>;
  isCatchup: boolean;
}

/** 运行时单例（避免模块级可变状态散落） */
interface AppContext {
  window: BrowserWindow | null;
  tray: Tray | null;
  channelHost: ChannelHostHandle | null;
  supervisor: DaemonSupervisor | null;
  client: IpcClient | null;
  paths: DataPaths;
  /** 桌面通道 sender（用于探测渠道状态） */
  desktopSender: DesktopChannelSender | null;
  /** 渠道列表（探测用；顺序即降级链） */
  notifierProbes: Notifier[];
  /** 是否正在退出（避免 close 事件反复触发） */
  quitting: boolean;
  /**
   * 系统通知是否真的可用（启动时探测得出）。
   *
   * 未签名的开发版应用在 macOS 上拿不到通知权限，此时只能用前台强提醒兜底。
   */
  systemNotificationOk: boolean;
  /** 系统通知不可用的具体原因（来自启动探测） */
  systemNotificationDetail: string | null;
}

const ctx: AppContext = {
  window: null,
  tray: null,
  channelHost: null,
  supervisor: null,
  client: null,
  paths: resolveDataPaths({ dataDir: defaultDataDir() }),
  desktopSender: null,
  notifierProbes: [],
  quitting: false,
  systemNotificationOk: false,
  systemNotificationDetail: null,
};

/**
 * ⌘Q 的两段式退出状态。
 *
 * 第一次只把 `quitArmedUntil` 设到 3 秒后并提示；第二次在窗口内才真正退出。
 * 这样手滑按到 ⌘Q 不会把 24/7 的后台服务一起关掉。
 */
let quitArmedUntil = 0;
let quitArmTimer: NodeJS.Timeout | null = null;

/** 隐藏窗口（Cmd+W / 菜单"关闭窗口"）；不退出应用，托盘仍在 */
function hideWindow(): void {
  if (ctx.window && !ctx.window.isDestroyed()) ctx.window.hide();
}

/** 真正退出：先请求 daemon 优雅停止，再退出 Electron */
async function fullQuit(): Promise<void> {
  ctx.quitting = true;
  try {
    if (ctx.client) {
      await ctx.client.call("sys.shutdown", {});
    } else {
      // 连接已断时仍要尽力停掉 daemon；用握手里的 endpoint/token 新建一次连接，
      // 不走 ensureClient（那会在 daemon 没跑时反而把它拉起来）。
      const hs = ctx.supervisor?.readHandshake();
      if (hs) {
        const client = new IpcClient({ endpoint: hs.endpoint, token: hs.token });
        try {
          await client.connect();
          await client.call("sys.shutdown", {});
        } finally {
          client.close();
        }
      }
    }
  } catch {
    /* daemon 可能已不在；退出流程不因它失败而卡住 */
  }
  app.quit();
}

/**
 * 两段式完全退出。
 *
 * 第二次必须在第一次的 3 秒内；超时后重新计数，避免"很久以前按过一次"
 * 导致下一次 ⌘Q 直接退出。
 */
function requestFullQuit(): void {
  const now = Date.now();
  if (now <= quitArmedUntil) {
    quitArmedUntil = 0;
    if (quitArmTimer) {
      clearTimeout(quitArmTimer);
      quitArmTimer = null;
    }
    void fullQuit();
    return;
  }

  quitArmedUntil = now + 3_000;
  if (quitArmTimer) clearTimeout(quitArmTimer);
  quitArmTimer = setTimeout(() => {
    quitArmedUntil = 0;
    quitArmTimer = null;
  }, 3_000);

  const win = ctx.window;
  if (win && !win.isDestroyed()) {
    if (!win.isVisible()) win.show();
    win.focus();
    if (!win.webContents.isDestroyed()) {
      win.webContents.send("aegis:quit-armed", { seconds: 3 });
    }
  }
  log("info", "main.quit_armed", { windowMs: 3_000 });
}

/**
 * 解析数据目录。
 *
 * 与 daemon 用同一套规则：环境变量优先，其次 macOS 标准位置。
 * 刻意不引入 Electron 的 `app.getPath("userData")` —— 那会让路径随
 * Electron 版本/打包方式变化，而 daemon（独立进程）无法跟随。
 */
function defaultDataDir(): string {
  if (process.env.AEGIS_DATA_DIR) return process.env.AEGIS_DATA_DIR;
  return join(app.getPath("home"), "Library", "Application Support", "Aegis");
}

function log(level: "debug" | "info" | "warn" | "error", event: string, detail?: unknown): void {
  // 主进程日志走 stdout；打包后由系统日志收集
  const line = JSON.stringify({ at: Date.now(), level, event, ...(detail !== undefined ? { detail } : {}) });
  if (level === "error") process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

// ── 窗口 ────────────────────────────────────────────────────────────────

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 920,
    height: 680,
    minWidth: 720,
    minHeight: 520,
    show: false,
    title: "Aegis",
    // 隐藏标题栏但保留交通灯：更接近原生工具的外观
    titleBarStyle: "hiddenInset",
    backgroundColor: "#f5f5f7",
    webPreferences: {
      preload: join(import.meta.dirname, "preload.cjs"),
      // ★ 三条安全开关，缺一不可
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  win.once("ready-to-show", () => win.show());

  // ── 截图模式（自动化验证用）
  //
  // 设置 AEGIS_CAPTURE=<png路径> 后，窗口加载完成即截图并退出。
  // 这是"界面到底渲染成什么样"的可验证手段：CI/无头环境里系统截屏不可用
  // （实测 `screencapture` 报 "could not create image from display"），
  // 而 Electron 自己的 capturePage() 不依赖屏幕录制权限。
  const capturePath = process.env.AEGIS_CAPTURE;
  if (capturePath) {
    // 抽成具名函数并把 capturePath 作为参数传入，
    // 避免在闭包里依赖类型收窄（曾经因为窄化丢失导致 TS 报"可能为 undefined"）。
    const captureNow = (to: string, w: BrowserWindow): void => {
      void w.webContents
        .capturePage()
        .then((image) => {
          writeFileSync(to, image.toPNG());
          log("info", "main.capture_saved", { path: to, bytes: image.toPNG().length });
        })
        .catch((err: unknown) => log("error", "main.capture_failed", { error: String(err) }))
        .finally(() => {
          ctx.quitting = true;
          app.quit();
        });
    };

    win.webContents.once("did-finish-load", () => {
      // 等首屏数据（status/tasks）渲染完成再截
      setTimeout(
        () => {
          // AEGIS_CAPTURE_ACTION=dialog：先打开"新建提醒"对话框，覆盖核心交互路径
          // AEGIS_CAPTURE_ACTION=wizard：打开首次启动向导（截图模式默认跳过它）
          if (process.env.AEGIS_CAPTURE_ACTION === "wizard") {
            // AEGIS_CAPTURE_WIZARD_STEP=N：打开向导后前进到第 N 步再截图
            const step = Number(process.env.AEGIS_CAPTURE_WIZARD_STEP ?? "1");
            void win.webContents.executeJavaScript(
              `(async () => {
               await openWizard?.();
               for (let i = 1; i < ${step}; i++) {
                 document.getElementById("wizard-next")?.click();
                 await new Promise((r) => setTimeout(r, 260));
               }
             })()`,
            );
            setTimeout(() => captureNow(capturePath, win), 1_400);
            return;
          }

          if (process.env.AEGIS_CAPTURE_ACTION === "dialog") {
            void win.webContents.executeJavaScript('document.getElementById("btn-new")?.click()');
            setTimeout(() => captureNow(capturePath, win), 900);
            return;
          }
          captureNow(capturePath, win);
          // AEGIS_CAPTURE_DELAY 可延后截图，用于验证"提醒触发后"的界面
        },
        Number(process.env.AEGIS_CAPTURE_DELAY ?? "3000"),
      );
    });
  }

  // ── 端到端冒烟：模拟用户点"测试通知"
  //
  // 存在的理由：曾出现过"界面已显示、但 daemon 还在启动时点测试通知直接报错"
  // 的问题。单元测试覆盖不到这条链路（它跨 renderer → preload → 主进程 → daemon），
  // 因此这里提供一个可自动化的动作，结果写进日志供 tools/verify-desktop.mjs 断言。
  if (process.env.AEGIS_E2E_SMOKE === "1") {
    win.webContents.once("did-finish-load", () => {
      // 立刻点（不等就绪）——这正是当初出错的条件
      setTimeout(() => {
        void win.webContents
          .executeJavaScript(
            `window.aegis.testNotify().then(() => "SMOKE_NOTIFY_OK").catch((e) => "SMOKE_NOTIFY_FAIL:" + e.message)`,
          )
          .then((result: string) => {
            log("info", "main.e2e_smoke_result", { result });
          })
          .catch((err: unknown) => log("error", "main.e2e_smoke_error", { error: String(err) }))
          .finally(() => {
            // 留一点时间让日志刷出去
            setTimeout(() => {
              ctx.quitting = true;
              app.quit();
            }, 500);
          });
      }, 150);
    });
  }

  // 关闭窗口 → 隐藏到托盘（不退出，服务继续跑）
  // 窗口真正被销毁（应用退出、或用户强制关闭）时清空引用，
  // 避免后续回调拿到一个已销毁的对象
  win.on("closed", () => {
    if (ctx.window === win) ctx.window = null;
  });

  win.on("close", (event) => {
    if (ctx.quitting) return;
    event.preventDefault();
    win.hide();
    // 首次隐藏时提示用户"我还在后台工作"，避免以为应用被关了
    if (!ctx.tray) {
      createTray();
    }
  });

  // 截图/深链接：可用 query 指定初始页签（`?tab=history`）。
  // 用 query 而不是"加载后点一下"是因为点击依赖渲染时序，实测不可靠；
  // 页面初始化时直接决定页签则没有竞态。将来做深链接也复用这条通道。
  const initialTab = process.env.AEGIS_CAPTURE_TAB;
  const query: Record<string, string> = {};
  if (initialTab) query.tab = initialTab;
  // 截图模式下告诉页面"别弹首次向导"，否则每张截图都会被向导挡住
  if (process.env.AEGIS_CAPTURE) query.capture = "1";
  log("debug", "main.load_renderer", { query });
  void win.loadFile(
    join(import.meta.dirname, "renderer", "index.html"),
    Object.keys(query).length > 0 ? { query } : undefined,
  );
  return win;
}

/** 托盘图标：用内联的 16x16 PNG，避免打包时漏资源 */
function createTray(): void {
  // 通知铃铛（16x16，模板图会随系统明暗自动反色）
  const pngBase64 =
    "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAANUlEQVR42mNgoCH4j4Yp0kySIf8JYNoa8J9ITBsD/pOIqWvAfzIxRZrJSmD0S8oMdHUqRQAAoztrlZCd0ecAAAAASUVORK5CYII=";
  const icon = nativeImage.createFromBuffer(Buffer.from(pngBase64, "base64"));
  icon.setTemplateImage(true);
  if (icon.isEmpty()) {
    // 图标解码失败时托盘会显示为空白 —— 这条日志是排查"菜单栏没有图标"的入口
    log("warn", "main.tray_icon_empty", {});
  }

  const tray = new Tray(icon);
  tray.setToolTip("Aegis —— 提醒服务运行中");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "打开主窗口",
        click: () => {
          if (ctx.window) {
            ctx.window.show();
            ctx.window.focus();
          }
        },
      },
      { type: "separator" },
      { label: "关闭窗口", click: hideWindow },
      {
        label: "发送测试通知",
        click: () => {
          void ipcTestNotify();
        },
      },
      { type: "separator" },
      {
        label: "退出界面（提醒继续运行）",
        click: () => {
          ctx.quitting = true;
          app.quit();
        },
      },
      { label: "完全退出（含后台服务）", click: requestFullQuit },
    ]),
  );
  tray.on("click", () => {
    if (ctx.window) {
      if (ctx.window.isVisible()) ctx.window.hide();
      else {
        ctx.window.show();
        ctx.window.focus();
      }
    }
  });
  ctx.tray = tray;
}

// ── 首次启动向导与开机自启 ──────────────────────────────────────────────

/**
 * 首次配置完成标记文件。
 *
 * 放在数据目录而不是 Electron 的 userData：daemon 与 UI 共用同一个数据目录，
 * 这样"重装界面"或"用 CLI 起过服务"都不会让向导反复弹。
 */
function onboardingMarkerPath(): string {
  return join(ctx.paths.dataDir, "ui-onboarded.json");
}

/** 自启配置。执行的是 **daemon**（不是界面）—— 见 packages/platform/src/autostart.ts 的说明 */
function autostartOptions(): AutostartOptions | null {
  const nodeExec = resolveNodeExecPath(undefined, process.resourcesPath);
  if (!nodeExec) return null;
  const repoRoot = join(import.meta.dirname, "..", "..", "..");
  const entry = resolveDaemonEntry({ repoRoot, resourcesPath: process.resourcesPath });
  if (!entry) return null;
  return {
    label: "com.aegis.daemon",
    execPath: nodeExec,
    args: [entry, "--data-dir", ctx.paths.dataDir],
  };
}

function isOnboardingNeeded(): boolean {
  return !existsSync(onboardingMarkerPath());
}

async function ipcGetOnboarding(): Promise<{
  needed: boolean;
  autostartEnabled: boolean;
  notificationsSupported: boolean;
  systemNotificationOk: boolean;
  timeZone: string;
}> {
  const opts = autostartOptions();
  return {
    needed: isOnboardingNeeded(),
    autostartEnabled: opts ? isAutostartEnabled(opts) : false,
    notificationsSupported: Notification.isSupported(),
    systemNotificationOk: ctx.systemNotificationOk,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

async function ipcSetAutostart(enabled: boolean): Promise<{ ok: boolean; detail: string }> {
  const opts = autostartOptions();
  if (!opts) {
    return { ok: false, detail: "找不到 Node 运行时或 daemon 入口，无法设置开机自启" };
  }
  const r = enabled ? installAutostart(opts) : uninstallAutostart(opts);
  log(r.ok ? "info" : "warn", "main.autostart_set", { enabled, ok: r.ok, detail: r.detail });
  return r;
}

async function ipcCompleteOnboarding(choices: { autostart: boolean }): Promise<{
  ok: boolean;
  detail: string;
}> {
  // 自启失败不应阻止向导完成 —— 用户仍然可以用这个应用，
  // 只是需要手动启动。把失败原因如实返回让界面展示。
  const auto = await ipcSetAutostart(choices.autostart === true);

  try {
    writeFileSync(
      onboardingMarkerPath(),
      JSON.stringify({ completedAt: Date.now(), autostart: choices.autostart === true }),
      "utf8",
    );
  } catch (err) {
    return { ok: false, detail: `无法写入配置标记：${(err as Error).message}` };
  }

  return auto.ok
    ? { ok: true, detail: "配置完成" }
    : { ok: true, detail: `配置已保存，但开机自启未生效：${auto.detail}` };
}

// ── daemon 连接 ─────────────────────────────────────────────────────────

/**
 * 确保有一个已连接的 IPC 客户端。
 *
 * 重连策略：每次调用都检查 `client` 是否可用；不可用则按当前握手文件重建。
 * 这样 daemon 重启后（换了 token）无需重启 UI。
 */
/**
 * 等待 daemon 就绪的默认上限（毫秒）。
 *
 * 为什么要等而不是立刻报错：daemon 是独立进程，冷启动需要拉起 Node、
 * 跑迁移、建 socket，实测约 0.5–2 秒。用户看到界面后立刻点"测试通知"时，
 * 后端很可能还没起来 —— 直接抛错只会让人以为坏了（实测踩到）。
 */
const CLIENT_WAIT_MS = 10_000;

/**
 * 确保拿到一个已连接的 IPC 客户端。
 *
 * 三种情况：
 *   1. 已有连接 → 直接返回
 *   2. 没有连接但能等到 daemon 就绪 → 连上返回
 *   3. 等超时 → 抛出**带原因**的错误（而不是笼统的"尚未就绪"）
 */
async function ensureClient(waitMs = CLIENT_WAIT_MS): Promise<IpcClient> {
  if (ctx.client) return ctx.client;

  // 让监督者再尝试一次（它是幂等的：已有进程就直接复用，否则拉起）。
  // 这同时修掉了"首次启动失败后永不重试"的问题。
  const deadline = Date.now() + waitMs;
  let lastReason = "daemon 未启动";

  while (Date.now() < deadline) {
    if (!ctx.supervisor) {
      lastReason = "监督者未初始化（可能找不到系统 Node 或 daemon 入口）";
      break;
    }

    let hs = ctx.supervisor.readHandshake();
    if (!hs) {
      // 还没握手：催一次启动，然后小睡
      const state = await ctx.supervisor.ensureRunning(Math.min(2_000, deadline - Date.now()));
      if (state.kind === "unavailable" || state.kind === "crashed") {
        lastReason =
          state.kind === "crashed" ? `daemon 崩溃：${state.reason}` : `daemon 不可用：${state.reason}`;
        // 崩溃/不可用不必死等到超时，直接让用户看到原因
        break;
      }
      hs = ctx.supervisor.readHandshake();
      if (!hs) {
        await new Promise((r) => setTimeout(r, 200));
        continue;
      }
    }

    try {
      const client = new IpcClient({
        endpoint: hs.endpoint,
        token: hs.token,
        // daemon 断开时自动清空，下次调用会重连。
        // 注意：onStateChange 必须在构造时传入（IpcClient 不在事后暴露注册方法）。
        onStateChange: (state) => {
          if (state === "disconnected") {
            ctx.client = null;
            notifyRefresh();
          }
        },
      });
      await client.connect();
      ctx.client = client;
      return client;
    } catch (err) {
      // 握手文件可能已被 daemon 重启替换（换 token）→ 清空后重试
      lastReason = `连接 daemon 失败：${(err as Error).message}`;
      ctx.client = null;
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  throw new Error(
    `${lastReason}。可执行 \`pnpm daemon\` 手动启动后台服务查看具体报错；` + `数据目录：${ctx.paths.dataDir}`,
  );
}

/** 通知 renderer 刷新（daemon 状态变化、需要重新拉数据时） */
/**
 * 向渲染进程发消息（带完整的销毁检查）。
 *
 * ⚠️ 这个助手存在的理由是一次真实崩溃：
 * 应用退出时 IPC 连接断开 → `onStateChange("disconnected")` → 调 notifyRefresh()
 * → 此时窗口已销毁，`webContents.send()` 抛 "Object has been destroyed"，
 * Electron 直接弹"主进程发生 JavaScript 错误"的对话框吓用户。
 *
 * `ctx.window` 非空不代表 `webContents` 还活着，两者都要查。
 */
function sendToRenderer(channel: string, ...args: unknown[]): boolean {
  const win = ctx.window;
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return false;
  try {
    win.webContents.send(channel, ...args);
    return true;
  } catch {
    // 发送失败不致命：界面收不到刷新通知而已，下次轮询会补上
    return false;
  }
}

function notifyRefresh(): void {
  sendToRenderer("aegis:refresh");
}

function pushDaemonState(state: string): void {
  sendToRenderer("aegis:daemon-state", state);
}

// ── 各 RPC 处理器 ───────────────────────────────────────────────────────

async function ipcGetStatus(): Promise<DiagnosticInfo> {
  const state = ctx.supervisor?.state ?? { kind: "stopped" as const };

  let health: DiagnosticInfo["health"] = null;
  let taskChannels: ChannelStatus[] = [];

  // 渠道探测：桌面通道 + CLI 兜底。失败不抛错 —— 状态页要能显示"为什么走兜底"
  for (const n of ctx.notifierProbes) {
    try {
      const r = await n.probe();
      taskChannels.push({ channel: n.channel, ok: r.ok, detail: r.detail });
    } catch (err) {
      taskChannels.push({ channel: n.channel, ok: false, detail: (err as Error).message });
    }
  }

  if (state.kind === "running") {
    try {
      const client = await ensureClient();
      const h = await client.health();
      health = {
        ok: h.ok,
        uptimeS: h.uptimeS,
        tickCount: h.tickCount,
        nextDueAt: h.nextDueAt,
        rssBytes: h.rssBytes ?? 0,
        degradedReasons: h.degradedReasons,
      };
      // 原生与兜底的相对顺序用于界面提示"当前实际走哪条链"
      // 桌面通道优先展示（它就是降级链的第一环）
      taskChannels = taskChannels.sort((a, b) =>
        a.channel === b.channel ? 0 : a.channel === "os_notification" ? -1 : 1,
      );
    } catch (err) {
      log("warn", "main.status_health_failed", { error: (err as Error).message });
    }
  }

  return {
    daemonState: state.kind,
    daemonReason: state.kind === "crashed" || state.kind === "unavailable" ? state.reason : null,
    // 只有真正拿到握手且进程存活才算就绪
    daemonReady: state.kind === "running",
    spawnedByUs: state.kind === "running" ? state.spawnedByUs : false,
    health,
    channels: taskChannels,
    dataDir: ctx.paths.dataDir,
    dbFile: ctx.paths.dbFile,
    appVersion: APP_VERSION,
    daemonVersion: state.kind === "running" ? (state.handshake.daemonVersion ?? null) : null,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    // 注意：这两个是**不同**的事。
    // notificationsSupported 只表示 API 存在；systemNotificationOk 才是"真的能弹出来"。
    notificationsSupported: Notification.isSupported(),
    systemNotificationOk: ctx.systemNotificationOk,
    systemNotificationDetail: ctx.systemNotificationOk ? null : ctx.systemNotificationDetail,
  };
}

async function ipcGetTask(id: string): Promise<TaskEditItem> {
  const client = await ensureClient();
  return (await client.call("task.get", { id })) as TaskEditItem;
}

async function ipcUpdateTask(payload: UpdateTaskPayload): Promise<{ id: string }> {
  const client = await ensureClient();
  const r = (await client.call("task.update", payload)) as { id: string };
  notifyRefresh();
  return r;
}

async function ipcListTasks(): Promise<{ items: TaskItem[] }> {
  const client = await ensureClient();
  const r = (await client.call("task.list", { limit: 500 })) as { items: TaskView[] };
  return {
    items: r.items.map((t) => ({
      id: t.id,
      title: t.title,
      notes: t.notes,
      priority: t.priority,
      enabled: t.enabled,
      repeatLabel: t.repeatLabel,
      nextFireWall: t.nextFireWall,
      firedCount: t.firedCount,
      lastDeliveredAt: t.lastFiredAt,
    })),
  };
}

async function ipcCreateTask(payload: CreateTaskPayload): Promise<{ id: string }> {
  const client = await ensureClient();

  // ── 主进程侧再校验一次：不信任 renderer 传来的任何东西
  // （preload 白名单只能限制"调哪个方法"，不能限制参数内容）
  if (typeof payload?.title !== "string" || payload.title.trim() === "") {
    throw new Error("标题不能为空");
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(payload.firstFireAtWall ?? "")) {
    throw new Error("触发时间格式非法");
  }

  const repeat: Record<string, unknown> = { mode: payload.repeat.mode };
  if (payload.repeat.byWeekday) repeat.byWeekday = payload.repeat.byWeekday;
  if (payload.repeat.byMonthDay) repeat.byMonthDay = payload.repeat.byMonthDay;
  if (payload.repeat.intervalMinutes) repeat.intervalMinutes = payload.repeat.intervalMinutes;

  const r = (await client.call("task.create", {
    title: payload.title.trim(),
    ...(payload.notes ? { notes: payload.notes } : {}),
    priority: payload.priority,
    firstFireAtWall: payload.firstFireAtWall,
    repeat,
  })) as { id: string };

  notifyRefresh();
  return { id: r.id };
}

async function ipcTaskToggle(id: string, enable: boolean): Promise<{ ok: boolean }> {
  const client = await ensureClient();
  const r = (await client.call(enable ? "task.resume" : "task.pause", { id })) as { ok: boolean };
  notifyRefresh();
  return r;
}

async function ipcDeleteTask(id: string): Promise<{ ok: boolean }> {
  const client = await ensureClient();
  const r = (await client.call("task.delete", { id })) as { ok: boolean };
  notifyRefresh();
  return r;
}

/**
 * 用户点"完成"：把该 occurrence 标记为已完成。
 *
 * 对一次性提醒就是"这条结束"；对重复提醒只结束当前这一条，后续实例照常。
 */
async function ipcCompleteOccurrence(occurrenceId: string): Promise<{ ok: boolean }> {
  const client = await ensureClient();
  const r = (await client.call("task.complete", { occurrenceId })) as { ok: boolean };
  notifyRefresh();
  return r;
}

/** 用户点"稍后提醒"：从现在起 minutes 分钟后创建一条新通知 */
async function ipcSnoozeOccurrence(occurrenceId: string, minutes: number): Promise<{ id: string }> {
  const client = await ensureClient();
  const r = (await client.call("task.snooze", { occurrenceId, minutes })) as { id: string };
  notifyRefresh();
  return r;
}

async function ipcListNotifications(limit = 100): Promise<{ items: NotificationItem[] }> {
  const client = await ensureClient();
  const r = (await client.call("notify.history", { limit })) as { items: NotificationView[] };
  return {
    items: r.items.map((n) => ({
      id: n.id,
      kind: n.kind,
      title: n.title,
      body: n.body,
      scheduledFor: n.scheduledFor,
      state: n.state,
      attempts: n.attempts,
      isCatchup: n.isCatchup,
    })),
  };
}

async function ipcTestNotify(): Promise<{ ok: boolean }> {
  const client = await ensureClient();
  const r = (await client.call("notify.test", {})) as { ok: boolean };
  notifyRefresh();
  return r;
}

async function ipcControl(pause: boolean): Promise<{ ok: boolean }> {
  const client = await ensureClient();
  const r = (await client.call(pause ? "ctrl.pauseAll" : "ctrl.resumeAll", {})) as { ok: boolean };
  notifyRefresh();
  return r;
}

/**
 * 检查更新。
 *
 * R3 只做**本地版本比对演示**，不联网：真正的更新服务属 M8。
 * 这里刻意返回 `available: false` 并在 message 里说明，
 * 而不是假装"已是最新" —— 诚实的空实现比错误的实现好。
 */
async function ipcOpenNotificationSettings(): Promise<{ ok: boolean; detail: string }> {
  if (process.platform !== "darwin") return { ok: false, detail: "仅 macOS 支持系统通知设置跳转" };
  // Ventura+ 使用 Notifications-Settings.extension；旧系统回退到 preference pane。
  const urls = [
    "x-apple.systempreferences:com.apple.Notifications-Settings.extension",
    "x-apple.systempreferences:com.apple.preference.notifications",
  ];
  for (const url of urls) {
    try {
      await shell.openExternal(url);
      log("info", "main.open_notification_settings", { url });
      return { ok: true, detail: "已打开系统通知设置" };
    } catch {
      /* 尝试下一个入口 */
    }
  }
  return { ok: false, detail: "无法打开系统通知设置，请手动打开系统设置 → 通知" };
}

async function ipcGetCalendar(): Promise<CalendarSettings> {
  const client = await ensureClient();
  return (await client.call("calendar.get", {})) as CalendarSettings;
}

async function ipcSetCalendar(settings: CalendarSettings): Promise<CalendarSettings> {
  const client = await ensureClient();
  return (await client.call("calendar.set", settings)) as CalendarSettings;
}

async function ipcPickCalendarFile(): Promise<string | null> {
  const options = {
    title: "选择日历导出的 .ics 文件",
    buttonLabel: "使用",
    filters: [{ name: "日历", extensions: ["ics"] }],
    properties: ["openFile"] as Array<"openFile">,
  };
  const picked =
    ctx.window && !ctx.window.isDestroyed()
      ? await dialog.showOpenDialog(ctx.window, options)
      : await dialog.showOpenDialog(options);
  return picked.canceled ? null : (picked.filePaths[0] ?? null);
}

async function ipcGetNotify(): Promise<NotifySettings> {
  const client = await ensureClient();
  return (await client.call("notify.get", {})) as NotifySettings;
}

async function ipcSetNotify(settings: NotifySettings): Promise<NotifySettings> {
  const client = await ensureClient();
  return (await client.call("notify.set", settings)) as NotifySettings;
}

async function ipcSetTelegramToken(token: string): Promise<{ hasToken: boolean }> {
  const client = await ensureClient();
  return (await client.call("notify.setTelegramToken", { token })) as { hasToken: boolean };
}

async function ipcClearTelegramToken(): Promise<{ hasToken: boolean }> {
  const client = await ensureClient();
  return (await client.call("notify.clearTelegramToken", {})) as { hasToken: boolean };
}

async function ipcSetBarkToken(token: string): Promise<{ hasToken: boolean }> {
  const client = await ensureClient();
  return (await client.call("notify.setBarkToken", { token })) as { hasToken: boolean };
}

async function ipcClearBarkToken(): Promise<{ hasToken: boolean }> {
  const client = await ensureClient();
  return (await client.call("notify.clearBarkToken", {})) as { hasToken: boolean };
}

async function ipcSetEmailPassword(password: string): Promise<{ hasPassword: boolean }> {
  const client = await ensureClient();
  return (await client.call("notify.setEmailPassword", { password })) as { hasPassword: boolean };
}

async function ipcClearEmailPassword(): Promise<{ hasPassword: boolean }> {
  const client = await ensureClient();
  return (await client.call("notify.clearEmailPassword", {})) as { hasPassword: boolean };
}

async function ipcTestEmail(): Promise<{ outcome: string; error?: string }> {
  const client = await ensureClient();
  return (await client.call("notify.testEmail", {})) as { outcome: string; error?: string };
}

async function ipcTestTts(): Promise<{ outcome: string; error?: string }> {
  const client = await ensureClient();
  return (await client.call("notify.testTts", {})) as { outcome: string; error?: string };
}

async function ipcTestBark(): Promise<{ outcome: string; error?: string }> {
  const client = await ensureClient();
  return (await client.call("notify.testBark", {})) as { outcome: string; error?: string };
}

async function ipcTestTelegram(): Promise<{ outcome: string; error?: string }> {
  const client = await ensureClient();
  return (await client.call("notify.testTelegram", {})) as { outcome: string; error?: string };
}

async function ipcTestWebhook(url: string): Promise<{ outcome: string; error?: string }> {
  const client = await ensureClient();
  return (await client.call("notify.testWebhook", { url })) as {
    outcome: string;
    error?: string;
  };
}

async function ipcGetBriefing(): Promise<BriefingSettings> {
  const client = await ensureClient();
  return (await client.call("briefing.get", {})) as BriefingSettings;
}

async function ipcSetBriefing(settings: BriefingSettings): Promise<BriefingSettings> {
  const client = await ensureClient();
  return (await client.call("briefing.set", settings)) as BriefingSettings;
}

async function ipcPickKnowledgeFile(): Promise<{ sourcePath: string; content: string } | null> {
  const options = {
    title: "选择要入库的文档",
    buttonLabel: "导入",
    filters: [{ name: "文档", extensions: ["md", "markdown", "txt"] }],
    properties: ["openFile"] as Array<"openFile">,
  };
  const picked =
    ctx.window && !ctx.window.isDestroyed()
      ? await dialog.showOpenDialog(ctx.window, options)
      : await dialog.showOpenDialog(options);
  if (picked.canceled || !picked.filePaths[0]) return null;
  const sourcePath = picked.filePaths[0];
  const content = readFileSync(sourcePath, "utf8");
  if (Buffer.byteLength(content, "utf8") > 2_000_000) throw new Error("文档超过 2MB 限制");
  return { sourcePath, content };
}

async function ipcImportKnowledge(
  sourcePath: string,
  content: string,
  dataClass: "L0" | "L1" | "L2" | "L3",
): Promise<{ document: KnowledgeDocument }> {
  const client = await ensureClient();
  return (await client.call("knowledge.import", { sourcePath, content, dataClass })) as {
    document: KnowledgeDocument;
  };
}

async function ipcListKnowledge(): Promise<{ documents: KnowledgeDocument[] }> {
  const client = await ensureClient();
  return (await client.call("knowledge.list", {})) as { documents: KnowledgeDocument[] };
}

async function ipcSearchKnowledge(query: string): Promise<{ hits: KnowledgeHit[] }> {
  const client = await ensureClient();
  return (await client.call("knowledge.search", { query, limit: 10 })) as { hits: KnowledgeHit[] };
}

async function ipcAnswerKnowledge(question: string): Promise<KnowledgeAnswerResult> {
  const client = await ensureClient();
  return (await client.call("knowledge.answer", { question })) as KnowledgeAnswerResult;
}

async function ipcRemoveKnowledge(id: string): Promise<{ ok: boolean }> {
  const client = await ensureClient();
  return (await client.call("knowledge.remove", { id })) as { ok: boolean };
}

async function ipcOpenKnowledgeSource(sourcePath: string): Promise<{ ok: boolean; error?: string }> {
  const error = await shell.openPath(sourcePath);
  return error ? { ok: false, error } : { ok: true };
}

async function ipcGetLlm(): Promise<LlmView> {
  const client = await ensureClient();
  return (await client.call("llm.get", {})) as LlmView;
}

async function ipcDiscoverLlmModels(): Promise<{ models: string[] }> {
  const client = await ensureClient();
  return (await client.call("llm.models", {})) as { models: string[] };
}

async function ipcGetLlmAudit(limit: number): Promise<{ entries: LlmAuditEntry[] }> {
  const client = await ensureClient();
  return (await client.call("llm.audit", { limit })) as { entries: LlmAuditEntry[] };
}

async function ipcSetLlm(settings: LlmSettingsView): Promise<LlmView> {
  const client = await ensureClient();
  return (await client.call("llm.set", settings)) as LlmView;
}

async function ipcSetLlmKey(apiKey: string): Promise<{ hasApiKey: boolean }> {
  const client = await ensureClient();
  return (await client.call("llm.setKey", { apiKey })) as { hasApiKey: boolean };
}

async function ipcClearLlmKey(): Promise<{ hasApiKey: boolean }> {
  const client = await ensureClient();
  return (await client.call("llm.clearKey", {})) as { hasApiKey: boolean };
}

async function ipcTestLlm(): Promise<LlmTestResult> {
  const client = await ensureClient();
  return (await client.call("llm.test", {})) as LlmTestResult;
}

async function ipcGetSystemHealth(): Promise<{
  health: SystemHealthView;
  errors: Array<{ path: string; message: string }>;
}> {
  const client = await ensureClient();
  return (await client.call("monitor.system", {})) as {
    health: SystemHealthView;
    errors: Array<{ path: string; message: string }>;
  };
}

async function ipcGetMonitorStatus(): Promise<{ monitors: MonitorStatusItem[] }> {
  const client = await ensureClient();
  return (await client.call("monitor.status", {})) as { monitors: MonitorStatusItem[] };
}

async function ipcInstallAcceptancePreset(): Promise<{
  installedSkills: string[];
  addedMonitors: string[];
  skippedMonitors: string[];
  monitors: MonitorConfigView[];
}> {
  const client = await ensureClient();
  return (await client.call("monitor.preset", {})) as {
    installedSkills: string[];
    addedMonitors: string[];
    skippedMonitors: string[];
    monitors: MonitorConfigView[];
  };
}

async function ipcGetMonitorConfig(): Promise<{ monitors: MonitorConfigView[] }> {
  const client = await ensureClient();
  return (await client.call("monitor.config", {})) as { monitors: MonitorConfigView[] };
}

async function ipcAddMonitor(config: MonitorConfigView): Promise<{ monitors: MonitorConfigView[] }> {
  const client = await ensureClient();
  return (await client.call("monitor.add", config)) as { monitors: MonitorConfigView[] };
}

async function ipcToggleMonitor(id: string, enabled: boolean): Promise<{ monitors: MonitorConfigView[] }> {
  const client = await ensureClient();
  return (await client.call("monitor.toggle", { id, enabled })) as { monitors: MonitorConfigView[] };
}

async function ipcRemoveMonitor(id: string): Promise<{ monitors: MonitorConfigView[] }> {
  const client = await ensureClient();
  return (await client.call("monitor.remove", { id })) as { monitors: MonitorConfigView[] };
}

/** 手动触发一次扫描；扫描结果由 renderer 展示，失败由 IPC 抛回 */
async function ipcScanMonitor(id: string): Promise<{ found: boolean; notified: number; errors: number }> {
  const client = await ensureClient();
  return (await client.call("monitor.scan", { id })) as { found: boolean; notified: number; errors: number };
}

/** 列出 Skill；daemon 负责读取 skills/ 并校验，坏文件也返回 */
async function ipcListSkills(): Promise<{ skills: SkillListEntry[] }> {
  const client = await ensureClient();
  return (await client.call("skill.list", {})) as { skills: SkillListEntry[] };
}

/**
 * 选择并读取一个 Skill YAML。
 *
 * 安全边界：路径来自主进程原生对话框，renderer 不能指定任意文件；
 * 读取后只传文件名 + 内容给 daemon，由 daemon 再做路径/契约校验。
 */
async function ipcPickSkillFile(): Promise<{ filename: string; content: string } | null> {
  const options = {
    title: "选择 Skill YAML",
    buttonLabel: "导入",
    filters: [{ name: "Skill", extensions: ["yaml", "yml"] }],
    properties: ["openFile"] as Array<"openFile">,
  };
  const picked =
    ctx.window && !ctx.window.isDestroyed()
      ? await dialog.showOpenDialog(ctx.window, options)
      : await dialog.showOpenDialog(options);
  if (picked.canceled || !picked.filePaths[0]) return null;

  const path = picked.filePaths[0];
  const content = readFileSync(path, "utf8");
  if (Buffer.byteLength(content, "utf8") > 300_000) throw new Error("Skill 文件超过 300KB");
  return { filename: basename(path), content };
}

async function ipcImportSkill(filename: string, content: string): Promise<{ skill: SkillListEntry }> {
  const client = await ensureClient();
  return (await client.call("skill.import", { filename, content })) as { skill: SkillListEntry };
}

async function ipcDeleteSkill(filename: string): Promise<{ ok: boolean }> {
  const client = await ensureClient();
  return (await client.call("skill.delete", { filename })) as { ok: boolean };
}

/**
 * 导出 Skill：daemon 负责读取（路径校验在 daemon），主进程负责让用户选保存位置。
 * renderer 不能指定任意源路径或目标路径。
 */
async function ipcExportSkill(filename: string): Promise<SkillExportResult> {
  const client = await ensureClient();
  const r = (await client.call("skill.read", { filename })) as { filename: string; content: string };
  const options = {
    title: "导出 Skill",
    defaultPath: r.filename,
    filters: [{ name: "Skill", extensions: ["yaml", "yml"] }],
  };
  const picked =
    ctx.window && !ctx.window.isDestroyed()
      ? await dialog.showSaveDialog(ctx.window, options)
      : await dialog.showSaveDialog(options);
  if (picked.canceled || !picked.filePath) return { canceled: true };
  writeFileSync(picked.filePath, r.content, "utf8");
  log("info", "main.skill_exported", { filename: r.filename });
  return { canceled: false, path: picked.filePath };
}

async function ipcInstallDefaultSkills(): Promise<{ installed: string[]; skipped: string[] }> {
  const client = await ensureClient();
  return (await client.call("skill.installDefaults", {})) as {
    installed: string[];
    skipped: string[];
  };
}

async function ipcGetDnd(): Promise<DndSettingsView> {
  const client = await ensureClient();
  return (await client.call("dnd.get", {})) as DndSettingsView;
}

async function ipcSetDnd(settings: DndSettingsView): Promise<{ ok: boolean }> {
  const client = await ensureClient();
  const r = (await client.call("dnd.set", settings)) as { ok: boolean };
  notifyRefresh();
  return r;
}

async function ipcCheckUpdate(): Promise<UpdateInfo> {
  return {
    available: false,
    currentVersion: APP_VERSION,
    latestVersion: null,
    message: `当前版本 ${APP_VERSION}。自动更新将在 M8 提供，本版本不联网检查。`,
  };
}

/** 备份目录名（本地时间，精确到秒；同一秒重复导出会由 daemon 拒绝覆盖） */
function backupDirName(): string {
  const d = new Date();
  const p2 = (n: number): string => String(n).padStart(2, "0");
  return `Aegis-backup-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
}

/**
 * 导出备份。
 *
 * 安全边界：**目录由主进程的原生对话框决定**，renderer 不能传任意路径；
 * 生成的是父目录下新的子目录（createBackup 要求目标不存在）。
 */
async function ipcExportBackup(): Promise<BackupExportResult> {
  const options = {
    title: "选择备份保存位置",
    buttonLabel: "导出到此文件夹",
    properties: ["openDirectory", "createDirectory"] as Array<"openDirectory" | "createDirectory">,
  };
  const picked =
    ctx.window && !ctx.window.isDestroyed()
      ? await dialog.showOpenDialog(ctx.window, options)
      : await dialog.showOpenDialog(options);
  if (picked.canceled || !picked.filePaths[0]) return { canceled: true };

  const targetDir = join(picked.filePaths[0], backupDirName());
  const client = await ensureClient();
  const r = (await client.call("backup.export", { targetDir, includeHistory: true })) as {
    path: string;
    files: number;
    totalBytes: number;
  };
  log("info", "main.backup_exported", { path: r.path, files: r.files, totalBytes: r.totalBytes });
  return { canceled: false, outDir: r.path, files: r.files, totalBytes: r.totalBytes };
}

// ── 启动流程 ────────────────────────────────────────────────────────────

async function bootstrap(): Promise<void> {
  log("info", "main.bootstrap_begin", { dataDir: ctx.paths.dataDir, version: APP_VERSION });

  // ── ① 探测系统通知是否真的可用
  //
  // 必须在通道启动前做：`Notification.isSupported()` 在未授权时也返回 true，
  // 只有真的发一条并等 show/failed 事件才能知道真相（实测 macOS 会直接拒绝未签名应用）。
  const sysProbe = await probeSystemNotification();
  ctx.systemNotificationOk = sysProbe.ok;
  ctx.systemNotificationDetail = sysProbe.ok ? null : sysProbe.detail;
  log(sysProbe.ok ? "info" : "warn", "main.system_notification_probe", {
    ok: sysProbe.ok,
    detail: sysProbe.detail,
  });

  // ── ② 桌面通道：让 daemon 能提醒用户
  ctx.channelHost = await startChannelHost({
    channelFilePath: ctx.paths.channelFile,
    presenter: createElectronPresenter({
      systemNotificationOk: () => ctx.systemNotificationOk,
      deliver: async (payload) => {
        const r = await deliverWithAttention(ctx.window, payload);
        if (r.systemError) {
          log("warn", "main.system_notification_denied", { error: r.systemError });
        }
        return r;
      },
    }),
    onLog: (level, event, detail) => log(level, event, detail),
  });
  log("info", "main.channel_ready", { endpoint: ctx.channelHost.endpoint });

  // ── ② 渠道探测列表（顺序 = 降级链）
  ctx.desktopSender = createDesktopChannelSender({ channelFilePath: ctx.paths.channelFile });
  ctx.notifierProbes = [ctx.desktopSender, desktopChannelProbe.cliFallback()];

  // ── ③ daemon 监督（先创建监督者，再建窗口）
  //
  // 顺序很关键：监督者一旦被创建就可以报告状态（"启动中"->"运行中"），
  // 窗口据此显示准确信息。若先建窗口再建监督者，界面首次查询会得到
  // "未运行"并弹出红色横幅 —— 明明正在启动，却吓用户一跳（实测）。
  const nodeExec = resolveNodeExecPath(undefined, process.resourcesPath);
  if (!nodeExec) {
    log("error", "main.node_not_found", {
      hint: "未找到 Node 运行时。开发态请设置 AEGIS_NODE_PATH；打包态应包含 Resources/node/bin/node。",
    });
  } else {
    const repoRoot = join(import.meta.dirname, "..", "..", "..");
    const entry = resolveDaemonEntry({ repoRoot, resourcesPath: process.resourcesPath });
    if (!entry) {
      log("error", "main.daemon_entry_not_found", { repoRoot });
    } else {
      ctx.supervisor = new DaemonSupervisor({
        paths: ctx.paths,
        daemonEntry: entry,
        nodeExecPath: nodeExec,
        onStateChange: (state) => {
          pushDaemonState(state.kind);
          notifyRefresh();
        },
        onLog: (level, event, detail) => log(level, event, detail),
      });
      // 不 await：ensureRunning 会先把状态置为 "starting"（同步执行到第一个 await 前），
      // 因此窗口立刻就能显示"后台服务启动中"，而不是黑屏或"未运行"。
      void ctx.supervisor.ensureRunning().then((state) => {
        log("info", "main.daemon_state", { kind: state.kind });
      });
    }
  }

  // ── ④ 窗口与托盘
  //
  // 在 daemon 启动之前就建好窗口：界面立刻可见并显示"后台服务启动中…"，
  // 用户不会面对几秒的黑屏。等 daemon 就绪后由 pushDaemonState 通知界面刷新。
  ctx.window = createWindow();
  createTray();
}

// ── 事件注册 ────────────────────────────────────────────────────────────

function registerIpcHandlers(): void {
  // 统一包装：把异常转成可读错误，避免 renderer 拿到 "Error invoking remote method"
  const wrap = <A extends unknown[], R>(fn: (...args: A) => Promise<R>) => {
    return async (_e: unknown, ...args: A): Promise<R> => {
      try {
        return await fn(...args);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log("error", "main.ipc_error", { message: msg });
        throw new Error(msg);
      }
    };
  };

  ipcMain.handle("aegis:status", wrap(ipcGetStatus));
  ipcMain.handle("aegis:tasks:list", wrap(ipcListTasks));
  ipcMain.handle(
    "aegis:tasks:create",
    wrap((p: CreateTaskPayload) => ipcCreateTask(p)),
  );
  ipcMain.handle(
    "aegis:tasks:get",
    wrap((id: string) => ipcGetTask(id)),
  );
  ipcMain.handle(
    "aegis:tasks:update",
    wrap((p: UpdateTaskPayload) => ipcUpdateTask(p)),
  );
  ipcMain.handle(
    "aegis:tasks:pause",
    wrap((id: string) => ipcTaskToggle(id, false)),
  );
  ipcMain.handle(
    "aegis:tasks:resume",
    wrap((id: string) => ipcTaskToggle(id, true)),
  );
  ipcMain.handle(
    "aegis:tasks:delete",
    wrap((id: string) => ipcDeleteTask(id)),
  );
  ipcMain.handle(
    "aegis:occurrences:complete",
    wrap((occurrenceId: string) => ipcCompleteOccurrence(occurrenceId)),
  );
  ipcMain.handle(
    "aegis:occurrences:snooze",
    wrap((p: { occurrenceId: string; minutes: number }) => ipcSnoozeOccurrence(p.occurrenceId, p.minutes)),
  );
  ipcMain.handle(
    "aegis:notifications:list",
    wrap((limit?: number) => ipcListNotifications(limit)),
  );
  ipcMain.handle(
    "aegis:notifications:test",
    wrap(() => ipcTestNotify()),
  );
  ipcMain.handle(
    "aegis:ctrl:pauseAll",
    wrap(() => ipcControl(true)),
  );
  ipcMain.handle(
    "aegis:ctrl:resumeAll",
    wrap(() => ipcControl(false)),
  );
  ipcMain.handle(
    "aegis:backup:export",
    wrap(() => ipcExportBackup()),
  );
  ipcMain.handle(
    "aegis:notifications:open-settings",
    wrap(() => ipcOpenNotificationSettings()),
  );
  ipcMain.handle(
    "aegis:llm:get",
    wrap(() => ipcGetLlm()),
  );
  ipcMain.handle(
    "aegis:calendar:get",
    wrap(() => ipcGetCalendar()),
  );
  ipcMain.handle(
    "aegis:calendar:set",
    wrap((settings: CalendarSettings) => ipcSetCalendar(settings)),
  );
  ipcMain.handle(
    "aegis:calendar:pick",
    wrap(() => ipcPickCalendarFile()),
  );
  ipcMain.handle(
    "aegis:notify:get",
    wrap(() => ipcGetNotify()),
  );
  ipcMain.handle(
    "aegis:notify:set",
    wrap((settings: NotifySettings) => ipcSetNotify(settings)),
  );
  ipcMain.handle(
    "aegis:notify:test-webhook",
    wrap((p: { url: string }) => ipcTestWebhook(p.url)),
  );
  ipcMain.handle(
    "aegis:notify:set-telegram-token",
    wrap((p: { token: string }) => ipcSetTelegramToken(p.token)),
  );
  ipcMain.handle(
    "aegis:notify:clear-telegram-token",
    wrap(() => ipcClearTelegramToken()),
  );
  ipcMain.handle(
    "aegis:notify:test-telegram",
    wrap(() => ipcTestTelegram()),
  );
  ipcMain.handle(
    "aegis:notify:set-bark-token",
    wrap((p: { token: string }) => ipcSetBarkToken(p.token)),
  );
  ipcMain.handle(
    "aegis:notify:clear-bark-token",
    wrap(() => ipcClearBarkToken()),
  );
  ipcMain.handle(
    "aegis:notify:test-bark",
    wrap(() => ipcTestBark()),
  );
  ipcMain.handle(
    "aegis:notify:test-tts",
    wrap(() => ipcTestTts()),
  );
  ipcMain.handle(
    "aegis:notify:set-email-password",
    wrap((p: { password: string }) => ipcSetEmailPassword(p.password)),
  );
  ipcMain.handle(
    "aegis:notify:clear-email-password",
    wrap(() => ipcClearEmailPassword()),
  );
  ipcMain.handle(
    "aegis:notify:test-email",
    wrap(() => ipcTestEmail()),
  );
  ipcMain.handle(
    "aegis:briefing:get",
    wrap(() => ipcGetBriefing()),
  );
  ipcMain.handle(
    "aegis:briefing:set",
    wrap((settings: BriefingSettings) => ipcSetBriefing(settings)),
  );
  ipcMain.handle(
    "aegis:knowledge:pick",
    wrap(() => ipcPickKnowledgeFile()),
  );
  ipcMain.handle(
    "aegis:knowledge:import",
    wrap((p: { sourcePath: string; content: string; dataClass: "L0" | "L1" | "L2" | "L3" }) =>
      ipcImportKnowledge(p.sourcePath, p.content, p.dataClass),
    ),
  );
  ipcMain.handle(
    "aegis:knowledge:list",
    wrap(() => ipcListKnowledge()),
  );
  ipcMain.handle(
    "aegis:knowledge:search",
    wrap((p: { query: string }) => ipcSearchKnowledge(p.query)),
  );
  ipcMain.handle(
    "aegis:knowledge:remove",
    wrap((p: { id: string }) => ipcRemoveKnowledge(p.id)),
  );
  ipcMain.handle(
    "aegis:knowledge:answer",
    wrap((p: { question: string }) => ipcAnswerKnowledge(p.question)),
  );
  ipcMain.handle(
    "aegis:knowledge:open",
    wrap((p: { sourcePath: string }) => ipcOpenKnowledgeSource(p.sourcePath)),
  );
  ipcMain.handle(
    "aegis:llm:models",
    wrap(() => ipcDiscoverLlmModels()),
  );
  ipcMain.handle(
    "aegis:llm:audit",
    wrap((limit: number) => ipcGetLlmAudit(limit)),
  );
  ipcMain.handle(
    "aegis:llm:set",
    wrap((settings: LlmSettingsView) => ipcSetLlm(settings)),
  );
  ipcMain.handle(
    "aegis:llm:set-key",
    wrap((p: { apiKey: string }) => ipcSetLlmKey(p.apiKey)),
  );
  ipcMain.handle(
    "aegis:llm:clear-key",
    wrap(() => ipcClearLlmKey()),
  );
  ipcMain.handle(
    "aegis:llm:test",
    wrap(() => ipcTestLlm()),
  );
  ipcMain.handle(
    "aegis:system:health",
    wrap(() => ipcGetSystemHealth()),
  );
  ipcMain.handle(
    "aegis:monitor:status",
    wrap(() => ipcGetMonitorStatus()),
  );
  ipcMain.handle(
    "aegis:monitor:scan",
    wrap((id: string) => ipcScanMonitor(id)),
  );
  ipcMain.handle(
    "aegis:monitor:config",
    wrap(() => ipcGetMonitorConfig()),
  );
  ipcMain.handle(
    "aegis:monitor:preset",
    wrap(() => ipcInstallAcceptancePreset()),
  );
  ipcMain.handle(
    "aegis:monitor:add",
    wrap((config: MonitorConfigView) => ipcAddMonitor(config)),
  );
  ipcMain.handle(
    "aegis:monitor:toggle",
    wrap((p: { id: string; enabled: boolean }) => ipcToggleMonitor(p.id, p.enabled)),
  );
  ipcMain.handle(
    "aegis:monitor:remove",
    wrap((id: string) => ipcRemoveMonitor(id)),
  );
  ipcMain.handle(
    "aegis:skill:list",
    wrap(() => ipcListSkills()),
  );
  ipcMain.handle(
    "aegis:skill:pick",
    wrap(() => ipcPickSkillFile()),
  );
  ipcMain.handle(
    "aegis:skill:import",
    wrap((p: { filename: string; content: string }) => ipcImportSkill(p.filename, p.content)),
  );
  ipcMain.handle(
    "aegis:skill:delete",
    wrap((p: { filename: string }) => ipcDeleteSkill(p.filename)),
  );
  ipcMain.handle(
    "aegis:skill:export",
    wrap((p: { filename: string }) => ipcExportSkill(p.filename)),
  );
  ipcMain.handle(
    "aegis:skill:install-defaults",
    wrap(() => ipcInstallDefaultSkills()),
  );
  ipcMain.handle(
    "aegis:dnd:get",
    wrap(() => ipcGetDnd()),
  );
  ipcMain.handle(
    "aegis:dnd:set",
    wrap((settings: DndSettingsView) => ipcSetDnd(settings)),
  );
  ipcMain.handle(
    "aegis:update:check",
    wrap(() => ipcCheckUpdate()),
  );

  // ── 首次启动向导与开机自启
  ipcMain.handle(
    "aegis:onboarding:get",
    wrap(() => ipcGetOnboarding()),
  );
  ipcMain.handle(
    "aegis:onboarding:complete",
    wrap((c: { autostart: boolean }) => ipcCompleteOnboarding(c)),
  );
  ipcMain.handle(
    "aegis:autostart:set",
    wrap((enabled: boolean) => ipcSetAutostart(enabled)),
  );
}

// ── 顶层异常兜底 ────────────────────────────────────────────────────────

/**
 * 未捕获异常的处理策略。
 *
 * Electron 的默认行为是弹一个"主进程发生 JavaScript 错误"的**模态对话框**。
 * 对一个 24 小时常驻的提醒工具，这是有害的：
 *   - 它挡住用户，但后台服务其实还在正常跑
 *   - 用户不知道该点"好"还是"退出"，往往直接关掉应用 —— 提醒就真的停了
 *
 * 因此改为：**记录完整堆栈 + 在界面里显示一条可见的提示 + 继续运行**。
 * 这不是"吞掉错误"：日志里有堆栈，界面上有提示，符合"失败必须可见"。
 */
process.on("uncaughtException", (err) => {
  log("error", "main.uncaught_exception", {
    error: err.message,
    stack: (err.stack ?? "").split("\n").slice(0, 6).join(" | "),
  });
  sendToRenderer("aegis:alert", {
    title: "主进程出现内部错误（已记录，服务继续运行）",
    body: err.message,
  });
});

process.on("unhandledRejection", (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  log("error", "main.unhandled_rejection", { error: message });
  // Promise 拒绝通常是局部失效，不必打扰用户；只记录，避免刷屏
});

// ── 应用生命周期 ────────────────────────────────────────────────────────

// 单实例锁：第二次启动时聚焦已有窗口，而不是开两个 UI 抢同一个 daemon
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (ctx.window) {
      ctx.window.show();
      ctx.window.focus();
    }
  });

  // 菜单：去掉默认的"View/Window"噪音，只留必要的
  app.whenReady().then(async () => {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: "Aegis",
          submenu: [
            { role: "about", label: "关于 Aegis" },
            { type: "separator" },
            {
              label: "打开数据目录",
              click: () => void shell.openPath(ctx.paths.dataDir),
            },
            { type: "separator" },
            {
              label: "关闭窗口",
              accelerator: "CommandOrControl+W",
              click: hideWindow,
            },
            {
              label: "退出界面（提醒继续运行）",
              click: () => {
                ctx.quitting = true;
                app.quit();
              },
            },
            {
              label: "完全退出（含后台服务）",
              accelerator: "CommandOrControl+Q",
              click: requestFullQuit,
            },
          ],
        },
        {
          label: "编辑",
          submenu: [
            { role: "undo", label: "撤销" },
            { role: "redo", label: "重做" },
            { type: "separator" },
            { role: "cut", label: "剪切" },
            { role: "copy", label: "复制" },
            { role: "paste", label: "粘贴" },
            { role: "selectAll", label: "全选" },
          ],
        },
      ]),
    );

    registerIpcHandlers();
    try {
      await bootstrap();
    } catch (err) {
      log("error", "main.bootstrap_failed", { error: (err as Error).message });
      // 即使 bootstrap 失败也要建窗口，否则用户只看到"应用没反应"
      if (!ctx.window) ctx.window = createWindow();
    }

    app.on("activate", () => {
      if (!ctx.window) ctx.window = createWindow();
      else {
        ctx.window.show();
        ctx.window.focus();
      }
    });
  });

  // 所有窗口关闭时不退出（留在托盘）
  app.on("window-all-closed", () => {
    // 刻意留空：macOS 上应用应继续在托盘运行
  });

  app.on("before-quit", () => {
    ctx.quitting = true;
    if (quitArmTimer) {
      clearTimeout(quitArmTimer);
      quitArmTimer = null;
    }
    // 关闭通道服务（删除 channel.json，让 daemon 立刻改用 CLI 兜底）
    void ctx.channelHost?.close();
    // 释放监督器（不杀 daemon）
    ctx.supervisor?.dispose();
    ctx.client?.close();
  });
}
