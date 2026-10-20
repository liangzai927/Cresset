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
    /** custom_rrule：原样 RRULE */
    rrule?: string;
  };
  /** 对全局免打扰的覆盖 */
  dndOverride?: "inherit" | "allow" | "block";
}

/** 编辑对话框回填的完整任务 */
export interface TaskEditItem {
  id: string;
  title: string;
  notes: string | null;
  priority: "normal" | "important";
  firstFireAtWall: string;
  repeat: CreateTaskPayload["repeat"];
  catchupWindowS: number;
  dndOverride: "inherit" | "allow" | "block";
}

/** 更新任务 = 完整创建输入 + id */
export type UpdateTaskPayload = CreateTaskPayload & { id: string };

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

/** 免打扰时段（与 daemon 的 DndSettingsView 对齐） */
export interface DndWindowView {
  /** ISO 星期：1=周一 … 7=周日 */
  days: number[];
  from: string;
  to: string;
}

/** 免打扰设置 */
export interface DndSettingsView {
  enabled: boolean;
  windows: DndWindowView[];
}

/** LLM 非敏感设置 */
export interface LlmSettingsView {
  enabled: boolean;
  provider: "openai" | "deepseek" | "kimi" | "glm" | "custom";
  baseUrl: string;
  model: string;
  timeoutMs: number;
  maxOutboundClass: "L0" | "L1" | "L2";
  dailyCallLimit: number;
}

/** LLM 设置页视图；不含 API Key */
export interface LlmView extends LlmSettingsView {
  hasApiKey: boolean;
  keychainError: string | null;
  callsToday: number;
  remainingCalls: number;
}

/** 外发审计视图（不含原文） */
export interface LlmAuditEntry {
  id: string;
  at: number;
  actor: string;
  purpose: string;
  destination: string;
  dataClass: string;
  detectorSummary: Array<{ category: string; count: number }>;
  redactionCount: number;
  policyVersion: string;
  payloadSha256: string;
  outcome: "allowed" | "blocked" | "failed";
}

/** LLM 测试结果 */
export type LlmTestResult =
  | { ok: true; text: string; destination: string }
  | { ok: false; blocked: boolean; reason: string; errorKind?: string };

/** 本地日历设置 */
export interface CalendarSettings {
  icsPath?: string;
  remindersEnabled: boolean;
  reminderMinutes: number;
}

/** 天气设置 */
export interface WeatherSettings {
  enabled: boolean;
  latitude?: number;
  longitude?: number;
  locationName?: string;
}

/** 重要邮件监测设置 */
export interface EmailMonitorSettings {
  enabled: boolean;
  host?: string;
  port: number;
  secure: boolean;
  user?: string;
  mailbox: string;
  pollIntervalS: number;
  useLlm: boolean;
  senders: string[];
  keywords: string[];
  hasPassword?: boolean;
}

/** 通知渠道设置 */
export interface NotifySettings {
  channels: Array<"os_notification" | "cli_fallback" | "webhook" | "telegram" | "bark" | "tts" | "email">;
  webhookEnabled: boolean;
  webhookUrl?: string;
  telegramEnabled?: boolean;
  telegramChatId?: string;
  telegramHasToken?: boolean;
  barkEnabled?: boolean;
  barkServerUrl?: string;
  barkHasToken?: boolean;
  ttsEnabled?: boolean;
  ttsVoice?: string;
  routingEnabled?: boolean;
  routingLow?: Array<"os_notification" | "webhook" | "telegram" | "bark" | "tts" | "email">;
  routingNormal?: Array<"os_notification" | "webhook" | "telegram" | "bark" | "tts" | "email">;
  routingHigh?: Array<"os_notification" | "webhook" | "telegram" | "bark" | "tts" | "email">;
  emailEnabled?: boolean;
  emailHost?: string;
  emailPort?: number;
  emailSecure?: boolean;
  emailFrom?: string;
  emailTo?: string;
  emailUser?: string;
  emailHasPassword?: boolean;
}

/** 每日简报设置 */
export interface BriefingSettings {
  enabled: boolean;
  time: string;
}

