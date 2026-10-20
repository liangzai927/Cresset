/**
 * Aegis 界面逻辑（renderer）
 *
 * ## 这一层能做什么、不能做什么
 *
 * 只能调用 `window.aegis` 上的白名单方法（见 preload.ts）。
 * **不能**访问文件系统、子进程、daemon token —— 这些都在主进程里。
 *
 * ## 设计取舍：为什么不用框架
 *
 * 界面只有三个面板 + 一个对话框，数据量在百条量级。
 * 引 React/Vue 会带来：构建链（jsx/swc）、依赖升级、状态管理样板，
 * 而换来的收益（组件复用、响应式）在这个规模上并不明显。
 *
 * 用原生 DOM 的代价是手写渲染函数，但好处是：
 *   - 零构建步骤（`loadFile` 直接跑）
 *   - 出问题时浏览器 DevTools 里看到的就是源码，没有 sourcemap 断层
 *   - 没有"框架版本升级导致界面坏掉"这一类风险
 *
 * 若将来界面复杂到需要状态管理，再引入框架 —— 那时重构也只涉及本文件。
 */

"use strict";

// ── 小工具 ──────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

/** 把 UTC 毫秒格式化为本地 `MM-DD HH:mm`（历史列表用） */
function fmtDateTime(ms) {
  const d = new Date(ms);
  const p2 = (n) => String(n).padStart(2, "0");
  return `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

/** 墙上时间 `YYYY-MM-DDTHH:mm` → `MM-DD HH:mm`（任务列表用） */
function fmtWall(wall) {
  if (!wall) return "已结束";
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(wall);
  if (!m) return wall;
  return `${m[2]}-${m[3]} ${m[4]}:${m[5]}`;
}

/** 渠道名的人话映射 */
const CHANNEL_LABEL = {
  os_notification: "系统通知",
  cli_fallback: "命令行兜底",
};

/** 投递结果的人话映射 */
const OUTCOME_LABEL = {
  success: "成功",
  transient_error: "瞬时错误",
  permanent_error: "不可用",
  timeout: "超时",
};

/** 通知状态的人话映射 */
const STATE_LABEL = {
  pending: "待投递",
  delivering: "投递中",
  delivered: "已送达",
  failed: "失败",
  suppressed: "已抑制",
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

// ── 状态 ────────────────────────────────────────────────────────────────

const state = {
  tab: "tasks",
  /** 上次状态查询结果（避免重复请求） */
  status: null,
  /** 新建对话框里选中的星期 */
  selectedWeekdays: new Set([1]),
  /** 横幅是否被用户手动关掉 */
  bannerDismissed: false,
};

// ── 横幅 ────────────────────────────────────────────────────────────────

/**
 * 显示横幅。
 *
 * 语义：这是"必须让用户知道"的信息（降级、失败、daemon 不可用）。
 * 因此它**不是** toast —— 不会自动消失，必须用户手动关闭或状态恢复。
 */
function showBanner(text, level) {
  if (state.bannerDismissed) return;
  const banner = $("banner");
  $("banner-text").textContent = text;
  banner.classList.toggle("warn", level === "warn");
  banner.classList.remove("hidden");
}

function hideBanner() {
  $("banner").classList.add("hidden");
}

$("banner-close").addEventListener("click", () => {
  state.bannerDismissed = true;
  hideBanner();
});

// ── 状态刷新 ────────────────────────────────────────────────────────────

async function refreshStatus() {
  let status;
  try {
    status = await window.aegis.getStatus();
  } catch (err) {
    setStatusIndicator("err", "主进程通信失败");
    showBanner(`无法与后台通信：${err.message}`, "err");
    return;
  }
  state.status = status;

  // ── 顶部状态灯与文案
  const dot = $("status-dot");
  dot.className = "dot";

  // 未就绪时禁用所有需要后端的按钮 —— 让用户"点不动"比"点了报错"清楚得多。
  // 这也是对"daemon 尚未就绪"那次事故的直接改进：
  // 当时向导第 2 步邀请用户点"发送测试通知"，但后端可能还在启动。
  const ready = status.daemonReady === true;
  for (const id of [
    "btn-test-notify",
    "btn-new",
    "btn-pause-all",
    "btn-resume-all",
    "btn-refresh-history",
    "btn-refresh-health",
    "btn-refresh-monitors",
    "btn-add-monitor",
    "btn-save-llm",
    "btn-set-llm-key",
    "btn-clear-llm-key",
    "btn-test-llm",
    "btn-refresh-llm-audit",
    "btn-import-knowledge",
    "btn-refresh-knowledge",
    "btn-search-knowledge",
    "btn-ask-knowledge",
    "btn-save-briefing",
    "btn-save-email-monitor",
    "btn-set-email-monitor-password",
    "btn-test-email-monitor",
    "btn-pick-calendar",
    "btn-clear-calendar",
    "btn-save-calendar-reminders",
    "btn-save-weather",
    "btn-save-webhook",
    "btn-test-webhook",
    "btn-set-telegram-token",
    "btn-test-telegram",
    "btn-set-bark-token",
    "btn-test-bark",
    "btn-test-tts",
    "btn-set-email-password",
    "btn-test-email",
    "routing-enabled",
    "btn-monitor-preset",
    "btn-import-skill",
    "btn-install-defaults",
    "btn-refresh-skills",
    "btn-export-backup",
    "btn-dnd-add",
    "btn-dnd-save",
    "wizard-test-notify",
  ]) {
    const el2 = $(id);
    if (el2) el2.disabled = !ready;
  }

  if (status.daemonState === "running") {
    const uptime = formatUptime(status.health ? status.health.uptimeS : 0);
    const nativeOk = status.channels.some((c) => c.channel === "os_notification" && c.ok);
    if (nativeOk) {
      dot.classList.add("ok");
      $("status-text").textContent = `运行中 · ${uptime}`;
    } else {
      // 原生不可用但 CLI 兜底在 → 降级，不是失败
      dot.classList.add("warn");
      $("status-text").textContent = `运行中（兜底模式）· ${uptime}`;
      showBanner("系统通知通道不可用，正在使用命令行兜底。提醒仍会送达，但样式较简单。", "warn");
    }
  } else if (status.daemonState === "starting") {
    dot.classList.add("warn");
    $("status-text").textContent = "后台服务启动中…";
  } else if (status.daemonState === "crashed") {
    dot.classList.add("err");
    $("status-text").textContent = "后台服务已崩溃";
    showBanner(`后台服务异常：${status.daemonReason ?? "未知原因"}。正在尝试自动重启。`, "err");
  } else if (status.daemonState === "unavailable") {
    dot.classList.add("err");
    $("status-text").textContent = "后台服务不可用";
    showBanner(
      `后台服务无法启动：${status.daemonReason ?? "未知原因"}。提醒不会触发，请检查设置页的诊断信息。`,
      "err",
    );
  } else {
    $("status-text").textContent = "后台服务未运行";
    showBanner("后台服务未运行，提醒不会触发。", "err");
  }

  // ── daemon 在线但报告降级原因 → 也要可见
  if (status.health && status.health.degradedReasons.length > 0) {
    showBanner(`后台服务降级中：${status.health.degradedReasons.join("；")}`, "warn");
  }

  // ── 状态恢复了 → 自动隐藏横幅（用户手动关过则不再打扰）
  if (
    status.daemonState === "running" &&
    (!status.health || status.health.degradedReasons.length === 0) &&
    status.channels.some((c) => c.channel === "os_notification" && c.ok)
  ) {
    hideBanner();
    state.bannerDismissed = false;
  }

  renderSettings(status);
  if (status.daemonReady === true && !dndState.loaded) void loadDnd();
}

function setStatusIndicator(level, text) {
  $("status-dot").className = `dot ${level}`;
  $("status-text").textContent = text;
}

/** 人类可读体积（备份摘要） */
function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "未知大小";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatUptime(seconds) {
  if (seconds < 60) return `${seconds} 秒`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} 分钟`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)} 小时`;
  return `${(seconds / 86400).toFixed(1)} 天`;
}

// ── 提醒列表 ────────────────────────────────────────────────────────────

async function refreshTasks() {
  let page;
  try {
    page = await window.aegis.listTasks();
  } catch (err) {
    showBanner(`读取提醒失败：${err.message}`, "err");
    return;
  }

  const list = $("task-list");
  list.textContent = "";

  if (page.items.length === 0) {
    $("tasks-empty").classList.remove("hidden");
    return;
  }
  $("tasks-empty").classList.add("hidden");

  for (const task of page.items) {
    list.appendChild(renderTaskItem(task));
  }
}

function renderTaskItem(task) {
  const li = el("li", `task-item${task.enabled ? "" : " disabled"}`);

  const main = el("div", "task-main");
  const titleRow = el("div", "task-title");
  titleRow.appendChild(el("span", "", task.title));
  if (task.priority === "important") {
    titleRow.appendChild(el("span", "badge", "重要"));
  }
  main.appendChild(titleRow);

  const meta = el("div", "task-meta");
  meta.appendChild(el("span", "", task.repeatLabel));
  meta.appendChild(el("span", "", `下次 ${fmtWall(task.nextFireWall)}`));
  if (task.firedCount > 0) {
    meta.appendChild(el("span", "", `已触发 ${task.firedCount} 次`));
  }
  if (!task.enabled) {
    meta.appendChild(el("span", "", "已暂停"));
  }
  main.appendChild(meta);

  if (task.notes) {
    main.appendChild(el("div", "history-body", task.notes));
  }

  const actions = el("div", "task-actions");

  const edit = el("button", "btn btn-ghost", "编辑");
  edit.addEventListener("click", () => void openEditDialog(task.id));
  actions.appendChild(edit);

  const toggle = el("button", "btn btn-ghost", task.enabled ? "暂停" : "恢复");
  toggle.addEventListener("click", async () => {
    toggle.disabled = true;
    try {
      if (task.enabled) await window.aegis.pauseTask(task.id);
      else await window.aegis.resumeTask(task.id);
      await refreshTasks();
      await refreshStatus();
    } catch (err) {
      showBanner(`操作失败：${err.message}`, "err");
    } finally {
      toggle.disabled = false;
    }
  });
  actions.appendChild(toggle);

  const del = el("button", "btn btn-ghost btn-danger", "删除");
  del.addEventListener("click", async () => {
    // 删除是不可逆的 —— 用系统确认框而不是自己画一个
    if (!window.confirm(`删除提醒「${task.title}」？`)) return;
    del.disabled = true;
    try {
      await window.aegis.deleteTask(task.id);
      await refreshTasks();
    } catch (err) {
      showBanner(`删除失败：${err.message}`, "err");
      del.disabled = false;
    }
  });
  actions.appendChild(del);

  li.appendChild(main);
  li.appendChild(actions);
  return li;
}

// ── 历史 ────────────────────────────────────────────────────────────────

async function refreshHistory() {
  let page;
  try {
    page = await window.aegis.listNotifications(100);
  } catch (err) {
    showBanner(`读取历史失败：${err.message}`, "err");
    return;
  }

  const list = $("history-list");
  list.textContent = "";

  if (page.items.length === 0) {
    $("history-empty").classList.remove("hidden");
    return;
  }
  $("history-empty").classList.add("hidden");

  for (const n of page.items) {
    const li = el(
      "li",
      `history-item${n.state === "failed" ? " failed" : n.state === "pending" ? " pending" : ""}`,
    );

    const head = el("div", "history-head");
    head.appendChild(el("span", "history-time", fmtDateTime(n.scheduledFor)));
    head.appendChild(el("span", "history-title", n.title));
    if (n.isCatchup) {
      head.appendChild(el("span", "chan-chip", "补偿"));
    }
    head.appendChild(el("span", "chan-chip", STATE_LABEL[n.state] ?? n.state));
    li.appendChild(head);

    if (n.body) {
      li.appendChild(el("div", "history-body", n.body));
    }

    if (n.attempts.length > 0) {
      const chans = el("div", "history-channels");
      for (const a of n.attempts) {
        const ok = a.outcome === "success";
        const chip = el(
          "span",
          `chan-chip ${ok ? "ok" : "bad"}`,
          `${CHANNEL_LABEL[a.channel] ?? a.channel} · ${OUTCOME_LABEL[a.outcome] ?? a.outcome}`,
        );
        if (a.error) chip.title = a.error;
        chans.appendChild(chip);
      }
      li.appendChild(chans);
    }

    list.appendChild(li);
  }
}

// ── 设置 / 诊断 ─────────────────────────────────────────────────────────

// ── 免打扰设置 ──────────────────────────────────────────────────────────

/** ISO 星期标签：1=周一 … 7=周日 */
const DND_DAYS = [
  [1, "一"],
  [2, "二"],
  [3, "三"],
  [4, "四"],
  [5, "五"],
  [6, "六"],
  [7, "日"],
];

const dndState = {
  loaded: false,
  loading: false,
  enabled: false,
  windows: [],
};

/** 从 daemon 读取 DND；失败时保留旧值并提示，由下一次状态刷新重试 */
async function loadDnd() {
  if (dndState.loading) return;
  dndState.loading = true;
  try {
    const d = await window.aegis.getDnd();
    dndState.enabled = d.enabled;
    dndState.windows = d.windows.map((w) => ({ days: [...w.days], from: w.from, to: w.to }));
    dndState.loaded = true;
    $("dnd-hint").textContent = "";
    renderDnd();
  } catch (err) {
    $("dnd-hint").textContent = `读取免打扰设置失败：${err.message}`;
  } finally {
    dndState.loading = false;
  }
}

/** 渲染时段行；输入事件直接改 dndState，避免每敲一次就重建 DOM */
function renderDnd() {
  $("dnd-enabled").checked = dndState.enabled;
  const box = $("dnd-windows");
  box.textContent = "";

  if (dndState.windows.length === 0) {
    box.appendChild(el("p", "hint", "还没有时段；启用免打扰也不会生效。"));
    return;
  }

  for (const [index, window] of dndState.windows.entries()) {
    const row = el("div", "dnd-row");

    const days = el("div", "dnd-days");
    for (const [day, label] of DND_DAYS) {
      const btn = el("button", "dnd-day", label);
      btn.type = "button";
      btn.setAttribute("aria-label", `周${label}`);
      btn.setAttribute("aria-pressed", String(window.days.includes(day)));
      if (window.days.includes(day)) btn.classList.add("active");
      btn.addEventListener("click", () => {
        if (window.days.includes(day)) {
          window.days = window.days.filter((d) => d !== day);
        } else {
          window.days = [...window.days, day].sort((a, b) => a - b);
        }
        btn.classList.toggle("active", window.days.includes(day));
        btn.setAttribute("aria-pressed", String(window.days.includes(day)));
      });
      days.appendChild(btn);
    }
    row.appendChild(days);

    const from = document.createElement("input");
    from.type = "time";
    from.className = "dnd-time";
    from.value = window.from;
    from.setAttribute("aria-label", "免打扰开始时间");
    from.addEventListener("change", () => {
      window.from = from.value;
    });
    row.appendChild(from);

    row.appendChild(el("span", "hint", "到"));
    const to = document.createElement("input");
    to.type = "time";
    to.className = "dnd-time";
    to.value = window.to;
    to.setAttribute("aria-label", "免打扰结束时间");
    to.addEventListener("change", () => {
      window.to = to.value;
    });
    row.appendChild(to);

    const remove = el("button", "btn btn-ghost", "删除");
    remove.type = "button";
    remove.addEventListener("click", () => {
      dndState.windows.splice(index, 1);
      renderDnd();
    });
    row.appendChild(remove);

    box.appendChild(row);
  }
}

/** 添加一个默认 22:00–08:00 的全周时段 */
function addDndWindow() {
  if (dndState.windows.length >= 10) {
    $("dnd-hint").textContent = "最多 10 个免打扰时段";
    return;
  }
  dndState.windows.push({ days: [1, 2, 3, 4, 5, 6, 7], from: "22:00", to: "08:00" });
  renderDnd();
}

/** 保存免打扰；daemon 写 config.json 并立即替换 scheduler 的 DND */
async function saveDnd(btn) {
  const windows = dndState.windows.map((w) => ({
    days: [...w.days].sort((a, b) => a - b),
    from: w.from,
    to: w.to,
  }));
  for (const w of windows) {
    if (w.days.length === 0) {
      $("dnd-hint").textContent = "每个时段至少选择一天";
      return;
    }
    if (!/^\d{2}:\d{2}$/.test(w.from) || !/^\d{2}:\d{2}$/.test(w.to)) {
      $("dnd-hint").textContent = "时间格式应为 HH:MM";
      return;
    }
  }

  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = "保存中…";
  try {
    await window.aegis.setDnd({ enabled: $("dnd-enabled").checked, windows });
    dndState.enabled = $("dnd-enabled").checked;
    dndState.windows = windows.map((w) => ({ ...w, days: [...w.days] }));
    $("dnd-hint").textContent = "已保存；对之后到点的提醒生效";
    showToast("免打扰设置已保存");
  } catch (err) {
    $("dnd-hint").textContent = `保存失败：${err.message}`;
    showBanner(`保存免打扰失败：${err.message}`, "err");
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

$("btn-dnd-add").addEventListener("click", addDndWindow);
$("btn-dnd-save").addEventListener("click", (e) => void saveDnd(e.currentTarget));

// ── 系统健康 ────────────────────────────────────────────────────────────

let healthTimer = null;
let healthInFlight = false;

/** 渲染系统健康指标；顶栏只放最短摘要，设置页展示完整值 */
function renderSystemHealth(health) {
  const load = `${health.load1.toFixed(2)} / ${health.load5.toFixed(2)} / ${health.load15.toFixed(2)}`;
  const memory = `${health.memoryFreePercent}% 可用 · ${health.memoryFreeGb} / ${health.memoryTotalGb} GB`;
  const disk = `${health.diskFreePercent}% 可用 · ${health.diskFreeGb} / ${health.diskTotalGb} GB`;

  const chip = $("health-chip");
  chip.textContent = `CPU ${health.load1.toFixed(1)} · 内存 ${health.memoryFreePercent}%`;
  chip.title = `CPU：${health.cpuCount} 核 · load ${load}\n内存：${memory}\n磁盘：${disk}\n运行：${formatUptime(health.uptimeS)}`;
  chip.classList.remove("hidden");

  const box = $("system-health");
  box.textContent = "";
  const add = (k, v) => {
    box.appendChild(el("dt", "", k));
    box.appendChild(el("dd", "", v));
  };
  add("CPU", `${health.cpuCount} 核 · load ${load}`);
  add("内存", memory);
  add("磁盘", disk);
  add("运行", formatUptime(health.uptimeS));
  add("采集", new Date(health.at).toLocaleTimeString("zh-CN"));
}

/**
 * 拉取一次系统健康。
 *
 * 定时轮询用 silent=true：不闪"采集中…"，失败时只在设置卡片/顶栏保留旧值；
 * 手动刷新用 silent=false，给出明确反馈。
 */
async function refreshSystemHealth({ silent = false } = {}) {
  if (healthInFlight) return;
  healthInFlight = true;
  if (!silent) $("system-health-hint").textContent = "采集中…";
  try {
    const result = await window.aegis.getSystemHealth();
    renderSystemHealth(result.health);
    $("system-health-hint").textContent =
      result.errors.length > 0
        ? `部分采集失败：${result.errors.map((e) => e.message).join("；")}`
        : "每 5 秒自动刷新";
  } catch (err) {
    if (!silent) $("system-health-hint").textContent = `读取失败：${err.message}`;
  } finally {
    healthInFlight = false;
  }
}

/** 启动全局轮询：顶栏小指标在所有页签都可见 */
function startHealthPolling() {
  if (healthTimer) return;
  void refreshSystemHealth({ silent: true });
  healthTimer = setInterval(() => void refreshSystemHealth({ silent: true }), 5_000);
}

$("btn-refresh-health").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  try {
    await refreshSystemHealth();
  } finally {
    btn.disabled = false;
  }
});

// ── 重要邮件监测（IMAP） ───────────────────────────────────────────────

/** 读取 IMAP 监测设置；密码只显示是否已配置 */
async function loadEmailMonitor() {
  try {
    const v = await window.aegis.getEmailMonitor();
    $("email-monitor-enabled").checked = v.enabled;
    $("email-monitor-host").value = v.host ?? "";
    $("email-monitor-port").value = String(v.port);
    $("email-monitor-secure").checked = v.secure;
    $("email-monitor-user").value = v.user ?? "";
    $("email-monitor-mailbox").value = v.mailbox;
    $("email-monitor-interval").value = String(v.pollIntervalS);
    $("email-monitor-use-llm").checked = v.useLlm;
    $("email-monitor-senders").value = v.senders.join(", ");
    $("email-monitor-keywords").value = v.keywords.join(", ");
    $("email-monitor-hint").textContent = v.hasPassword ? "已配置 IMAP 密码" : "未配置 IMAP 密码";
  } catch (err) {
    $("email-monitor-hint").textContent = `读取失败：${err.message}`;
  }
}

/** 逗号分隔 → 去空数组 */
function splitList(value) {
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}

$("btn-save-email-monitor").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  try {
    await window.aegis.setEmailMonitor({
      enabled: $("email-monitor-enabled").checked,
      ...($("email-monitor-host").value.trim() ? { host: $("email-monitor-host").value.trim() } : {}),
      port: Number($("email-monitor-port").value),
      secure: $("email-monitor-secure").checked,
      ...($("email-monitor-user").value.trim() ? { user: $("email-monitor-user").value.trim() } : {}),
      mailbox: $("email-monitor-mailbox").value.trim() || "INBOX",
      pollIntervalS: Number($("email-monitor-interval").value),
      useLlm: $("email-monitor-use-llm").checked,
      senders: splitList($("email-monitor-senders").value),
      keywords: splitList($("email-monitor-keywords").value),
    });
    $("email-monitor-hint").textContent = "已保存；下一轮轮询生效";
  } catch (err) {
    $("email-monitor-hint").textContent = `保存失败：${err.message}`;
  } finally {
    btn.disabled = false;
  }
});

$("btn-set-email-monitor-password").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  const input = $("email-monitor-password");
  const password = input.value.trim();
  if (!password) {
    $("email-monitor-hint").textContent = "IMAP 密码不能为空";
    return;
  }
  btn.disabled = true;
  try {
    await window.aegis.setEmailMonitorPassword(password);
    input.value = "";
    $("email-monitor-hint").textContent = "IMAP 密码已写入钥匙串";
  } catch (err) {
    $("email-monitor-hint").textContent = `保存失败：${err.message}`;
  } finally {
    btn.disabled = false;
  }
});

$("btn-test-email-monitor").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  $("email-monitor-hint").textContent = "连接中…";
  try {
    const r = await window.aegis.testEmailMonitor();
    $("email-monitor-hint").textContent = r.detail;
  } catch (err) {
    $("email-monitor-hint").textContent = `测试失败：${err.message}`;
  } finally {
    btn.disabled = false;
  }
});

// ── 天气 ──────────────────────────────────────────────────────────────

/** 预设地区；用户只选名字，经纬度由这里提供 */
const WEATHER_CITIES = [
  { name: "北京", latitude: 39.9042, longitude: 116.4074 },
  { name: "上海", latitude: 31.2304, longitude: 121.4737 },
  { name: "广州", latitude: 23.1291, longitude: 113.2644 },
  { name: "深圳", latitude: 22.5431, longitude: 114.0579 },
  { name: "杭州", latitude: 30.2741, longitude: 120.1551 },
  { name: "南京", latitude: 32.0603, longitude: 118.7969 },
  { name: "苏州", latitude: 31.2989, longitude: 120.5853 },
  { name: "成都", latitude: 30.5728, longitude: 104.0668 },
  { name: "重庆", latitude: 29.563, longitude: 106.5516 },
  { name: "武汉", latitude: 30.5928, longitude: 114.3055 },
  { name: "西安", latitude: 34.3416, longitude: 108.9398 },
  { name: "长沙", latitude: 28.2282, longitude: 112.9388 },
  { name: "青岛", latitude: 36.0671, longitude: 120.3826 },
  { name: "厦门", latitude: 24.4798, longitude: 118.0894 },
  { name: "福州", latitude: 26.0745, longitude: 119.2965 },
  { name: "昆明", latitude: 25.0389, longitude: 102.7183 },
  { name: "贵阳", latitude: 26.647, longitude: 106.6302 },
  { name: "南宁", latitude: 22.817, longitude: 108.3665 },
  { name: "海口", latitude: 20.044, longitude: 110.1999 },
  { name: "三亚", latitude: 18.2528, longitude: 109.5119 },
  { name: "天津", latitude: 39.3434, longitude: 117.3616 },
  { name: "郑州", latitude: 34.7466, longitude: 113.6254 },
  { name: "济南", latitude: 36.6512, longitude: 117.1201 },
  { name: "沈阳", latitude: 41.8057, longitude: 123.4315 },
  { name: "大连", latitude: 38.914, longitude: 121.6147 },
  { name: "哈尔滨", latitude: 45.8038, longitude: 126.535 },
  { name: "长春", latitude: 43.8171, longitude: 125.3235 },
  { name: "呼和浩特", latitude: 40.8426, longitude: 111.7492 },
  { name: "乌鲁木齐", latitude: 43.8256, longitude: 87.6168 },
  { name: "拉萨", latitude: 29.652, longitude: 91.1721 },
];

/** 初始化地区下拉；只建一次复选项 */
function initWeatherCities() {
  const menu = $("weather-city-menu");
  if (menu.childElementCount > 0) return;
  for (const [index, city] of WEATHER_CITIES.entries()) {
    const label = el("label", "city-option");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.id = `weather-city-${index}`;
    input.dataset.name = city.name;
    input.addEventListener("change", updateWeatherLabel);
    label.appendChild(input);
    label.appendChild(document.createTextNode(city.name));
    menu.appendChild(label);
  }
}

/** 已勾选地区 */
function selectedWeatherCities() {
  return WEATHER_CITIES.filter((_, index) => $(`weather-city-${index}`)?.checked);
}

/** 更新下拉按钮上的摘要 */
function updateWeatherLabel() {
  const picked = selectedWeatherCities().map((c) => c.name);
  $("weather-city-label").textContent = picked.length === 0 ? "选择地区" : picked.join("、");
}

/** 打开/关闭下拉 */
function setWeatherMenuOpen(open) {
  $("weather-city-menu").classList.toggle("hidden", !open);
  $("weather-city-toggle").setAttribute("aria-expanded", String(open));
}

$("weather-city-toggle").addEventListener("click", (e) => {
  e.stopPropagation();
  setWeatherMenuOpen($("weather-city-menu").classList.contains("hidden"));
});

document.addEventListener("click", (e) => {
  if (!(e.target instanceof Node)) return;
  if (!$("weather-city-picker").contains(e.target)) setWeatherMenuOpen(false);
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") setWeatherMenuOpen(false);
});

/** 读取天气设置；用户只看到地区名 */
async function loadWeather() {
  try {
    const v = await window.aegis.getWeather();
    initWeatherCities();
    $("weather-enabled").checked = v.enabled;
    const names = new Set(v.locations.map((l) => l.name));
    for (const [index, city] of WEATHER_CITIES.entries()) {
      $(`weather-city-${index}`).checked = names.has(city.name);
    }
    updateWeatherLabel();
    $("weather-hint").textContent = v.enabled ? "已启用；早报会显示天气" : "未启用";
  } catch (err) {
    $("weather-hint").textContent = `读取失败：${err.message}`;
  }
}

$("btn-save-weather").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  const enabled = $("weather-enabled").checked;
  const locations = selectedWeatherCities();
  if (enabled && locations.length === 0) {
    $("weather-hint").textContent = "启用天气时至少选择一个地区";
    return;
  }
  btn.disabled = true;
  try {
    await window.aegis.setWeather({ enabled, locations });
    $("weather-hint").textContent = "已保存；下一次刷新后显示";
    setWeatherMenuOpen(false);
  } catch (err) {
    $("weather-hint").textContent = `保存失败：${err.message}`;
  } finally {
    btn.disabled = false;
  }
});

// ── 本地日历（ICS） ───────────────────────────────────────────────────

/** 读取日历路径；文件解析失败由 daemon 早报里给出可见提示 */
async function loadCalendar() {
  try {
    const view = await window.aegis.getCalendar();
    $("calendar-path").value = view.icsPath ?? "";
    $("calendar-reminders-enabled").checked = view.remindersEnabled;
    $("calendar-reminder-minutes").value = String(view.reminderMinutes);
    $("calendar-hint").textContent = view.icsPath ? "已配置；早报会读取此文件" : "未选择";
  } catch (err) {
    $("calendar-hint").textContent = `读取失败：${err.message}`;
  }
}

$("btn-pick-calendar").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  try {
    const path = await window.aegis.pickCalendarFile();
    if (!path) return;
    await window.aegis.setCalendar({
      icsPath: path,
      remindersEnabled: $("calendar-reminders-enabled").checked,
      reminderMinutes: Number($("calendar-reminder-minutes").value),
    });
    $("calendar-path").value = path;
    $("calendar-hint").textContent = "已保存；早报会读取此文件";
  } catch (err) {
    $("calendar-hint").textContent = `保存失败：${err.message}`;
  } finally {
    btn.disabled = false;
  }
});

$("btn-save-calendar-reminders").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  try {
    await window.aegis.setCalendar({
      ...($("calendar-path").value ? { icsPath: $("calendar-path").value } : {}),
      remindersEnabled: $("calendar-reminders-enabled").checked,
      reminderMinutes: Number($("calendar-reminder-minutes").value),
    });
    $("calendar-hint").textContent = "提醒设置已保存";
  } catch (err) {
    $("calendar-hint").textContent = `保存失败：${err.message}`;
  } finally {
    btn.disabled = false;
  }
});

$("btn-clear-calendar").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  try {
    await window.aegis.setCalendar({
      remindersEnabled: $("calendar-reminders-enabled").checked,
      reminderMinutes: Number($("calendar-reminder-minutes").value),
    });
    $("calendar-path").value = "";
    $("calendar-hint").textContent = "已清除";
  } catch (err) {
    $("calendar-hint").textContent = `清除失败：${err.message}`;
  } finally {
    btn.disabled = false;
  }
});

// ── 通知渠道 / Webhook ─────────────────────────────────────────────────

let notifyChannels = ["os_notification", "cli_fallback"];

/** 可参与优先级分流的渠道（CLI 只做兜底，不进入路由） */
const ROUTING_CHANNELS = [
  { id: "os_notification", label: "桌面" },
  { id: "webhook", label: "Webhook" },
  { id: "telegram", label: "Telegram" },
  { id: "bark", label: "Bark" },
  { id: "tts", label: "语音" },
  { id: "email", label: "邮件" },
];
const ROUTING_LEVELS = [
  { id: "low", label: "低" },
  { id: "normal", label: "普通" },
  { id: "high", label: "重要" },
];

/** 构建优先级 × 渠道矩阵；每次 loadNotify 重建，避免残留旧状态 */
function renderRoutingMatrix() {
  const box = $("routing-matrix");
  box.textContent = "";
  for (const level of ROUTING_LEVELS) {
    const row = el("div", "routing-row");
    row.appendChild(el("span", "routing-level", level.label));
    for (const channel of ROUTING_CHANNELS) {
      const label = el("label", "routing-choice");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.id = `routing-${level.id}-${channel.id}`;
      input.dataset.level = level.id;
      input.dataset.channel = channel.id;
      label.appendChild(input);
      label.appendChild(document.createTextNode(channel.label));
      row.appendChild(label);
    }
    box.appendChild(row);
  }
}

/** 读取某级别已勾选渠道 */
function routingChecked(level) {
  return ROUTING_CHANNELS.map((c) => c.id).filter((id) => $(`routing-${level}-${id}`)?.checked);
}

/** 读取 Webhook 配置；保存后需要重启 daemon 才会重建 notifier 链 */
async function loadNotify() {
  try {
    const view = await window.aegis.getNotify();
    notifyChannels = view.channels;
    $("webhook-enabled").checked = view.webhookEnabled;
    $("webhook-url").value = view.webhookUrl ?? "";
    $("telegram-enabled").checked = view.telegramEnabled === true;
    $("telegram-chat-id").value = view.telegramChatId ?? "";
    $("telegram-hint").textContent = view.telegramHasToken ? "已配置 Bot Token" : "未配置 Bot Token";
    $("bark-enabled").checked = view.barkEnabled === true;
    $("bark-server-url").value = view.barkServerUrl ?? "https://api.day.app";
    $("bark-hint").textContent = view.barkHasToken ? "已配置 Device Key" : "未配置 Device Key";
    $("email-enabled").checked = view.emailEnabled === true;
    $("email-host").value = view.emailHost ?? "";
    $("email-port").value = String(view.emailPort ?? 465);
    $("email-secure").checked = view.emailSecure !== false;
    $("email-from").value = view.emailFrom ?? "";
    $("email-to").value = view.emailTo ?? "";
    $("email-user").value = view.emailUser ?? "";
    $("email-hint").textContent = view.emailHasPassword ? "已配置 SMTP 密码" : "未配置 SMTP 密码";
    $("tts-enabled").checked = view.ttsEnabled === true;
    $("tts-voice").value = view.ttsVoice ?? "";
    $("tts-hint").textContent = view.ttsEnabled ? "已启用" : "未启用";
    $("routing-enabled").checked = view.routingEnabled === true;
    renderRoutingMatrix();
    for (const [level, values] of [
      ["low", view.routingLow ?? []],
      ["normal", view.routingNormal ?? []],
      ["high", view.routingHigh ?? []],
    ]) {
      for (const id of values) {
        const input = $(`routing-${level}-${id}`);
        if (input) input.checked = true;
      }
    }
    $("webhook-hint").textContent = view.webhookEnabled
      ? "已启用；保存后需重启 daemon 生效"
      : "未启用";
  } catch (err) {
    $("webhook-hint").textContent = `读取失败：${err.message}`;
  }
}

/** 构造完整的通知设置；两个保存按钮共用，避免互相覆盖 */
function readNotifySettings() {
  const webhookEnabled = $("webhook-enabled").checked;
  const webhookUrl = $("webhook-url").value.trim();
  const telegramEnabled = $("telegram-enabled").checked;
  const telegramChatId = $("telegram-chat-id").value.trim();
  const barkEnabled = $("bark-enabled").checked;
  const barkServerUrl = $("bark-server-url").value.trim() || "https://api.day.app";
  const ttsEnabled = $("tts-enabled").checked;
  const ttsVoice = $("tts-voice").value.trim();
  const emailEnabled = $("email-enabled").checked;
  const emailHost = $("email-host").value.trim();
  const emailPort = Number($("email-port").value);
  const emailSecure = $("email-secure").checked;
  const emailFrom = $("email-from").value.trim();
  const emailTo = $("email-to").value.trim();
  const emailUser = $("email-user").value.trim();
  const routingEnabled = $("routing-enabled").checked;
  if (webhookEnabled && !/^https?:\/\//.test(webhookUrl)) throw new Error("启用 Webhook 时必须填写 http/https URL");
  if (telegramEnabled && !telegramChatId) throw new Error("启用 Telegram 时必须填写 chat_id");
  if (barkEnabled && !/^https?:\/\//.test(barkServerUrl)) throw new Error("Bark 服务地址必须是 http/https");
  if (emailEnabled && (!emailHost || !emailFrom || !emailTo)) {
    throw new Error("启用邮件时必须填写 SMTP host/from/to");
  }
  if (!Number.isInteger(emailPort) || emailPort < 1 || emailPort > 65535) {
    throw new Error("SMTP 端口必须是 1-65535");
  }
  const channels = new Set(notifyChannels);
  if (webhookEnabled) channels.add("webhook");
  else channels.delete("webhook");
  if (telegramEnabled) channels.add("telegram");
  else channels.delete("telegram");
  if (barkEnabled) channels.add("bark");
  else channels.delete("bark");
  if (ttsEnabled) channels.add("tts");
  else channels.delete("tts");
  if (emailEnabled) channels.add("email");
  else channels.delete("email");
  return {
    channels: [...channels],
    webhookEnabled,
    ...(webhookUrl ? { webhookUrl } : {}),
    telegramEnabled,
    ...(telegramChatId ? { telegramChatId } : {}),
    barkEnabled,
    barkServerUrl,
    ttsEnabled,
    ...(ttsVoice ? { ttsVoice } : {}),
    emailEnabled,
    ...(emailHost ? { emailHost } : {}),
    emailPort,
    emailSecure,
    ...(emailFrom ? { emailFrom } : {}),
    ...(emailTo ? { emailTo } : {}),
    ...(emailUser ? { emailUser } : {}),
    routingEnabled,
    routingLow: routingChecked("low"),
    routingNormal: routingChecked("normal"),
    routingHigh: routingChecked("high"),
  };
}

$("btn-set-bark-token").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  const input = $("bark-device-key");
  const token = input.value.trim();
  if (!token) {
    $("bark-hint").textContent = "Device Key 不能为空";
    return;
  }
  btn.disabled = true;
  try {
    await window.aegis.setBarkToken(token);
    input.value = "";
    $("bark-hint").textContent = "Device Key 已写入钥匙串";
  } catch (err) {
    $("bark-hint").textContent = `保存失败：${err.message}`;
  } finally {
    btn.disabled = false;
  }
});

$("btn-test-tts").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  $("tts-hint").textContent = "播报中…";
  try {
    const saved = await window.aegis.setNotify(readNotifySettings());
    notifyChannels = saved.channels;
    const r = await window.aegis.testTts();
    $("tts-hint").textContent =
      r.outcome === "success" ? "播报成功" : `测试失败：${r.error ?? r.outcome}`;
  } catch (err) {
    $("tts-hint").textContent = `测试失败：${err.message}`;
  } finally {
    btn.disabled = false;
  }
});

$("btn-set-email-password").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  const input = $("email-password");
  const password = input.value.trim();
  if (!password) {
    $("email-hint").textContent = "SMTP 密码不能为空";
    return;
  }
  btn.disabled = true;
  try {
    await window.aegis.setEmailPassword(password);
    input.value = "";
    $("email-hint").textContent = "SMTP 密码已写入钥匙串";
  } catch (err) {
    $("email-hint").textContent = `保存失败：${err.message}`;
  } finally {
    btn.disabled = false;
  }
});

$("btn-test-email").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  $("email-hint").textContent = "发送测试邮件中…";
  try {
    const saved = await window.aegis.setNotify(readNotifySettings());
    notifyChannels = saved.channels;
    const r = await window.aegis.testEmail();
    $("email-hint").textContent =
      r.outcome === "success" ? "测试邮件已发送" : `测试失败：${r.error ?? r.outcome}`;
  } catch (err) {
    $("email-hint").textContent = `测试失败：${err.message}`;
  } finally {
    btn.disabled = false;
  }
});

$("btn-test-bark").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  $("bark-hint").textContent = "测试中…";
  try {
    const r = await window.aegis.testBark();
    $("bark-hint").textContent =
      r.outcome === "success" ? "Bark 测试成功" : `测试失败：${r.error ?? r.outcome}`;
  } catch (err) {
    $("bark-hint").textContent = `测试失败：${err.message}`;
  } finally {
    btn.disabled = false;
  }
});

/** 保存 Webhook/Telegram 设置；notifier 链需要重启 daemon 重建 */
async function saveNotifySettings(btn) {
  btn.disabled = true;
  try {
    const saved = await window.aegis.setNotify(readNotifySettings());
    notifyChannels = saved.channels;
    $("webhook-hint").textContent = "已保存；重启 daemon 后生效";
  } catch (err) {
    $("webhook-hint").textContent = `保存失败：${err.message}`;
  } finally {
    btn.disabled = false;
  }
}

$("btn-save-webhook").addEventListener("click", (e) => void saveNotifySettings(e.currentTarget));

$("btn-set-telegram-token").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  const input = $("telegram-token");
  const token = input.value.trim();
  if (!token) {
    $("telegram-hint").textContent = "Bot Token 不能为空";
    return;
  }
  btn.disabled = true;
  try {
    await window.aegis.setTelegramToken(token);
    input.value = "";
    $("telegram-hint").textContent = "Token 已写入钥匙串";
  } catch (err) {
    $("telegram-hint").textContent = `保存失败：${err.message}`;
  } finally {
    btn.disabled = false;
  }
});

$("btn-test-telegram").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  $("telegram-hint").textContent = "测试中…";
  try {
    const r = await window.aegis.testTelegram();
    $("telegram-hint").textContent =
      r.outcome === "success" ? "Telegram 测试成功" : `测试失败：${r.error ?? r.outcome}`;
  } catch (err) {
    $("telegram-hint").textContent = `测试失败：${err.message}`;
  } finally {
    btn.disabled = false;
  }
});

$("btn-test-webhook").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  const url = $("webhook-url").value.trim();
  if (!/^https?:\/\//.test(url)) {
    $("webhook-hint").textContent = "请先填写 http/https URL";
    return;
  }
  btn.disabled = true;
  $("webhook-hint").textContent = "测试中…";
  try {
    const r = await window.aegis.testWebhook(url);
    $("webhook-hint").textContent =
      r.outcome === "success" ? "Webhook 测试成功" : `测试失败：${r.error ?? r.outcome}`;
  } catch (err) {
    $("webhook-hint").textContent = `测试失败：${err.message}`;
  } finally {
    btn.disabled = false;
  }
});

// ── 每日简报 ───────────────────────────────────────────────────────────

/** 读取简报设置；失败只提示，不影响其他设置 */
async function loadBriefing() {
  try {
    const view = await window.aegis.getBriefing();
    $("briefing-enabled").checked = view.enabled;
    $("briefing-time").value = view.time;
    $("briefing-hint").textContent = view.enabled ? `每天 ${view.time} 生成` : "未启用";
  } catch (err) {
    $("briefing-hint").textContent = `读取失败：${err.message}`;
  }
}

$("btn-save-briefing").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  const settings = {
    enabled: $("briefing-enabled").checked,
    time: $("briefing-time").value,
  };
  if (!/^\d{2}:\d{2}$/.test(settings.time)) {
    $("briefing-hint").textContent = "时间格式必须为 HH:mm";
    btn.disabled = false;
    return;
  }
  try {
    await window.aegis.setBriefing(settings);
    $("briefing-hint").textContent = settings.enabled ? `已保存，每天 ${settings.time} 生成` : "已停用";
  } catch (err) {
    $("briefing-hint").textContent = `保存失败：${err.message}`;
  } finally {
    btn.disabled = false;
  }
});

// ── 知识库 ─────────────────────────────────────────────────────────────

/** 渲染已入库文档；坏/空状态都要给出下一步提示 */
function renderKnowledgeDocs(documents) {
  const box = $("knowledge-docs");
  box.textContent = "";
  if (documents.length === 0) {
    box.appendChild(el("p", "hint", "还没有文档。导入 Markdown/TXT 后，可用中文子串检索。"));
    return;
  }
  for (const doc of documents) {
    const row = el("div", "knowledge-doc");
    row.appendChild(el("strong", "", doc.title));
    row.appendChild(el("span", "hint", `${doc.chunkCount} 块 · ${doc.dataClass}`));
    row.appendChild(el("span", "path", doc.sourcePath));
    const remove = el("button", "btn btn-ghost btn-small", "删除");
    remove.addEventListener("click", async () => {
      if (!window.confirm(`删除知识文档「${doc.title}」？`)) return;
      try {
        await window.aegis.removeKnowledge(doc.id);
        $("knowledge-hint").textContent = "已删除";
        await loadKnowledge();
        $("knowledge-results").textContent = "";
      } catch (err) {
        $("knowledge-hint").textContent = `删除失败：${err.message}`;
      }
    });
    row.appendChild(remove);
    box.appendChild(row);
  }
}

/** 列出知识库文档 */
async function loadKnowledge() {
  try {
    const result = await window.aegis.listKnowledge();
    renderKnowledgeDocs(result.documents);
    $("knowledge-hint").textContent = `已入库 ${result.documents.length} 个文档`;
  } catch (err) {
    $("knowledge-hint").textContent = `读取知识库失败：${err.message}`;
  }
}

/** 渲染检索结果；引用可点击打开原文件 */
function renderKnowledgeHits(hits) {
  const box = $("knowledge-results");
  box.textContent = "";
  if (hits.length === 0) {
    box.appendChild(el("p", "hint", "知识库里没有找到依据。"));
    return;
  }
  for (const hit of hits) {
    const row = el("div", "knowledge-hit");
    const head = el("div", "knowledge-hit-head");
    head.appendChild(el("strong", "", hit.title));
    head.appendChild(el("span", "hint", ` · ${hit.dataClass} · ${hit.sourcePath}#${hit.ordinal}`));
    row.appendChild(head);
    row.appendChild(el("div", "snippet", hit.text.slice(0, 240)));
    const cite = el("button", "citation", `打开引用：${hit.sourcePath}`);
    cite.title = "用系统默认程序打开来源文件";
    cite.addEventListener("click", async () => {
      try {
        const r = await window.aegis.openKnowledgeSource(hit.sourcePath);
        if (!r.ok) $("knowledge-hint").textContent = `打开失败：${r.error ?? "未知错误"}`;
      } catch (err) {
        $("knowledge-hint").textContent = `打开失败：${err.message}`;
      }
    });
    row.appendChild(cite);
    box.appendChild(row);
  }
}

