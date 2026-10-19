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

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createDesktopChannelSender,
  type DesktopChannelSender,
  desktopChannelProbe,
  type Notifier,
} from "@aegis/platform";
import { type DataPaths, resolveDataPaths } from "@aegis/product";
import { app, BrowserWindow, ipcMain, Menu, Notification, nativeImage, shell, Tray } from "electron";
import { IpcClient } from "../../daemon/src/ipc/client.js";
import type {
  ChannelStatus,
  CreateTaskPayload,
  DiagnosticInfo,
  NotificationItem,
  TaskItem,
  UpdateInfo,
} from "./api-types.js";
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
};

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
    win.webContents.once("did-finish-load", () => {
      // 等一小会儿让首屏数据（status/tasks）渲染完成
      setTimeout(() => {
        // AEGIS_CAPTURE_TAB 可指定标签页（tasks / history / settings），
        // 便于自动化覆盖三个页签的渲染结果
        void win.webContents
          .capturePage()
          .then((image) => {
            writeFileSync(capturePath, image.toPNG());
            log("info", "main.capture_saved", { path: capturePath, bytes: image.toPNG().length });
          })
          .catch((err: unknown) => log("error", "main.capture_failed", { error: String(err) }))
          .finally(() => {
            ctx.quitting = true;
            app.quit();
          });
      }, 3_000);
    });
  }

  // 关闭窗口 → 隐藏到托盘（不退出，服务继续跑）
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
  void win.loadFile(
    join(import.meta.dirname, "renderer", "index.html"),
    initialTab ? { query: { tab: initialTab } } : undefined,
  );
  return win;
}

/** 托盘图标：用内联的 16x16 PNG，避免打包时漏资源 */
function createTray(): void {
  // 一个极简的圆点图标（16x16，模板图会随系统明暗自动反色）
  const pngBase64 =
    "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABmJLR0QA/wD/AP+gvaeTAAAAXUlEQVR42mNgYGD4z0AswKqBiUYDmKg2gIlGA5ioNoCJagOYqDaAiWoDmKg2gIlqA5ioNoCJagOYqDaAiWoDmKg2gIlqA5ioNoCJagOYqDaAiWoDmKg2gIlqAwB6tAX9J2y1TQAAAABJRU5ErkJggg==";
  const icon = nativeImage.createFromBuffer(Buffer.from(pngBase64, "base64"));
  icon.setTemplateImage(true);

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

// ── daemon 连接 ─────────────────────────────────────────────────────────

/**
 * 确保有一个已连接的 IPC 客户端。
 *
 * 重连策略：每次调用都检查 `client` 是否可用；不可用则按当前握手文件重建。
 * 这样 daemon 重启后（换了 token）无需重启 UI。
 */
async function ensureClient(): Promise<IpcClient> {
  if (ctx.client) return ctx.client;

  const hs = ctx.supervisor?.readHandshake() ?? null;
  if (!hs) throw new Error("daemon 尚未就绪");

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
}

/** 通知 renderer 刷新（daemon 状态变化、需要重新拉数据时） */
function notifyRefresh(): void {
  ctx.window?.webContents.send("aegis:refresh");
}

function pushDaemonState(state: string): void {
  ctx.window?.webContents.send("aegis:daemon-state", state);
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
      taskChannels = taskChannels.sort((a, b) => (a.channel === "os_notification" ? -1 : 1));
    } catch (err) {
      log("warn", "main.status_health_failed", { error: (err as Error).message });
    }
  }

  return {
    daemonState: state.kind,
    daemonReason: state.kind === "crashed" || state.kind === "unavailable" ? state.reason : null,
    spawnedByUs: state.kind === "running" ? state.spawnedByUs : false,
    health,
    channels: taskChannels,
    dataDir: ctx.paths.dataDir,
    dbFile: ctx.paths.dbFile,
    appVersion: APP_VERSION,
    daemonVersion: state.kind === "running" ? (state.handshake.daemonVersion ?? null) : null,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    notificationsSupported: Notification.isSupported(),
  };
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
async function ipcCheckUpdate(): Promise<UpdateInfo> {
  return {
    available: false,
    currentVersion: APP_VERSION,
    latestVersion: null,
    message: `当前版本 ${APP_VERSION}。自动更新将在 M8 提供，本版本不联网检查。`,
  };
}

// ── 启动流程 ────────────────────────────────────────────────────────────

async function bootstrap(): Promise<void> {
  log("info", "main.bootstrap_begin", { dataDir: ctx.paths.dataDir, version: APP_VERSION });

  // ── ① 桌面通道：让 daemon 能弹原生通知
  ctx.channelHost = await startChannelHost({
    channelFilePath: ctx.paths.channelFile,
    presenter: createElectronPresenter(
      Notification as unknown as Parameters<typeof createElectronPresenter>[0],
    ),
    onLog: (level, event, detail) => log(level, event, detail),
  });
  log("info", "main.channel_ready", { endpoint: ctx.channelHost.endpoint });

  // ── ② 渠道探测列表（顺序 = 降级链）
  ctx.desktopSender = createDesktopChannelSender({ channelFilePath: ctx.paths.channelFile });
  ctx.notifierProbes = [ctx.desktopSender, desktopChannelProbe.cliFallback()];

  // ── ③ daemon 监督
  const nodeExec = resolveNodeExecPath();
  if (!nodeExec) {
    log("error", "main.node_not_found", {
      hint: "未找到系统 Node。设置 AEGIS_NODE_PATH 环境变量指向 node 可执行文件。",
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
      const state = await ctx.supervisor.ensureRunning();
      log("info", "main.daemon_state", { kind: state.kind });
    }
  }

  // ── ④ 窗口与托盘
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
    "aegis:update:check",
    wrap(() => ipcCheckUpdate()),
  );
}

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
              label: "退出界面（提醒继续运行）",
              click: () => {
                ctx.quitting = true;
                app.quit();
              },
            },
            {
              label: "完全退出（含后台服务）",
              accelerator: "Cmd+Shift+Q",
              click: async () => {
                ctx.quitting = true;
                try {
                  const client = await ensureClient();
                  await client.call("sys.shutdown", {});
                } catch {
                  /* daemon 可能已不在；忽略 */
                }
                app.quit();
              },
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
    // 关闭通道服务（删除 channel.json，让 daemon 立刻改用 CLI 兜底）
    void ctx.channelHost?.close();
    // 释放监督器（不杀 daemon）
    ctx.supervisor?.dispose();
    ctx.client?.close();
  });
}
