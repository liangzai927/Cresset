/**
 * renderer 与主进程之间的**类型契约**
 *
 * 这个文件被三处引用：`preload.ts`（实现）、`main.ts`（处理）、
 * `renderer/app.js`（消费，经 JSDoc 类型提示）。因此它是唯一真相源 ——
 * 改字段必须三处同时改，TypeScript 会在编译期拦住遗漏。
 *
 * 设计原则：**只暴露界面真正需要的形状**，不把 daemon 的内部结构透出去。
 * 例如 `TaskView` 里的 `id` 在界面上只用于操作，因此保留；但 `tzid` 之类
 * 属于实现细节，界面拿到也无用，就不传。
 */

/** 重复模式（与 ipc-contract 的 RepeatMode 对应，但这里是界面视角的枚举） */
export type RepeatMode = "once" | "daily" | "weekdays" | "weekly" | "monthly" | "every_minutes";

/** 界面上的任务视图 */
export interface TaskItem {
  id: string;
  title: string;
  notes: string | null;
  priority: "normal" | "important";
  enabled: boolean;
  /** 人话描述的重复规则，如"工作日 09:00" */
  repeatLabel: string;
  /** 下次触发的墙上时间（`YYYY-MM-DDTHH:mm`）；已结束为 null */
  nextFireWall: string | null;
  /** 已触发次数 */
  firedCount: number;
  /** 上次成功投递时刻（UTC 毫秒）；从未投递为 null */
  lastDeliveredAt: number | null;
}

/** 提醒列表的返回包装（保留分页扩展位，当前全量返回） */
export interface TasksPage {
  items: TaskItem[];
}

/** 一条投递尝试的摘要 */
export interface AttemptItem {
  channel: string;
  outcome: string;
  error: string | null;
}

/** 界面上的通知视图 */
export interface NotificationItem {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  scheduledFor: number;
  state: string;
  attempts: AttemptItem[];
  isCatchup: boolean;
}

/** 通知历史的返回包装（同上） */
export interface NotificationsPage {
  items: NotificationItem[];
}

/** 创建任务的参数（界面 → 主进程） */
export interface CreateTaskPayload {
  title: string;
  notes?: string;
  priority: "normal" | "important";
  /** 首次触发的墙上时间 `YYYY-MM-DDTHH:mm` */
  firstFireAtWall: string;
  repeat: {
    mode: RepeatMode;
    /** weekly：1=周一 … 7=周日 */
    byWeekday?: number[];
    /** monthly：1-31 */
    byMonthDay?: number;
    /** every_minutes */
    intervalMinutes?: number;
  };
}

/** 渠道可用性（设置页展示"为什么走兜底"） */
export interface ChannelStatus {
  channel: string;
  ok: boolean;
  detail: string;
}

/** 诊断信息（状态页 + 诊断页共用） */
export interface DiagnosticInfo {
  /** daemon 生命周期状态 */
  daemonState: "stopped" | "starting" | "running" | "crashed" | "unavailable";
  /** 不可用/崩溃时的原因（界面必须显示，不许静默） */
  daemonReason: string | null;
  /**
   * daemon 是否已可接受调用。
   *
   * 界面据此**禁用**需要后端的动作并给出"启动中"提示，
   * 而不是让用户点了才看到一句报错（实测这是最令人困惑的体验）。
   */
  daemonReady: boolean;
  /** daemon 是否由本次 UI 拉起 */
  spawnedByUs: boolean;
  /** daemon 健康检查结果（daemon 未运行时为 null） */
  health: {
    ok: boolean;
    uptimeS: number;
    tickCount: number;
    nextDueAt: number | null;
    rssBytes: number;
    degradedReasons: string[];
  } | null;
  /** 通知渠道探测结果，顺序即降级链 */
  channels: ChannelStatus[];
  /** 数据目录（供用户排查） */
  dataDir: string;
  /** 数据库文件路径 */
  dbFile: string;
  /** 应用版本 */
  appVersion: string;
  /** daemon 版本 */
  daemonVersion: string | null;
  /** 本机时区 */
  timeZone: string;
  /** 系统通知是否真的能显示（false 时靠前台强提醒兜底） */
  systemNotificationOk: boolean;
  /** 系统通知不可用的具体原因（展示给用户，便于判断要不要打包签名） */
  systemNotificationDetail: string | null;
  /** 系统通知是否受支持（API 层面；不代表真的能显示） */
  notificationsSupported: boolean;
}

/** 首次启动向导的状态（决定是否展示向导） */
export interface OnboardingState {
  /** 是否还没完成首次配置 */
  needed: boolean;
  /** 开机自启当前是否已开启 */
  autostartEnabled: boolean;
  /** 系统通知是否受支持（API 层面） */
  notificationsSupported: boolean;
  /** 系统通知是否真的能显示（false 时导向窗口提醒兜底） */
  systemNotificationOk: boolean;
  /** 本机时区（向导里展示，避免用户误解触发时间按哪个时区算） */
  timeZone: string;
}

/** 更新检查结果（R3 只做提示，不自动下载） */
export interface UpdateInfo {
  available: boolean;
  currentVersion: string;
  latestVersion: string | null;
  message: string;
}

/**
 * 暴露给 renderer 的 API 契约。
 *
 * ⚠️ 这个接口是**安全边界**：`preload.ts` 严格按它实现，
 * 页面拿不到任何它之外的能力（尤其是没有通用的 `invoke(channel, ...)`）。
 */
export interface DesktopApi {
  getStatus(): Promise<DiagnosticInfo>;

  listTasks(): Promise<TasksPage>;
  createTask(payload: CreateTaskPayload): Promise<{ id: string }>;
  pauseTask(id: string): Promise<{ ok: boolean }>;
  resumeTask(id: string): Promise<{ ok: boolean }>;
  deleteTask(id: string): Promise<{ ok: boolean }>;

  listNotifications(limit?: number): Promise<NotificationsPage>;
  testNotify(): Promise<{ ok: boolean }>;

  pauseAll(): Promise<{ ok: boolean }>;
  resumeAll(): Promise<{ ok: boolean }>;

  checkUpdate(): Promise<UpdateInfo>;

  /** 首次启动向导 */
  getOnboarding(): Promise<OnboardingState>;
  completeOnboarding(choices: { autostart: boolean }): Promise<{ ok: boolean; detail: string }>;
  setAutostart(enabled: boolean): Promise<{ ok: boolean; detail: string }>;

  /** 订阅 daemon 状态变化；返回取消订阅函数 */
  onDaemonState(cb: (state: string) => void): () => void;
  /** 订阅"界面该刷新了"的通知（daemon 状态变化、通知投递完成等） */
  onRefresh(cb: () => void): () => void;
  /**
   * 订阅应用内提醒。
   *
   * 系统通知不可用时，主进程会把提醒广播到界面（同时窗口置前 + 响铃），
   * 界面负责渲染一条**必须手动确认**的横幅 —— 这是"提醒一定到达"的保底。
   */
  onAlert(cb: (payload: { title: string; body?: string }) => void): () => void;
}