/** 检索知识库 */
async function searchKnowledge() {
  const query = $("knowledge-query").value.trim();
  if (!query) {
    $("knowledge-hint").textContent = "请输入检索词";
    return;
  }
  try {
    const result = await window.aegis.searchKnowledge(query);
    renderKnowledgeHits(result.hits);
    $("knowledge-hint").textContent = result.hits.length > 0 ? `找到 ${result.hits.length} 条` : "没有找到依据";
  } catch (err) {
    $("knowledge-hint").textContent = `检索失败：${err.message}`;
  }
}

/** 渲染问答结果；拒答必须显示清楚原因，不能给一个看似可信的答案 */
function renderKnowledgeAnswer(result) {
  const box = $("knowledge-answer");
  box.textContent = "";
  if (!result.ok) {
    const label =
      result.reason === "no_evidence"
        ? "知识库里没有找到依据，无法回答。"
        : result.reason === "sensitive" || result.reason === "blocked"
          ? "依据涉及不适合外发的内容，已拒答。"
          : result.message;
    box.appendChild(el("div", "hint", label));
    return;
  }
  box.appendChild(el("div", "answer-text", result.answer));
  const list = el("div", "citation-list");
  for (const citation of result.citations) {
    const btn = el("button", "citation", `[${citation.ordinal + 1}] ${citation.title}`);
    btn.title = citation.sourcePath;
    btn.addEventListener("click", async () => {
      const r = await window.aegis.openKnowledgeSource(citation.sourcePath);
      if (!r.ok) $("knowledge-hint").textContent = `打开失败：${r.error ?? "未知错误"}`;
    });
    list.appendChild(btn);
  }
  box.appendChild(list);
}

