/**
 * preload —— renderer 与主进程之间的唯一通道
 *
 * ## 安全模型（这是本项目最容易被破坏的边界之一）
 *
 * ```
 * renderer（网页上下文，可能被 XSS 影响）
 *      │  只能看到这里暴露的白名单方法
 *      ▼
 * preload（隔离上下文，contextIsolation=true）
 *      │  ipcRenderer.invoke / on
 *      ▼
 * 主进程（持有 IPC token、文件系统、子进程能力）
 * ```
 *
 * **硬性要求：**
 *   - `nodeIntegration: false`（renderer 拿不到 require / process）
 *   - `contextIsolation: true`（preload 与页面脚本运行在独立上下文）
 *   - `sandbox: true`（preload 也受限，不能读文件）
 *   - **不暴露 `ipcRenderer` 本身**，只暴露具名方法
 *
 * 最后一条最关键：若把 `ipcRenderer` 整个丢给页面，页面就能调用任意通道，
 * 等于把主进程的全部能力交给了一个可能被注入的上下文。
 */

import { contextBridge, ipcRenderer } from "electron";
import type {
  BackupExportResult,
  BriefingSettings,
  CreateTaskPayload,
  DesktopApi,
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
  NotificationsPage,
  OnboardingState,
  SkillExportResult,
  SkillListEntry,
  SystemHealthView,
  TaskEditItem,
  TasksPage,
  UpdateInfo,
  UpdateTaskPayload,
} from "./api-types.js";

/**
 * 构造暴露给页面的 API。
 *
 * 所有方法都是"具名 + 参数受限"的，没有通用的 `invoke(channel, args)`
 * —— 后者会绕过白名单。
 */