/** 知识库文档 */
export interface KnowledgeDocument {
  id: string;
  title: string;
  sourcePath: string;
  dataClass: "L0" | "L1" | "L2" | "L3";
  contentHash: string;
  chunkCount: number;
  updatedAt: number;
}

/** 知识库检索命中 */
export interface KnowledgeHit {
  chunkId: string;
  documentId: string;
  title: string;
  sourcePath: string;
  dataClass: "L0" | "L1" | "L2" | "L3";
  ordinal: number;
  text: string;
  startOffset: number;
  endOffset: number;
  score: number;
}

/** 知识库问答引用 */
export interface KnowledgeCitation {
  chunkId: string;
  title: string;
  sourcePath: string;
  ordinal: number;
  startOffset: number;
  endOffset: number;
}

/** 知识库问答结果 */
export type KnowledgeAnswerResult =
  | { ok: true; answer: string; citations: KnowledgeCitation[] }
  | {
      ok: false;
      reason: "no_evidence" | "sensitive" | "blocked" | "budget" | "llm_unavailable" | "invalid_answer";
      message: string;
    };

/** 系统健康视图（单位已由 daemon 转好） */
export interface SystemHealthView {
  at: number;
  mount: string;
  cpuCount: number;
  load1: number;
  load5: number;
  load15: number;
  memoryTotalGb: number;
  memoryFreeGb: number;
  memoryFreePercent: number;
  diskTotalGb: number;
  diskFreeGb: number;
  diskFreePercent: number;
  uptimeS: number;
}

/** Skill 导出结果：取消与成功可辨识 */
export type SkillExportResult = { canceled: true } | { canceled: false; path: string };

/** Skill 列表项（设置页展示） */
export interface SkillListEntry {
  file: string;
  valid: boolean;
  name: string | null;
  version: string | null;
  description: string | null;
  permissions: string[];
  triggerMonitor: string | null;
  error: string | null;
}

/** 监测器配置（设置页新增/删除用；与 config.monitors 一致） */
export type MonitorConfigView =
  | {
      id: string;
      kind: "files";
      enabled?: boolean;
      root: string;
      patterns: string[];
      ignore: string[];
      intervalS: number;
      stableMs: number;
      skills: string[];
    }
  | { id: string; kind: "system"; enabled?: boolean; intervalS: number; skills: string[] }
  | {
      id: string;
      kind: "web";
      enabled?: boolean;
      url: string;
      mode: "page" | "json" | "rss";
      selector?: string;
      jsonPath?: string;
      intervalS: number;
      skills: string[];
    };

/** 监测器状态（设置页展示） */
export interface MonitorStatusItem {
  id: string;
  kind: "files" | "system" | "web";
  intervalMs: number;
  skills: string[];
  lastScanAt: number | null;
  lastFacts: number;
  lastNotified: number;
  lastErrors: number;
  error: string | null;
  running: boolean;
}