/** 提问；无证据/模型不可用/被网关拒绝都走明确拒答 */
async function askKnowledge() {
  const question = $("knowledge-question").value.trim();
  if (!question) {
    $("knowledge-hint").textContent = "请输入问题";
    return;
  }
  $("knowledge-answer").textContent = "思考中…";
  try {
    const result = await window.aegis.answerKnowledge(question);
    renderKnowledgeAnswer(result);
  } catch (err) {
    $("knowledge-answer").textContent = `问答失败：${err.message}`;
  }
}

$("btn-ask-knowledge").addEventListener("click", () => void askKnowledge());
$("knowledge-question").addEventListener("keydown", (e) => {
  if (e.key === "Enter") void askKnowledge();
});

$("btn-import-knowledge").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  $("knowledge-hint").textContent = "选择文档…";
  try {
    const picked = await window.aegis.pickKnowledgeFile();
    if (!picked) {
      $("knowledge-hint").textContent = "已取消";
      return;
    }
    const dataClass = $("knowledge-class").value;
    const result = await window.aegis.importKnowledge(picked.sourcePath, picked.content, dataClass);
    $("knowledge-hint").textContent = `已入库 ${result.document.title}（${result.document.chunkCount} 块）`;
    await loadKnowledge();
  } catch (err) {
    $("knowledge-hint").textContent = `入库失败：${err.message}`;
  } finally {
    btn.disabled = false;
  }
});