function buildApi(): DesktopApi {
  return {
    // ── 状态 ──────────────────────────────────────────────────────────
    getStatus: () => ipcRenderer.invoke("aegis:status") as Promise<DiagnosticInfo>,

    // ── 任务 ──────────────────────────────────────────────────────────
    listTasks: () => ipcRenderer.invoke("aegis:tasks:list") as Promise<TasksPage>,
    createTask: (payload: CreateTaskPayload) =>
      ipcRenderer.invoke("aegis:tasks:create", payload) as Promise<{ id: string }>,
    getTask: (id: string) => ipcRenderer.invoke("aegis:tasks:get", id) as Promise<TaskEditItem>,
    updateTask: (payload: UpdateTaskPayload) =>
      ipcRenderer.invoke("aegis:tasks:update", payload) as Promise<{ id: string }>,
    pauseTask: (id: string) => ipcRenderer.invoke("aegis:tasks:pause", id) as Promise<{ ok: boolean }>,
    resumeTask: (id: string) => ipcRenderer.invoke("aegis:tasks:resume", id) as Promise<{ ok: boolean }>,
    deleteTask: (id: string) => ipcRenderer.invoke("aegis:tasks:delete", id) as Promise<{ ok: boolean }>,
    completeOccurrence: (occurrenceId: string) =>
      ipcRenderer.invoke("aegis:occurrences:complete", occurrenceId) as Promise<{ ok: boolean }>,
    snoozeOccurrence: (occurrenceId: string, minutes: number) =>
      ipcRenderer.invoke("aegis:occurrences:snooze", { occurrenceId, minutes }) as Promise<{
        id: string;
      }>,

    // ── 通知 ──────────────────────────────────────────────────────────
    listNotifications: (limit?: number) =>
      ipcRenderer.invoke("aegis:notifications:list", limit) as Promise<NotificationsPage>,
    testNotify: () => ipcRenderer.invoke("aegis:notifications:test") as Promise<{ ok: boolean }>,

    exportBackup: () => ipcRenderer.invoke("aegis:backup:export") as Promise<BackupExportResult>,

    getBriefing: () => ipcRenderer.invoke("aegis:briefing:get") as Promise<BriefingSettings>,
    setBriefing: (settings: BriefingSettings) =>
      ipcRenderer.invoke("aegis:briefing:set", settings) as Promise<BriefingSettings>,
    pickKnowledgeFile: () =>
      ipcRenderer.invoke("aegis:knowledge:pick") as Promise<{
        sourcePath: string;
        content: string;
      } | null>,
    importKnowledge: (sourcePath: string, content: string, dataClass: "L0" | "L1" | "L2" | "L3") =>
      ipcRenderer.invoke("aegis:knowledge:import", { sourcePath, content, dataClass }) as Promise<{
        document: KnowledgeDocument;
      }>,
    listKnowledge: () =>
      ipcRenderer.invoke("aegis:knowledge:list") as Promise<{ documents: KnowledgeDocument[] }>,
    searchKnowledge: (query: string) =>
      ipcRenderer.invoke("aegis:knowledge:search", { query, limit: 10 }) as Promise<{
        hits: KnowledgeHit[];
      }>,
    answerKnowledge: (question: string) =>
      ipcRenderer.invoke("aegis:knowledge:answer", { question }) as Promise<KnowledgeAnswerResult>,
    removeKnowledge: (id: string) =>
      ipcRenderer.invoke("aegis:knowledge:remove", { id }) as Promise<{ ok: boolean }>,
    openKnowledgeSource: (sourcePath: string) =>
      ipcRenderer.invoke("aegis:knowledge:open", { sourcePath }) as Promise<{
        ok: boolean;
        error?: string;
      }>,
    getLlm: () => ipcRenderer.invoke("aegis:llm:get") as Promise<LlmView>,
    discoverLlmModels: () => ipcRenderer.invoke("aegis:llm:models") as Promise<{ models: string[] }>,
    getLlmAudit: (limit = 20) =>
      ipcRenderer.invoke("aegis:llm:audit", { limit }) as Promise<{ entries: LlmAuditEntry[] }>,
    setLlm: (settings: LlmSettingsView) => ipcRenderer.invoke("aegis:llm:set", settings) as Promise<LlmView>,
    setLlmKey: (apiKey: string) =>
      ipcRenderer.invoke("aegis:llm:set-key", { apiKey }) as Promise<{ hasApiKey: boolean }>,
    clearLlmKey: () => ipcRenderer.invoke("aegis:llm:clear-key") as Promise<{ hasApiKey: boolean }>,
    testLlm: () => ipcRenderer.invoke("aegis:llm:test") as Promise<LlmTestResult>,
    getSystemHealth: () =>
      ipcRenderer.invoke("aegis:system:health") as Promise<{
        health: SystemHealthView;
        errors: Array<{ path: string; message: string }>;
      }>,
    getMonitorStatus: () =>
      ipcRenderer.invoke("aegis:monitor:status") as Promise<{ monitors: MonitorStatusItem[] }>,
    scanMonitor: (id: string) =>
      ipcRenderer.invoke("aegis:monitor:scan", { id }) as Promise<{
        found: boolean;
        notified: number;
        errors: number;
      }>,
    installAcceptancePreset: () =>
      ipcRenderer.invoke("aegis:monitor:preset") as Promise<{
        installedSkills: string[];
        addedMonitors: string[];
        skippedMonitors: string[];
        monitors: MonitorConfigView[];
      }>,
    getMonitorConfig: () =>
      ipcRenderer.invoke("aegis:monitor:config") as Promise<{ monitors: MonitorConfigView[] }>,
    addMonitor: (config: MonitorConfigView) =>
      ipcRenderer.invoke("aegis:monitor:add", config) as Promise<{ monitors: MonitorConfigView[] }>,
    toggleMonitor: (id: string, enabled: boolean) =>
      ipcRenderer.invoke("aegis:monitor:toggle", { id, enabled }) as Promise<{
        monitors: MonitorConfigView[];
      }>,
    removeMonitor: (id: string) =>
      ipcRenderer.invoke("aegis:monitor:remove", { id }) as Promise<{ monitors: MonitorConfigView[] }>,
    getSkills: () => ipcRenderer.invoke("aegis:skill:list") as Promise<{ skills: SkillListEntry[] }>,
    pickSkillFile: () =>
      ipcRenderer.invoke("aegis:skill:pick") as Promise<{ filename: string; content: string } | null>,
    importSkill: (filename: string, content: string) =>
      ipcRenderer.invoke("aegis:skill:import", { filename, content }) as Promise<{ skill: SkillListEntry }>,
    deleteSkill: (filename: string) =>
      ipcRenderer.invoke("aegis:skill:delete", { filename }) as Promise<{ ok: boolean }>,
    exportSkill: (filename: string) =>
      ipcRenderer.invoke("aegis:skill:export", { filename }) as Promise<SkillExportResult>,
    installDefaultSkills: () =>
      ipcRenderer.invoke("aegis:skill:install-defaults") as Promise<{
        installed: string[];
        skipped: string[];
      }>,
    getDnd: () => ipcRenderer.invoke("aegis:dnd:get") as Promise<DndSettingsView>,
    setDnd: (settings: DndSettingsView) =>
      ipcRenderer.invoke("aegis:dnd:set", settings) as Promise<{ ok: boolean }>,
    openNotificationSettings: () =>
      ipcRenderer.invoke("aegis:notifications:open-settings") as Promise<{
        ok: boolean;
        detail: string;
      }>,

    // ── 全局控制 ──────────────────────────────────────────────────────
    pauseAll: () => ipcRenderer.invoke("aegis:ctrl:pauseAll") as Promise<{ ok: boolean }>,
    resumeAll: () => ipcRenderer.invoke("aegis:ctrl:resumeAll") as Promise<{ ok: boolean }>,

    // ── 更新（R3 只做"检查"，不做自动下载）─────────────────────────────
    checkUpdate: () => ipcRenderer.invoke("aegis:update:check") as Promise<UpdateInfo>,

    // ── 首次启动向导 ──────────────────────────────────────────────────
    getOnboarding: () => ipcRenderer.invoke("aegis:onboarding:get") as Promise<OnboardingState>,
    completeOnboarding: (choices: { autostart: boolean }) =>
      ipcRenderer.invoke("aegis:onboarding:complete", choices) as Promise<{
        ok: boolean;
        detail: string;
      }>,
    setAutostart: (enabled: boolean) =>
      ipcRenderer.invoke("aegis:autostart:set", enabled) as Promise<{ ok: boolean; detail: string }>,

    // ── 事件订阅 ──────────────────────────────────────────────────────
    onDaemonState: (cb: (state: string) => void) => {
      // 注意：包装一层再调用回调，避免把 ipcRenderer 的事件对象（含 sender）泄漏给页面
      const listener = (_e: unknown, state: string): void => cb(state);
      ipcRenderer.on("aegis:daemon-state", listener);
      return () => ipcRenderer.removeListener("aegis:daemon-state", listener);
    },

    onRefresh: (cb: () => void) => {
      const listener = (): void => cb();
      ipcRenderer.on("aegis:refresh", listener);
      return () => ipcRenderer.removeListener("aegis:refresh", listener);
    },

    onAlert: (cb: (payload: { title: string; body?: string; occurrenceId?: string }) => void) => {
      const listener = (
        _e: unknown,
        payload: { title: string; body?: string; occurrenceId?: string },
      ): void => cb(payload);
      ipcRenderer.on("aegis:alert", listener);
      return () => ipcRenderer.removeListener("aegis:alert", listener);
    },

    onQuitArmed: (cb: (seconds: number) => void) => {
      const listener = (_e: unknown, payload: { seconds?: number }): void =>
        cb(typeof payload?.seconds === "number" ? payload.seconds : 3);
      ipcRenderer.on("aegis:quit-armed", listener);
      return () => ipcRenderer.removeListener("aegis:quit-armed", listener);
    },
  };
}

contextBridge.exposeInMainWorld("aegis", buildApi());