/** 导出备份的结果：取消与成功用可辨识联合，避免 UI 把取消当失败 */
export type BackupExportResult =
  | { canceled: true }
  | { canceled: false; outDir: string; files: number; totalBytes: number };

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
  getTask(id: string): Promise<TaskEditItem>;
  updateTask(payload: UpdateTaskPayload): Promise<{ id: string }>;
  pauseTask(id: string): Promise<{ ok: boolean }>;
  resumeTask(id: string): Promise<{ ok: boolean }>;
  deleteTask(id: string): Promise<{ ok: boolean }>;
  /** 把某次提醒标记为完成（当前实例消失，不再补发） */
  completeOccurrence(occurrenceId: string): Promise<{ ok: boolean }>;
  /** 稍后提醒：minutes 分钟后创建一条新的提醒通知 */
  snoozeOccurrence(occurrenceId: string, minutes: number): Promise<{ id: string }>;

  listNotifications(limit?: number): Promise<NotificationsPage>;
  testNotify(): Promise<{ ok: boolean }>;

  pauseAll(): Promise<{ ok: boolean }>;
  resumeAll(): Promise<{ ok: boolean }>;

  checkUpdate(): Promise<UpdateInfo>;
  /** 读取天气设置 */
  getWeather(): Promise<WeatherSettings>;
  /** 保存天气设置 */
  setWeather(settings: WeatherSettings): Promise<WeatherSettings>;
  /** 读取重要邮件监测设置 */
  getEmailMonitor(): Promise<EmailMonitorSettings>;
  /** 保存重要邮件监测设置 */
  setEmailMonitor(settings: EmailMonitorSettings): Promise<EmailMonitorSettings>;
  /** 保存 IMAP 密码到钥匙串 */
  setEmailMonitorPassword(password: string): Promise<{ hasPassword: boolean }>;
  /** 清除 IMAP 密码 */
  clearEmailMonitorPassword(): Promise<{ hasPassword: boolean }>;
  /** 测试 IMAP 连接 */
  testEmailMonitor(): Promise<{ ok: boolean; detail: string }>;
  /** 读取本地日历设置 */
  getCalendar(): Promise<CalendarSettings>;
  /** 保存本地日历设置 */
  setCalendar(settings: CalendarSettings): Promise<CalendarSettings>;
  /** 选择本地 .ics 文件（取消返回 null） */
  pickCalendarFile(): Promise<string | null>;
  /** 读取通知渠道/Webhook 设置 */
  getNotify(): Promise<NotifySettings>;
  /** 保存通知渠道设置（重启 daemon 生效） */
  setNotify(settings: NotifySettings): Promise<NotifySettings>;
  /** 发送一次 Webhook 测试 */
  testWebhook(url: string): Promise<{ outcome: string; error?: string }>;
  /** 保存 Telegram Bot Token 到钥匙串 */
  setTelegramToken(token: string): Promise<{ hasToken: boolean }>;
  /** 清除 Telegram Token */
  clearTelegramToken(): Promise<{ hasToken: boolean }>;
  /** 发送一次 Telegram 测试消息 */
  testTelegram(): Promise<{ outcome: string; error?: string }>;
  /** 保存 Bark Device Key 到钥匙串 */
  setBarkToken(token: string): Promise<{ hasToken: boolean }>;
  /** 清除 Bark Device Key */
  clearBarkToken(): Promise<{ hasToken: boolean }>;
  /** 发送一次 Bark 测试推送 */
  testBark(): Promise<{ outcome: string; error?: string }>;
  /** 播放一次语音测试 */
  testTts(): Promise<{ outcome: string; error?: string }>;
  /** 保存 SMTP 密码到钥匙串 */
  setEmailPassword(password: string): Promise<{ hasPassword: boolean }>;
  /** 清除 SMTP 密码 */
  clearEmailPassword(): Promise<{ hasPassword: boolean }>;
  /** 发送一封测试邮件 */
  testEmail(): Promise<{ outcome: string; error?: string }>;
  /** 读取每日简报设置 */
  getBriefing(): Promise<BriefingSettings>;
  /** 保存每日简报设置 */
  setBriefing(settings: BriefingSettings): Promise<BriefingSettings>;
  /** 打开文件选择器并读取待入库文档（取消返回 null） */
  pickKnowledgeFile(): Promise<{ sourcePath: string; content: string } | null>;
  /** 导入/更新文档到本地知识库 */
  importKnowledge(
    sourcePath: string,
    content: string,
    dataClass: "L0" | "L1" | "L2" | "L3",
  ): Promise<{ document: KnowledgeDocument }>;
  /** 列出知识库文档 */
  listKnowledge(): Promise<{ documents: KnowledgeDocument[] }>;
  /** 检索本地知识库 */
  searchKnowledge(query: string): Promise<{ hits: KnowledgeHit[] }>;
  /** 基于检索片段 + 模型回答问题；无依据时拒答 */
  answerKnowledge(question: string): Promise<KnowledgeAnswerResult>;
  /** 删除文档 */
  removeKnowledge(id: string): Promise<{ ok: boolean }>;
  /** 用系统默认程序打开引用来源 */
  openKnowledgeSource(sourcePath: string): Promise<{ ok: boolean; error?: string }>;
  /** 读取 LLM 设置（API Key 只返回是否已配置） */
  getLlm(): Promise<LlmView>;
  /** 最近外发审计（无原文） */
  getLlmAudit(limit?: number): Promise<{ entries: LlmAuditEntry[] }>;
  /** 从服务商获取可用模型（GET /models） */
  discoverLlmModels(): Promise<{ models: string[] }>;
  /** 保存非敏感 LLM 设置 */
  setLlm(settings: LlmSettingsView): Promise<LlmView>;
  /** 写入 API Key 到系统钥匙串 */
  setLlmKey(apiKey: string): Promise<{ hasApiKey: boolean }>;
  /** 删除 API Key */
  clearLlmKey(): Promise<{ hasApiKey: boolean }>;
  /** 发起一次公开探针外发（真实网络请求） */
  testLlm(): Promise<LlmTestResult>;
  /** 读取系统健康指标（由 daemon 采集） */
  getSystemHealth(): Promise<{ health: SystemHealthView; errors: Array<{ path: string; message: string }> }>;
  /** 读取监测器运行状态 */
  getMonitorStatus(): Promise<{ monitors: MonitorStatusItem[] }>;
  /** 一键补齐 M2 验收场景（默认 Skills + 系统/下载监测器） */
  installAcceptancePreset(): Promise<{
    installedSkills: string[];
    addedMonitors: string[];
    skippedMonitors: string[];
    monitors: MonitorConfigView[];
  }>;
  /** 读取监测器配置 */
  getMonitorConfig(): Promise<{ monitors: MonitorConfigView[] }>;
  /** 新增监测器并热重载运行时 */
  addMonitor(config: MonitorConfigView): Promise<{ monitors: MonitorConfigView[] }>;
  /** 启用/停用监测器并热重载运行时 */
  toggleMonitor(id: string, enabled: boolean): Promise<{ monitors: MonitorConfigView[] }>;
  /** 删除监测器并热重载运行时 */
  removeMonitor(id: string): Promise<{ monitors: MonitorConfigView[] }>;
  /** 立即扫描一个监测器；found=false 表示 id 不在当前运行配置中 */
  scanMonitor(id: string): Promise<{ found: boolean; notified: number; errors: number }>;
  /** 列出数据目录中的 Skill 文件 */
  getSkills(): Promise<{ skills: SkillListEntry[] }>;
  /** 打开原生文件选择器并读取 YAML（返回 null 表示取消） */
  pickSkillFile(): Promise<{ filename: string; content: string } | null>;
  /** 导入/更新 Skill；失败由 daemon 返回明确错误 */
  importSkill(filename: string, content: string): Promise<{ skill: SkillListEntry }>;
  /** 删除 Skill 文件 */
  deleteSkill(filename: string): Promise<{ ok: boolean }>;
  /** 选择保存位置并导出 Skill YAML */
  exportSkill(filename: string): Promise<SkillExportResult>;
  /** 安装内置示例 Skills（只补缺失） */
  installDefaultSkills(): Promise<{ installed: string[]; skipped: string[] }>;
  /** 读取免打扰设置 */
  getDnd(): Promise<DndSettingsView>;
  /** 保存免打扰设置；daemon 会持久化到 config.json 并立即影响后续派发 */
  setDnd(settings: DndSettingsView): Promise<{ ok: boolean }>;
  /** 打开 macOS 系统通知设置（权限引导） */
  openNotificationSettings(): Promise<{ ok: boolean; detail: string }>;
  /** 选择目录并导出备份；路径由主进程对话框决定，renderer 不能传任意路径 */
  exportBackup(): Promise<BackupExportResult>;

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
  onAlert(cb: (payload: { title: string; body?: string; occurrenceId?: string }) => void): () => void;
  /** 订阅"⌘Q 已按下一次，再按一次完全退出"的提示 */
  onQuitArmed(cb: (seconds: number) => void): () => void;
}