$("btn-refresh-knowledge").addEventListener("click", () => void loadKnowledge());
$("btn-search-knowledge").addEventListener("click", () => void searchKnowledge());
$("knowledge-query").addEventListener("keydown", (e) => {
  if (e.key === "Enter") void searchKnowledge();
});

// ── 模型（LLM）设置 ─────────────────────────────────────────────────────

/** 常用 OpenAI 兼容服务商预设；模型列表以 /models 的结果为准 */
const LLM_PROVIDERS = {
  openai: { baseUrl: "https://api.openai.com/v1", fallback: ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini"] },
  deepseek: { baseUrl: "https://api.deepseek.com/v1", fallback: ["deepseek-chat", "deepseek-reasoner"] },
  kimi: { baseUrl: "https://api.moonshot.cn/v1", fallback: ["moonshot-v1-8k", "moonshot-v1-32k", "moonshot-v1-128k"] },
  glm: { baseUrl: "https://open.bigmodel.cn/api/paas/v4", fallback: ["glm-4-flash", "glm-4-plus"] },
  custom: { baseUrl: "", fallback: [] },
};

let llmCurrentModel = "";

/** 切换服务商时自动填 Base URL；自定义才显示输入框 */
function applyLlmProvider({ resetModel = true } = {}) {
  const provider = $("llm-provider").value;
  const preset = LLM_PROVIDERS[provider] ?? LLM_PROVIDERS.custom;
  const isCustom = provider === "custom";
  $("llm-base-url-field").classList.toggle("hidden", !isCustom);
  if (!isCustom) $("llm-base-url").value = preset.baseUrl;
  if (resetModel) {
    llmCurrentModel = preset.fallback[0] ?? "";
    $("llm-model").classList.add("hidden");
    $("llm-model").textContent = "";
    $("llm-model-current").textContent = llmCurrentModel ? `当前：${llmCurrentModel}（连接后可切换）` : "尚未连接";
  }
}

/** 拉取设置并回填表单；API Key 只显示"是否已配置" */
async function loadLlm() {
  try {
    const view = await window.aegis.getLlm();
    $("llm-enabled").checked = view.enabled;
    $("llm-provider").value = view.provider;
    $("llm-base-url").value = view.baseUrl;
    llmCurrentModel = view.model;
    applyLlmProvider({ resetModel: false });
    $("llm-model-current").textContent = `当前：${view.model}`;
    $("llm-timeout").value = String(view.timeoutMs);
    $("llm-max-class").value = view.maxOutboundClass;
    $("llm-daily-limit").value = String(view.dailyCallLimit);
    $("llm-key-status").textContent = view.hasApiKey ? "已配置 API Key" : "未配置 API Key";
    $("llm-usage").textContent = `今日调用 ${view.callsToday} 次，剩余 ${view.remainingCalls} 次`;
    if (view.keychainError) $("llm-key-status").textContent = `钥匙串不可用：${view.keychainError}`;
    $("llm-hint").textContent = view.hasApiKey
      ? "选择服务商后点「连接并获取模型」"
      : "填入 API Key 后点「连接并获取模型」";
  } catch (err) {
    $("llm-hint").textContent = `读取失败：${err.message}`;
  }
}

/** 从表单构建设置；URL/数字在前端先做基本检查 */
function readLlmForm() {
  const enabled = $("llm-enabled").checked;
  const provider = $("llm-provider").value;
  // 预设服务商即使输入框被隐藏/尚未回填，也必须能从预设推导出 Base URL；
  // 这条路径曾经因为 loadLlm 失败导致 Base URL 为空，连接按钮无法使用。
  const baseUrl =
    $("llm-base-url").value.trim() ||
    (provider === "custom" ? "" : (LLM_PROVIDERS[provider]?.baseUrl ?? ""));
  const modelSelect = $("llm-model");
  const model =
    (!modelSelect.classList.contains("hidden") && modelSelect.value) || llmCurrentModel;
  const timeoutMs = Number($("llm-timeout").value);
  const maxOutboundClass = $("llm-max-class").value;
  const dailyCallLimit = Number($("llm-daily-limit").value);
  if (!/^https?:\/\//.test(baseUrl)) throw new Error("Base URL 必须以 http:// 或 https:// 开头");
  if (!model) throw new Error("模型名不能为空");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000) throw new Error("超时必须 ≥1000 毫秒");
  if (!Number.isInteger(dailyCallLimit) || dailyCallLimit < 1) throw new Error("每日调用上限必须 ≥1");
  return { enabled, provider, baseUrl, model, timeoutMs, maxOutboundClass, dailyCallLimit };
}

/** 用发现结果填充模型下拉；没有远程列表时用预设候选 */
function showLlmModels(models) {
  const select = $("llm-model");
  select.textContent = "";
  for (const model of models) {
    const option = el("option", "", model);
    option.value = model;
    select.appendChild(option);
  }
  if (models.length === 0) {
    $("llm-model-current").textContent = "未能获取模型列表";
    return;
  }
  const preferred = models.includes(llmCurrentModel) ? llmCurrentModel : models[0];
  select.value = preferred;
  llmCurrentModel = preferred;
  select.classList.remove("hidden");
  $("llm-model-current").textContent = "连接成功，可切换模型后保存";
}

$("btn-save-llm").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  try {
    await window.aegis.setLlm(readLlmForm());
    $("llm-hint").textContent = "设置已保存";
    await loadLlm();
  } catch (err) {
    $("llm-hint").textContent = `保存失败：${err.message}`;
  } finally {
    btn.disabled = false;
  }
});

$("llm-provider").addEventListener("change", () => applyLlmProvider());

$("btn-set-llm-key").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  const input = $("llm-api-key");
  const key = input.value.trim();
  if (!key) {
    $("llm-key-status").textContent = "API Key 不能为空";
    return;
  }
  btn.disabled = true;
  try {
    await window.aegis.setLlmKey(key);
    input.value = "";
    $("llm-key-status").textContent = "已写入系统钥匙串";
    await loadLlm();
  } catch (err) {
    $("llm-key-status").textContent = `保存失败：${err.message}`;
  } finally {
    btn.disabled = false;
  }
});

$("btn-clear-llm-key").addEventListener("click", async () => {
  if (!window.confirm("清除已保存的 API Key？")) return;
  try {
    await window.aegis.clearLlmKey();
    $("llm-key-status").textContent = "已清除";
    await loadLlm();
  } catch (err) {
    $("llm-key-status").textContent = `清除失败：${err.message}`;
  }
});

/** 渲染最近外发审计；只有摘要，没有原文/Key */
function renderLlmAudit(entries) {
  const box = $("llm-audit");
  box.textContent = "";
  if (entries.length === 0) {
    box.appendChild(el("p", "hint", "还没有外发记录"));
    return;
  }
  for (const entry of entries) {
    const row = el("div", "audit-row");
    const outcome = el("span", `audit-outcome ${entry.outcome}`, entry.outcome);
    row.appendChild(outcome);
    row.appendChild(
      document.createTextNode(
        ` ${entry.purpose} · ${new Date(entry.at).toLocaleString("zh-CN")} · ${entry.destination} · ${entry.dataClass} · 脱敏 ${entry.redactionCount} · ${entry.payloadSha256.slice(0, 10)}…`,
      ),
    );
    box.appendChild(row);
  }
}

/** 读取审计列表；失败只显示在列表里 */
async function loadLlmAudit() {
  try {
    const result = await window.aegis.getLlmAudit(20);
    renderLlmAudit(result.entries);
  } catch (err) {
    const box = $("llm-audit");
    box.textContent = "";
    box.appendChild(el("p", "hint", `读取审计失败：${err.message}`));
  }
}

$("btn-refresh-llm-audit").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  try {
    await loadLlmAudit();
  } finally {
    btn.disabled = false;
  }
});

$("btn-test-llm").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  $("llm-hint").textContent = "正在保存设置并测试连接…";
  try {
    // 先按当前服务商回填 Base URL，再读表单；避免隐藏字段为空导致连接失败。
    applyLlmProvider({ resetModel: false });
    const settings = readLlmForm();
    // 「连接并获取模型」本身表达启用意图：未勾选时自动启用，避免用户被一个
    // 与当前动作无关的复选框挡住。
    settings.enabled = true;
    $("llm-enabled").checked = true;
    await window.aegis.setLlm(settings);
    const key = $("llm-api-key").value.trim();
    if (key) {
      await window.aegis.setLlmKey(key);
      $("llm-api-key").value = "";
    }

    const result = await window.aegis.testLlm();
    if (!result.ok) {
      $("llm-hint").textContent = `连接失败：${result.reason}`;
      return;
    }

    let models = LLM_PROVIDERS[settings.provider]?.fallback ?? [];
    let source = "内置候选";
    try {
      const discovered = await window.aegis.discoverLlmModels();
      if (discovered.models.length > 0) {
        models = discovered.models;
        source = "服务商模型列表";
      }
    } catch {
      // /models 不是所有兼容服务都支持；聊天测试成功时退回内置候选
    }
    showLlmModels(models);
    $("llm-hint").textContent = `连接成功（${source}）；选择模型后点「保存设置」`;
    await loadLlmAudit();
  } catch (err) {
    $("llm-hint").textContent = `连接失败：${err.message}`;
  } finally {
    btn.disabled = false;
  }
});

// ── 监测器状态 ──────────────────────────────────────────────────────────

/** 监测器类型的中文标签 */
function monitorKindLabel(kind) {
  return kind === "files" ? "文件" : kind === "web" ? "网页" : "系统";
}

/** 删除监测器动作；所有行共用，避免重复逻辑 */
function appendRemoveMonitorAction(actions, id) {
  const remove = el("button", "btn btn-ghost btn-small", "删除");
  remove.addEventListener("click", async () => {
    if (!window.confirm(`删除监测器 ${id}？`)) return;
    remove.disabled = true;
    try {
      await window.aegis.removeMonitor(id);
      $("monitor-hint").textContent = `已删除 ${id}`;
      await loadMonitorStatus();
    } catch (err) {
      $("monitor-hint").textContent = `删除失败：${err.message}`;
    } finally {
      remove.disabled = false;
    }
  });
  actions.appendChild(remove);
}

/** 启用/停用动作；启用失败会保留原状态并显示原因 */
function appendToggleMonitorAction(actions, id, enabled) {
  const toggle = el("button", "btn btn-ghost btn-small", enabled ? "停用" : "启用");
  toggle.addEventListener("click", async () => {
    toggle.disabled = true;
    $("monitor-hint").textContent = `${enabled ? "停用" : "启用"}中…`;
    try {
      await window.aegis.toggleMonitor(id, !enabled);
      $("monitor-hint").textContent = enabled ? `已停用 ${id}` : `已启用 ${id}`;
      await loadMonitorStatus();
    } catch (err) {
      $("monitor-hint").textContent = `${enabled ? "停用" : "启用"}失败：${err.message}`;
    } finally {
      toggle.disabled = false;
    }
  });
  actions.appendChild(toggle);
}

/** 立即扫描动作（只有运行中的监测器才有意义） */
function appendScanMonitorAction(actions, id) {
  const scan = el("button", "btn btn-ghost btn-small", "立即扫描");
  scan.addEventListener("click", async () => {
    scan.disabled = true;
    $("monitor-hint").textContent = `正在扫描 ${id}…`;
    try {
      const result = await window.aegis.scanMonitor(id);
      $("monitor-hint").textContent = result.found
        ? `扫描完成：通知 ${result.notified} 条，错误 ${result.errors} 个`
        : `当前运行配置中没有 ${id}`;
      await loadMonitorStatus();
    } catch (err) {
      $("monitor-hint").textContent = `扫描失败：${err.message}`;
    } finally {
      scan.disabled = false;
    }
  });
  actions.appendChild(scan);
}

/**
 * 渲染监测器列表。
 *
 * 状态来自运行时，配置来自 config.json —— 两者必须合并展示：
 * 只有状态列表会漏掉"已停用"和"配置了但未运行"的项，用户就找不到它们。
 */
function renderMonitorStatus(monitors, configs) {
  const box = $("monitor-list");
  box.textContent = "";
  const statusById = new Map(monitors.map((m) => [m.id, m]));
  const configById = new Map(configs.map((m) => [m.id, m]));
  const ids = [...new Set([...configs.map((m) => m.id), ...monitors.map((m) => m.id)])];

  if (ids.length === 0) {
    box.appendChild(
      el("p", "hint", "还没有配置监测器。点击「添加监测器」，或参考 docs/M2-MONITORS.md。"),
    );
    return;
  }

  for (const id of ids) {
    const status = statusById.get(id);
    const config = configById.get(id);
    const enabled = config ? config.enabled !== false : true;
    const active = Boolean(status);
    const kind = status?.kind ?? config?.kind ?? "system";
    const intervalMs = status?.intervalMs ?? (config ? config.intervalS * 1_000 : 0);
    const skills = status?.skills ?? config?.skills ?? [];

    const row = el("div", "monitor-row");
    const head = el("div", "monitor-head");
    head.appendChild(el("strong", "", id));
    head.appendChild(el("span", "monitor-badge", monitorKindLabel(kind)));
    if (!enabled) head.appendChild(el("span", "monitor-badge", "已停用"));
    else if (!active) head.appendChild(el("span", "monitor-badge", "未运行"));

    const actions = el("div", "monitor-actions");
    if (active) appendScanMonitorAction(actions, id);
    if (config) appendToggleMonitorAction(actions, id, enabled);
    appendRemoveMonitorAction(actions, id);
    head.appendChild(actions);
    row.appendChild(head);

    const meta = el("div", "monitor-meta");
    meta.appendChild(
      el(
        "div",
        "",
        `每 ${Math.round(intervalMs / 1_000)} 秒 · Skills：${
          skills.map((s) => String(s).replace(/^skills\//, "")).join("、") || "无"
        }`,
      ),
    );
    if (!enabled) {
      meta.appendChild(el("div", "", "已停用，不会扫描"));
    } else if (!status) {
      meta.appendChild(el("div", "", "配置已保存，但运行时没有绑定成功；检查 Skill 路径/trigger/权限"));
    } else {
      const last = status.lastScanAt
        ? new Date(status.lastScanAt).toLocaleTimeString("zh-CN")
        : "尚未扫描";
      meta.appendChild(
        el(
          "div",
          "",
          `上次：${last} · facts ${status.lastFacts} · 通知 ${status.lastNotified} · 错误 ${status.lastErrors}`,
        ),
      );
    }
    row.appendChild(meta);

    if (status?.error) row.appendChild(el("div", "monitor-error", status.error));
    box.appendChild(row);
  }
}

/** 读取监测器状态与配置并合并渲染；失败时只更新 hint，不打断设置页 */
async function loadMonitorStatus() {
  try {
    const [status, config] = await Promise.all([
      window.aegis.getMonitorStatus(),
      window.aegis.getMonitorConfig(),
    ]);
    renderMonitorStatus(status.monitors, config.monitors);
    $("monitor-hint").textContent =
      config.monitors.length > 0 ? "状态来自 daemon 最近一次扫描" : "";
  } catch (err) {
    $("monitor-hint").textContent = `读取失败：${err.message}`;
  }
}

$("btn-refresh-monitors").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  $("monitor-hint").textContent = "刷新中…";
  try {
    await loadMonitorStatus();
  } finally {
    btn.disabled = false;
  }
});

// ── Skill 管理 ──────────────────────────────────────────────────────────

/** 渲染 Skill 文件列表；坏文件也要显示，让用户能删掉或修正 */
function renderSkillList(skills) {
  const box = $("skill-list");
  box.textContent = "";

  if (skills.length === 0) {
    box.appendChild(
      el("p", "hint", "还没有 Skill。点击「导入 Skill」选择 YAML；导入后可在 config.json 的 monitors 中引用。"),
    );
    return;
  }

  for (const skill of skills) {
    const row = el("div", "monitor-row");

    const head = el("div", "skill-head");
    head.appendChild(el("strong", "", skill.name || skill.file));
    head.appendChild(el("span", "monitor-badge", skill.valid ? "有效" : "错误"));
    const exportButton = el("button", "btn btn-ghost btn-small", "导出");
    exportButton.addEventListener("click", async () => {
      exportButton.disabled = true;
      try {
        const result = await window.aegis.exportSkill(skill.file);
        $("skill-hint").textContent = result.canceled ? "已取消导出" : `已导出到 ${result.path}`;
      } catch (err) {
        $("skill-hint").textContent = `导出失败：${err.message}`;
      } finally {
        exportButton.disabled = false;
      }
    });
    head.appendChild(exportButton);

    const del = el("button", "btn btn-ghost btn-small", "删除");
    del.title = `删除 ${skill.file}`;
    del.addEventListener("click", async () => {
      if (!window.confirm(`删除 Skill ${skill.file}？`)) return;
      try {
        await window.aegis.deleteSkill(skill.file);
        $("skill-hint").textContent = `已删除 ${skill.file}`;
        await loadSkillList();
      } catch (err) {
        $("skill-hint").textContent = `删除失败：${err.message}`;
      }
    });
    head.appendChild(del);
    row.appendChild(head);

    if (skill.description) row.appendChild(el("div", "skill-desc", skill.description));
    row.appendChild(
      el(
        "div",
        "skill-meta",
        `${skill.file}${skill.version ? ` · v${skill.version}` : ""} · 权限：${
          skill.permissions.join("、") || "无"
        } · 触发：${skill.triggerMonitor || "—"}`,
      ),
    );
    if (skill.error) row.appendChild(el("div", "monitor-error", skill.error));
    box.appendChild(row);
  }
}

/** 读取 skills/ 列表；失败只更新 hint */
async function loadSkillList() {
  try {
    const result = await window.aegis.getSkills();
    renderSkillList(result.skills);
    if (result.skills.length > 0) {
      $("skill-hint").textContent = "导入/更新后，别忘了在 config.json 的 monitors 中引用文件名";
    }
  } catch (err) {
    $("skill-hint").textContent = `读取失败：${err.message}`;
  }
}

$("btn-refresh-skills").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  try {
    await loadSkillList();
  } finally {
    btn.disabled = false;
  }
});

$("btn-install-defaults").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  $("skill-hint").textContent = "安装示例中…";
  try {
    const result = await window.aegis.installDefaultSkills();
    $("skill-hint").textContent = `已安装 ${result.installed.length} 个，跳过 ${result.skipped.length} 个已有文件`;
    await loadSkillList();
  } catch (err) {
    $("skill-hint").textContent = `安装失败：${err.message}`;
  } finally {
    btn.disabled = false;
  }
});

$("btn-import-skill").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  $("skill-hint").textContent = "选择文件…";
  try {
    const picked = await window.aegis.pickSkillFile();
    if (!picked) {
      $("skill-hint").textContent = "已取消";
      return;
    }
    const result = await window.aegis.importSkill(picked.filename, picked.content);
    $("skill-hint").textContent = `已导入 ${result.skill.name}（${result.skill.file}）`;
    await loadSkillList();
  } catch (err) {
    $("skill-hint").textContent = `导入失败：${err.message}`;
  } finally {
    btn.disabled = false;
  }
});

// ── 监测器表单 ──────────────────────────────────────────────────────────

/** 逗号/换行分隔 → 去空数组 */
function splitPatterns(value) {
  return value
    .split(/[,，\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 按类型显示文件/网页字段；系统监测没有额外字段 */
function updateMonitorFormKind() {
  const kind = $("mon-kind").value;
  $("mon-file-fields").classList.toggle("hidden", kind !== "files");
  $("mon-web-fields").classList.toggle("hidden", kind !== "web");
  if (kind === "web") {
    const mode = $("mon-mode").value;
    $("mon-selector-field").classList.toggle("hidden", mode !== "page");
    $("mon-jsonpath-field").classList.toggle("hidden", mode !== "json");
  }
}

/** 用已导入的有效 Skill 填充多选；导入路径统一为 skills/<file> */
async function loadMonitorFormSkills() {
  const select = $("mon-skills");
  select.textContent = "";
  try {
    const result = await window.aegis.getSkills();
    const valid = result.skills.filter((s) => s.valid && s.file);
    if (valid.length === 0) {
      const option = el("option", "", "还没有有效 Skill，请先在下方导入");
      option.disabled = true;
      select.appendChild(option);
      return;
    }
    for (const skill of valid) {
      const option = el("option", "", `${skill.name || skill.file}（${skill.file}）`);
      option.value = `skills/${skill.file}`;
      select.appendChild(option);
    }
  } catch (err) {
    $("monitor-form-hint").textContent = `读取 Skill 失败：${err.message}`;
  }
}

/** 打开新增监测器表单 */
async function openMonitorForm() {
  const form = $("monitor-form");
  form.reset();
  $("mon-kind").value = "system";
  $("mon-interval").value = "60";
  $("monitor-form-hint").textContent = "Skill 的 trigger.monitor 必须等于这里的 ID";
  updateMonitorFormKind();
  form.classList.remove("hidden");
  await loadMonitorFormSkills();
  form.scrollIntoView({ block: "nearest" });
}

$("btn-add-monitor").addEventListener("click", () => void openMonitorForm());

$("btn-monitor-preset").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  $("monitor-hint").textContent = "正在补齐验收场景…";
  try {
    const result = await window.aegis.installAcceptancePreset();
    $("monitor-hint").textContent =
      `已安装 Skill ${result.installedSkills.length} 个，添加监测器 ${result.addedMonitors.length} 个` +
      `${result.skippedMonitors.length > 0 ? `，跳过 ${result.skippedMonitors.join("、")}` : ""}`;
    await loadMonitorStatus();
    await loadSkillList();
  } catch (err) {
    $("monitor-hint").textContent = `补齐验收场景失败：${err.message}`;
  } finally {
    btn.disabled = false;
  }
});
$("btn-cancel-monitor").addEventListener("click", () => {
  $("monitor-form").classList.add("hidden");
  $("monitor-form-hint").textContent = "";
});
$("mon-kind").addEventListener("change", updateMonitorFormKind);
$("mon-mode").addEventListener("change", updateMonitorFormKind);

$("monitor-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const hint = $("monitor-form-hint");
  const id = $("mon-id").value.trim();
  const kind = $("mon-kind").value;
  const intervalS = Number($("mon-interval").value);
  const skills = [...$("mon-skills").selectedOptions].map((o) => o.value);

  if (!id) {
    hint.textContent = "ID 不能为空";
    return;
  }
  if (!Number.isInteger(intervalS) || intervalS < 5) {
    hint.textContent = "间隔必须 ≥5 秒";
    return;
  }
  if (skills.length === 0) {
    hint.textContent = "至少选择一个 Skill";
    return;
  }

  const config = { id, kind, intervalS, skills };
  if (kind === "files") {
    const root = $("mon-root").value.trim();
    if (!root) {
      hint.textContent = "目录不能为空";
      return;
    }
    Object.assign(config, {
      root,
      patterns: splitPatterns($("mon-patterns").value),
      ignore: splitPatterns($("mon-ignore").value),
      stableMs: Number($("mon-stable").value) || 0,
    });
  } else if (kind === "web") {
    const url = $("mon-url").value.trim();
    if (!/^https?:\/\//.test(url)) {
      hint.textContent = "URL 必须以 http:// 或 https:// 开头";
      return;
    }
    const selector = $("mon-selector").value.trim();
    const jsonPath = $("mon-jsonpath").value.trim();
    Object.assign(config, { url, mode: $("mon-mode").value });
    if ($("mon-mode").value === "json") {
      if (jsonPath) config.jsonPath = jsonPath;
    } else if (selector) {
      config.selector = selector;
    }
  }

  const save = $("btn-save-monitor");
  save.disabled = true;
  hint.textContent = "保存中…";
  try {
    await window.aegis.addMonitor(config);
    $("monitor-form").classList.add("hidden");
    $("monitor-hint").textContent = `已添加 ${id}`;
    await loadMonitorStatus();
  } catch (err) {
    hint.textContent = `保存失败：${err.message}`;
  } finally {
    save.disabled = false;
  }
});

// ── 启动与通知权限 ──────────────────────────────────────────────────────

/** 读取开机自启状态（复用向导的 getOnboarding） */
async function loadAutostart() {
  try {
    const info = await window.aegis.getOnboarding();
    $("autostart-enabled").checked = info.autostartEnabled;
    $("autostart-hint").textContent = info.autostartEnabled
      ? "已开启：开机后 daemon 会自动启动"
      : "未开启：开机后不会自动启动后台服务";
  } catch (err) {
    $("autostart-hint").textContent = `读取失败：${err.message}`;
  }
}

$("autostart-enabled").addEventListener("change", async (e) => {
  const box = e.currentTarget;
  const desired = box.checked;
  box.disabled = true;
  $("autostart-hint").textContent = "正在设置…";
  try {
    const r = await window.aegis.setAutostart(desired);
    if (!r.ok) {
      box.checked = !desired;
      $("autostart-hint").textContent = `设置失败：${r.detail}`;
      showBanner(`开机自启设置失败：${r.detail}`, "err");
      return;
    }
    $("autostart-hint").textContent = desired
      ? "已开启：开机后 daemon 会自动启动"
      : "已关闭：开机后不会自动启动后台服务";
    showToast(desired ? "已开启开机自启" : "已关闭开机自启");
  } catch (err) {
    box.checked = !desired;
    $("autostart-hint").textContent = `设置失败：${err.message}`;
    showBanner(`开机自启设置失败：${err.message}`, "err");
  } finally {
    box.disabled = false;
  }
});

$("btn-open-notification-settings").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  try {
    const r = await window.aegis.openNotificationSettings();
    if (!r.ok) {
      showBanner(r.detail, "err");
      return;
    }
    showToast(r.detail);
  } catch (err) {
    showBanner(`打开系统通知设置失败：${err.message}`, "err");
  } finally {
    btn.disabled = false;
  }
});

function renderSettings(status) {
  // 运行状态
  const basic = $("diag-basic");
  basic.textContent = "";
  const addKv = (parent, k, v) => {
    parent.appendChild(el("dt", "", k));
    parent.appendChild(el("dd", "", v));
  };

  const stateLabel = {
    running: "运行中",
    starting: "启动中",
    crashed: "已崩溃",
    unavailable: "不可用",
    stopped: "未运行",
  };
  addKv(basic, "后台服务", stateLabel[status.daemonState] ?? status.daemonState);
  if (status.daemonVersion) addKv(basic, "服务版本", status.daemonVersion);
  if (status.health) {
    addKv(basic, "已运行", formatUptime(status.health.uptimeS));
    addKv(basic, "调度轮次", `${status.health.tickCount} 次`);
    addKv(basic, "内存占用", `${Math.round(status.health.rssBytes / 1024 / 1024)} MB`);
    if (status.health.nextDueAt) {
      addKv(basic, "下次待投递", fmtDateTime(status.health.nextDueAt));
    }
  }
  addKv(basic, "时区", status.timeZone);
  // 系统通知要如实说"能不能显示"，而不是"API 支不支持"。
  // 开发版应用在 macOS 上被系统拒绝投递，说"支持"会让用户以为坏了。
  addKv(
    basic,
    "系统通知",
    status.systemNotificationOk ? "可用" : "不可用（改用窗口提醒）",
  );
  if (!status.systemNotificationOk && status.systemNotificationDetail) {
    const dt = el("dt", "", "");
    const dd = el("dd", "");
    // 原因单独一行展示，便于判断是否需要正式打包签名
    dd.textContent = status.systemNotificationDetail;
    dd.classList.add("hint");
    basic.appendChild(dt);
    basic.appendChild(dd);
  }

  // 渠道
  const channels = $("channel-list");
  channels.textContent = "";
  if (status.channels.length === 0) {
    channels.appendChild(el("li", "channel-item", "（后台未运行，无法探测）"));
  }
  for (const c of status.channels) {
    const li = el("li", "channel-item");
    li.appendChild(el("span", "name", c.channel));
    li.appendChild(el("span", "detail", c.detail));
    li.appendChild(el("span", `state ${c.ok ? "ok" : "bad"}`, c.ok ? "可用" : "不可用"));
    channels.appendChild(li);
  }

  // 路径
  const paths = $("diag-paths");
  paths.textContent = "";
  addKv(paths, "应用版本", status.appVersion);
  addKv(paths, "数据目录", status.dataDir);
  addKv(paths, "数据库", status.dbFile);
}

// ── 标签页切换 ──────────────────────────────────────────────────────────

function switchTab(name) {
  state.tab = name;
  for (const tab of document.querySelectorAll(".tab")) {
    tab.classList.toggle("active", tab.dataset.tab === name);
  }
  for (const panel of document.querySelectorAll(".panel")) {
    panel.classList.toggle("active", panel.id === `panel-${name}`);
  }
  // 切到某个页时按需拉数据（避免启动时全部请求）
  if (name === "history") void refreshHistory();
  if (name === "settings") {
    void refreshStatus();
    void loadAutostart();
    void refreshSystemHealth({ silent: true });
    // 设置页的每张卡片都必须在切页时重新拉取；只在启动时加载会导致
    // "重启后显示成初始化状态"（模型/知识库/监测器都是独立 RPC）。
    void loadWeather();
    void loadEmailMonitor();
    void loadCalendar();
    void loadNotify();
    void loadBriefing();
    void loadLlm();
    void loadLlmAudit();
    void loadKnowledge();
    void loadMonitorStatus();
    void loadSkillList();
  }
}

for (const tab of document.querySelectorAll(".tab")) {
  tab.addEventListener("click", () => switchTab(tab.dataset.tab));
}

// ── 新建提醒对话框 ──────────────────────────────────────────────────────

const dialog = $("new-dialog");

/** 当前正在编辑的任务 id；null 表示新建 */
let editingTaskId = null;

/** 新建对话框的默认时间：下一个 09:00 */
function defaultFireDateTime() {
  const now = new Date();
  const target = new Date(now);
  target.setHours(9, 0, 0, 0);
  if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
  const p2 = (n) => String(n).padStart(2, "0");
  return {
    date: `${target.getFullYear()}-${p2(target.getMonth() + 1)}-${p2(target.getDate())}`,
    time: "09:00",
  };
}

function openNewDialog() {
  editingTaskId = null;
  $("form-error").classList.add("hidden");
  $("dialog-title").textContent = "新建提醒";
  $("btn-submit").textContent = "创建";
  $("f-title").value = "";
  $("f-notes").value = "";
  $("f-repeat").value = "once";
  $("f-monthday").value = "1";
  $("f-interval").value = "30";
  $("f-rrule").value = "";
  $("f-important").checked = false;
  $("f-dnd-override").value = "inherit";
  const d = defaultFireDateTime();
  $("f-date").value = d.date;
  $("f-time").value = d.time;
  state.selectedWeekdays = new Set([1]);
  for (const b of picker.querySelectorAll("button")) b.classList.toggle("on", b.dataset.day === "1");
  syncRepeatFields();
  dialog.showModal();
}

/** 编辑：从 daemon 拉完整任务并回填对话框 */
async function openEditDialog(id) {
  try {
    const task = await window.aegis.getTask(id);
    editingTaskId = task.id;
    $("form-error").classList.add("hidden");
    $("dialog-title").textContent = "编辑提醒";
    $("btn-submit").textContent = "保存";
    $("f-title").value = task.title;
    $("f-notes").value = task.notes ?? "";
    $("f-date").value = task.firstFireAtWall.slice(0, 10);
    $("f-time").value = task.firstFireAtWall.slice(11, 16);
    $("f-repeat").value = task.repeat.mode;
    $("f-rrule").value = task.repeat.rrule ?? "";
    $("f-monthday").value = String(task.repeat.byMonthDay ?? 1);
    $("f-interval").value = String(task.repeat.intervalMinutes ?? 30);
    $("f-important").checked = task.priority === "important";
    $("f-dnd-override").value = task.dndOverride;
    state.selectedWeekdays = new Set(task.repeat.byWeekday ?? [1]);
    for (const b of picker.querySelectorAll("button")) {
      b.classList.toggle("on", state.selectedWeekdays.has(Number(b.dataset.day)));
    }
    syncRepeatFields();
    dialog.showModal();
  } catch (err) {
    showBanner(`读取提醒失败：${err.message}`, "err");
  }
}

$("btn-new").addEventListener("click", openNewDialog);
$("btn-cancel").addEventListener("click", () => dialog.close());
dialog.addEventListener("close", () => {
  editingTaskId = null;
});

// 星期选择器（只在 weekly 模式下显示）
const WEEKDAY_NAMES = ["一", "二", "三", "四", "五", "六", "日"];
const picker = $("weekday-picker");
for (let d = 1; d <= 7; d++) {
  const b = el("button", "", WEEKDAY_NAMES[d - 1]);
  b.type = "button";
  b.dataset.day = String(d);
  b.classList.toggle("on", state.selectedWeekdays.has(d));
  b.addEventListener("click", () => {
    if (state.selectedWeekdays.has(d)) state.selectedWeekdays.delete(d);
    else state.selectedWeekdays.add(d);
    b.classList.toggle("on", state.selectedWeekdays.has(d));
  });
  picker.appendChild(b);
}

/** 按重复模式显示/隐藏附加参数 */
function syncRepeatFields() {
  const mode = $("f-repeat").value;
  $("sub-weekly").classList.toggle("hidden", mode !== "weekly");
  $("sub-monthly").classList.toggle("hidden", mode !== "monthly");
  $("sub-interval").classList.toggle("hidden", mode !== "every_minutes");
  $("sub-rrule").classList.toggle("hidden", mode !== "custom_rrule");
}

$("f-repeat").addEventListener("change", syncRepeatFields);

/**
 * 根据表单构造墙上时间。
 *
 * 注意：这里以**本地时区**生成 `YYYY-MM-DDTHH:mm`，
 * 与 daemon 侧的 `tzid: system` 语义一致。
 */
function buildFireAtWall() {
  const date = $("f-date").value;
  const time = $("f-time").value;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("请选择触发日期");
  if (!/^\d{2}:\d{2}$/.test(time)) throw new Error("请选择触发时间");
  return `${date}T${time}`;
}

$("new-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const errBox = $("form-error");
  errBox.classList.add("hidden");

  const title = $("f-title").value.trim();
  if (!title) {
    errBox.textContent = "标题不能为空";
    errBox.classList.remove("hidden");
    return;
  }

  const mode = $("f-repeat").value;
  const repeat = { mode };

  if (mode === "weekly") {
    const days = [...state.selectedWeekdays].sort((a, b) => a - b);
    if (days.length === 0) {
      errBox.textContent = "请至少选择一天";
      errBox.classList.remove("hidden");
      return;
    }
    repeat.byWeekday = days;
  }
  if (mode === "monthly") {
    const day = Number($("f-monthday").value);
    if (!Number.isInteger(day) || day < 1 || day > 31) {
      errBox.textContent = "每月日期需为 1-31";
      errBox.classList.remove("hidden");
      return;
    }
    repeat.byMonthDay = day;
  }
  if (mode === "every_minutes") {
    const n = Number($("f-interval").value);
    if (!Number.isInteger(n) || n < 1) {
      errBox.textContent = "间隔需为正整数分钟";
      errBox.classList.remove("hidden");
      return;
    }
    repeat.intervalMinutes = n;
  }
  if (mode === "custom_rrule") {
    const rrule = $("f-rrule").value.trim();
    if (!rrule) {
      errBox.textContent = "请输入 RRULE";
      errBox.classList.remove("hidden");
      return;
    }
    repeat.rrule = rrule;
  }

  let firstFireAtWall;
  try {
    firstFireAtWall = buildFireAtWall();
  } catch (err) {
    errBox.textContent = err.message;
    errBox.classList.remove("hidden");
    return;
  }

  const submit = $("btn-submit");
  const wasEditing = editingTaskId !== null;
  submit.disabled = true;
  submit.textContent = wasEditing ? "保存中…" : "创建中…";

  const payload = {
    title,
    ...($("f-notes").value.trim() ? { notes: $("f-notes").value.trim() } : {}),
    priority: $("f-important").checked ? "important" : "normal",
    firstFireAtWall,
    repeat,
    dndOverride: $("f-dnd-override").value,
  };

  try {
    if (wasEditing && editingTaskId) {
      await window.aegis.updateTask({ id: editingTaskId, ...payload });
    } else {
      await window.aegis.createTask(payload);
    }
    dialog.close();
    showToast(wasEditing ? "提醒已保存" : "提醒已创建");
    await refreshTasks();
    await refreshStatus();
  } catch (err) {
    errBox.textContent = err.message;
    errBox.classList.remove("hidden");
  } finally {
    submit.disabled = false;
    submit.textContent = wasEditing ? "保存" : "创建";
  }
});

// ── 顶部与工具栏动作 ────────────────────────────────────────────────────

$("btn-test-notify").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  try {
    await window.aegis.testNotify();
    if (state.tab === "history") await refreshHistory();
  } catch (err) {
    showBanner(`测试通知失败：${err.message}`, "err");
  } finally {
    btn.disabled = false;
  }
});

$("btn-pause-all").addEventListener("click", async () => {
  try {
    await window.aegis.pauseAll();
    await refreshTasks();
  } catch (err) {
    showBanner(`暂停失败：${err.message}`, "err");
  }
});

$("btn-resume-all").addEventListener("click", async () => {
  try {
    await window.aegis.resumeAll();
    await refreshTasks();
  } catch (err) {
    showBanner(`恢复失败：${err.message}`, "err");
  }
});

$("btn-refresh-history").addEventListener("click", () => void refreshHistory());

$("btn-export-backup").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  const hint = $("backup-hint");
  const original = hint.textContent;
  btn.disabled = true;
  hint.textContent = "正在导出…";
  try {
    const r = await window.aegis.exportBackup();
    if (r.canceled) {
      hint.textContent = original;
      return;
    }
    hint.textContent = `已导出 ${r.files} 个文件（${formatBytes(r.totalBytes)}）：${r.outDir}`;
    showToast("备份已导出");
  } catch (err) {
    hint.textContent = `导出失败：${err.message}`;
    showBanner(`备份导出失败：${err.message}`, "err");
  } finally {
    btn.disabled = false;
  }
});

$("btn-check-update").addEventListener("click", async () => {
  const box = $("update-text");
  try {
    const info = await window.aegis.checkUpdate();
    box.textContent = info.message;
    box.classList.remove("hidden");
  } catch (err) {
    box.textContent = `检查失败：${err.message}`;
    box.classList.remove("hidden");
  }
});


// ── 应用内强提醒（系统通知不可用时的兜底） ──────────────────────────────

/**
 * 显示一条需要用户确认的提醒。
 *
 * 与普通 toast 的区别：**不会自动消失**。它是系统通知的替代品，
 * 自动消失就等于"提醒没送达"。用户可以点"知道了"关闭。
 */
let toastTimer = null;

/** 短暂提示（不打断操作）；用于"已推迟""再按一次 ⌘Q"等反馈 */
function showToast(text, ms = 3000) {
  const toast = $("toast");
  if (!toast) return;
  toast.textContent = text;
  toast.classList.remove("hidden");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.add("hidden");
    toastTimer = null;
  }, ms);
}

/**
 * 显示一条需要用户处理的提醒。
 *
 * 与普通 toast 的区别：**不会自动消失**。它是系统通知的替代品，
 * 自动消失就等于"提醒没送达"。带 occurrenceId 时提供两个出口：
 *   - 完成：结束当前这条（一次性提醒不再出现，重复提醒只结束本次）
 *   - 稍后提醒：从**现在**起 N 分钟后再提醒（默认 5 分钟，可改）
 */
function showAlert(payload) {
  const stack = $("alert-stack");
  if (!stack) return;

  const card = el("div", "alert-card");

  const head = el("div", "alert-head");
  head.appendChild(el("span", "alert-icon", "🔔"));
  head.appendChild(el("span", "alert-title", payload.title || "提醒"));
  card.appendChild(head);

  if (payload.body) {
    card.appendChild(el("div", "alert-body", payload.body));
  }

  // 说明为什么是窗口提醒而不是系统通知 —— 否则用户会疑惑"为什么不是弹窗"
  if (state.status && state.status.systemNotificationOk === false) {
    card.appendChild(
      el("div", "alert-note", "系统通知当前不可用，已用窗口提醒替代（开发版应用未经签名）"),
    );
  }

  const actions = el("div", "alert-actions");
  const occurrenceId = typeof payload.occurrenceId === "string" ? payload.occurrenceId : "";

  if (occurrenceId) {
    const error = el("div", "alert-error hidden");

    const minutes = document.createElement("input");
    minutes.type = "number";
    minutes.min = "1";
    minutes.max = "1440";
    minutes.value = "5";
    minutes.className = "snooze-minutes";
    minutes.setAttribute("aria-label", "稍后提醒的分钟数");

    const unit = el("span", "snooze-unit", "分钟后");
    const snoozeBtn = el("button", "btn btn-ghost", "稍后提醒");
    const doneBtn = el("button", "btn btn-primary", "完成");
    const controls = [minutes, snoozeBtn, doneBtn];
    const setBusy = (busy) => {
      for (const control of controls) control.disabled = busy;
    };

    const run = async (action, successText) => {
      setBusy(true);
      error.classList.add("hidden");
      try {
        await action();
        card.remove();
        showToast(successText);
        if (state.tab === "history") void refreshHistory();
      } catch (err) {
        error.textContent = `操作失败：${err instanceof Error ? err.message : String(err)}`;
        error.classList.remove("hidden");
        setBusy(false);
      }
    };

    doneBtn.addEventListener("click", () => {
      void run(() => window.aegis.completeOccurrence(occurrenceId), "已完成");
    });
    snoozeBtn.addEventListener("click", () => {
      const m = Number(minutes.value);
      if (!Number.isInteger(m) || m < 1 || m > 1440) {
        error.textContent = "请输入 1–1440 分钟";
        error.classList.remove("hidden");
        return;
      }
      void run(() => window.aegis.snoozeOccurrence(occurrenceId, m), `已推迟 ${m} 分钟`);
    });

    actions.appendChild(minutes);
    actions.appendChild(unit);
    actions.appendChild(snoozeBtn);
    actions.appendChild(doneBtn);
    card.appendChild(error);
    card.appendChild(actions);
  } else {
    // 测试通知/系统失败通知没有 occurrence：只提供关闭
    const dismiss = el("button", "btn btn-primary", "知道了");
    dismiss.addEventListener("click", () => card.remove());
    actions.appendChild(dismiss);
    card.appendChild(actions);
  }

  stack.appendChild(card);

  // 提醒出现时把窗口标题闪一下，进一步引起注意
  document.title = `🔔 ${payload.title || "提醒"} — Aegis`;
  setTimeout(() => {
    document.title = "Aegis";
  }, 4000);
}

// ── 事件订阅与初始化 ────────────────────────────────────────────────────

// 主进程要求刷新（daemon 状态变化、任务/通知变更）
window.aegis.onRefresh(() => {
  void refreshStatus();
  if (state.tab === "tasks") void refreshTasks();
  if (state.tab === "history") void refreshHistory();
});

window.aegis.onDaemonState(() => {
  void refreshStatus();
});

window.aegis.onAlert((payload) => {
  showAlert(payload);
  // 提醒同时刷新历史，让用户能立刻在"历史"里看到这条
  if (state.tab === "history") void refreshHistory();
});

// 主进程收到第一次 ⌘Q：提示再按一次；第二次才真正退出
window.aegis.onQuitArmed((seconds) => {
  showToast(`再按一次 ⌘Q 完全退出（含后台服务），${seconds} 秒内有效`, seconds * 1000);
});


// ── 首次启动向导 ────────────────────────────────────────────────────────

const wizard = {
  step: 1,
  total: 3,
  /** 首次查询结果（含是否受支持通知） */
  info: null,
};

function wizardGo(step) {
  wizard.step = Math.max(1, Math.min(wizard.total, step));

  for (const pane of document.querySelectorAll(".wizard-pane")) {
    pane.classList.toggle("active", Number(pane.dataset.pane) === wizard.step);
  }
  for (const dot of document.querySelectorAll(".wizard-step")) {
    const n = Number(dot.dataset.step);
    dot.classList.toggle("active", n === wizard.step);
    dot.classList.toggle("done", n < wizard.step);
  }

  $("wizard-prev").classList.toggle("hidden", wizard.step === 1);
  $("wizard-next").textContent = wizard.step === wizard.total ? "开始使用" : "下一步";
  $("wizard-error").classList.add("hidden");
}

/** 打开向导（仅在首次配置时调用） */
async function openWizard() {
  try {
    wizard.info = await window.aegis.getOnboarding();
  } catch (err) {
    // 读不到就不弹向导 —— 不能因为"配置读取失败"把用户挡在门外
    console.warn("读取首次配置状态失败", err);
    return;
  }
  if (!wizard.info.needed) return;

  // 时区展示：让用户明确"触发时间按哪个时区算"
  $("wizard-tz").textContent = `提醒时间按本机时区（${wizard.info.timeZone}）计算。`;

  // 通知状态：必须按"实际能不能显示"来说，而不是 API 是否存在
  const status = $("wizard-notify-status");
  if (wizard.info.systemNotificationOk) {
    status.className = "wizard-status ok";
    status.textContent = "系统通知可用。建议点下面的按钮确认一次。";
  } else {
    status.className = "wizard-status warn";
    status.textContent =
      "系统通知暂时不可用（开发版应用未签名，macOS 不允许投递）。" +
      "此时提醒会用「窗口提醒」送达：窗口弹到最前、响一声、并显示一条需要你确认的横幅。";
  }

  // 自启状态
  $("wizard-autostart").checked = true;
  if (wizard.info.autostartEnabled) {
    $("wizard-autostart-hint").textContent = "已开启。关闭窗口不会停止提醒。";
  }

  wizardGo(1);
  $("wizard-dialog").showModal();
}

$("wizard-prev").addEventListener("click", () => wizardGo(wizard.step - 1));

$("wizard-test-notify").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  const status = $("wizard-notify-status");
  btn.disabled = true;
  status.className = "wizard-status";
  status.textContent = "正在发送…";
  try {
    await window.aegis.testNotify();
    status.className = "wizard-status ok";
    status.textContent = "已发送。如果你看到了通知，说明通道正常。";
  } catch (err) {
    status.className = "wizard-status bad";
    status.textContent = `发送失败：${err.message}`;
  } finally {
    btn.disabled = false;
  }
});

$("wizard-next").addEventListener("click", async (e) => {
  if (wizard.step < wizard.total) {
    wizardGo(wizard.step + 1);
    return;
  }

  // 最后一步 → 保存
  const btn = e.currentTarget;
  const errBox = $("wizard-error");
  btn.disabled = true;
  btn.textContent = "保存中…";

  try {
    const r = await window.aegis.completeOnboarding({
      autostart: $("wizard-autostart").checked,
    });
    if (!r.ok) {
      errBox.textContent = r.detail;
      errBox.classList.remove("hidden");
      return;
    }
    $("wizard-dialog").close();
    // 自启失败时 r.ok 仍为 true（不阻塞使用），但 detail 说明了原因
    if (r.detail && !r.detail.includes("配置完成")) {
      showBanner(r.detail, "warn");
    }
    await refreshStatus();
  } catch (err) {
    errBox.textContent = err.message;
    errBox.classList.remove("hidden");
  } finally {
    btn.disabled = false;
    btn.textContent = "开始使用";
  }
});

/** 启动：先拿状态（决定是否显示横幅），再拉列表 */
async function init() {
  // 初始页签可由 `?tab=history` 指定（深链接与截图测试共用这条通道）
  const initial = new URLSearchParams(location.search).get("tab");
  if (initial && ["tasks", "history", "settings"].includes(initial)) {
    switchTab(initial);
  }

  await refreshStatus();
  void loadDnd();
  void loadAutostart();
  startHealthPolling();
  await refreshTasks();

  // 首次配置向导：只在没配过时弹。
  // 截图模式下跳过（否则截图全是向导）。
  if (!new URLSearchParams(location.search).get("capture")) {
    void openWizard();
  }
  // 每 15 秒轮询状态：daemon 的 uptime / tick 会变，且能发现"悄悄挂了"
  setInterval(() => {
    void refreshStatus();
  }, 15_000);
}

void init();
