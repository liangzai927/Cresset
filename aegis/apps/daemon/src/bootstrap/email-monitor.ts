/**
 * IMAP 重要邮件监测（M3）
 *
 * 当前是**规则筛选**：发件人白名单 OR 主题关键词。没有 LLM 语义判断；
 * 这是为了避免把整个收件箱外发给模型，也便于先验证 IMAP 链路。
 *
 * 只在轮询时读取未读邮件的 envelope（发件人/主题），不下载正文/附件。
 * 密码从钥匙串读取；日志/通知里不出现密码。
 */

import type { Clock } from "@aegis/clock";
import type { Scheduler } from "@aegis/scheduler";
import type { SecretStore } from "@aegis/secrets";
import { ImapFlow } from "imapflow";
import { loadConfig } from "./config.js";
import { EMAIL_IMAP_PASSWORD_KEY } from "./notify-secrets.js";

/** 邮件头最小信息 */
export interface EmailHeader {
  uid: number;
  from: string;
  subject: string;
}

/** 规则配置 */
export interface EmailRules {
  senders: string[];
  keywords: string[];
}

/** 判断一封邮件是否重要（规则版） */
export function isImportantEmail(header: EmailHeader, rules: EmailRules): boolean {
  if (rules.senders.length === 0 && rules.keywords.length === 0) return false;
  const from = header.from.toLowerCase();
  if (rules.senders.some((s) => s.trim() && from.includes(s.trim().toLowerCase()))) return true;
  const subject = header.subject.toLowerCase();
  return rules.keywords.some((k) => k.trim() && subject.includes(k.trim().toLowerCase()));
}

/** 判断邮件内部日期是否在最近 N 天内；缺失日期按“不处理”处理 */
export function isEmailWithinDays(
  internalDate: Date | string | undefined,
  now: number,
  sinceDays: number,
): boolean {
  if (!internalDate) return false;
  const ms = internalDate instanceof Date ? internalDate.getTime() : Date.parse(internalDate);
  if (!Number.isFinite(ms)) return false;
  return ms >= now - sinceDays * 86_400_000;
}

/** 注入点：测试可替换 IMAP 客户端 */
export interface ImapClientLike {
  connect(): Promise<void>;
  mailboxOpen(path: string): Promise<{ uidValidity?: bigint | number }>;
  search(query: { seen: boolean }, options: { uid: true }): Promise<number[] | false | undefined>;
  fetch(
    range: string,
    query: { envelope: boolean; uid: true; internalDate?: true },
    options: { uid: true },
  ): AsyncIterable<{
    uid: number;
    internalDate?: Date | string;
    envelope?: { subject?: string; from?: Array<{ address?: string }> };
  }>;
  messageFlagsAdd(range: string, flags: string[], options: { uid: true }): Promise<boolean>;
  logout(): Promise<void>;
}

/** 邮件监测服务选项 */
export interface EmailMonitorOptions {
  configFile: string;
  scheduler: Scheduler;
  clock: Clock;
  secrets: SecretStore;
  onLog: (level: "info" | "warn" | "error", event: string, detail?: unknown) => void;
  /** 可选的 LLM 语义判断；返回 null 表示不可用（不要标记已读） */
  classify?: (header: EmailHeader) => Promise<boolean | null>;
  clientFactory?: (opts: {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    pass: string;
  }) => ImapClientLike;
}

/** 邮件监测服务 */
export class EmailMonitor {
  readonly #opts: EmailMonitorOptions;
  #timer: NodeJS.Timeout | null = null;
  #polling = false;

  constructor(opts: EmailMonitorOptions) {
    this.#opts = opts;
  }

  /** 启动定时轮询；立即执行一次 */
  start(): void {
    if (this.#timer) return;
    void this.poll();
    const intervalS = loadConfig(this.#opts.configFile).config.emailMonitor.pollIntervalS;
    this.#timer = setInterval(() => void this.poll(), Math.max(60, intervalS) * 1_000);
    this.#timer.unref?.();
  }

  /** 停止轮询（不清空已生成通知） */
  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  /** 读取配置并轮询一次；失败只记录，不抛出 */
  async poll(): Promise<number> {
    if (this.#polling) return 0;
    this.#polling = true;
    try {
      const cfg = loadConfig(this.#opts.configFile).config.emailMonitor;
      if (!cfg.enabled) return 0;
      if (!cfg.host || !cfg.user || !cfg.passwordSecret) {
        this.#opts.onLog("warn", "email_monitor.missing_config");
        return 0;
      }
      let pass: string | null;
      try {
        pass = await this.#opts.secrets.get(cfg.passwordSecret);
      } catch (err) {
        this.#opts.onLog("error", "email_monitor.keychain_failed", { error: String(err) });
        return 0;
      }
      if (!pass) {
        this.#opts.onLog("warn", "email_monitor.no_password");
        return 0;
      }
      const client =
        this.#opts.clientFactory?.({
          host: cfg.host,
          port: cfg.port,
          secure: cfg.secure,
          user: cfg.user,
          pass,
        }) ??
        (new ImapFlow({
          host: cfg.host,
          port: cfg.port,
          secure: cfg.secure,
          auth: { user: cfg.user, pass },
          logger: false,
        }) as unknown as ImapClientLike);
      let count = 0;
      try {
        await client.connect();
        const mailbox = await client.mailboxOpen(cfg.mailbox);
        const uids = await client.search({ seen: false }, { uid: true });
        if (!uids || uids.length === 0) return 0;
        const selected = uids.slice(-cfg.maxPerPoll);
        const rules: EmailRules = { senders: cfg.senders, keywords: cfg.keywords };
        const toMark: number[] = [];
        for await (const msg of client.fetch(
          selected.join(","),
          { envelope: true, uid: true },
          { uid: true },
        )) {
          const from = (msg.envelope?.from ?? [])
            .map((a) => a.address ?? "")
            .filter(Boolean)
            .join(", ");
          const subject = msg.envelope?.subject ?? "(无主题)";
          let important = isImportantEmail({ uid: msg.uid, from, subject }, rules);
          let undecided = false;
          if (!important && cfg.useLlm && this.#opts.classify) {
            const verdict = await this.#opts.classify({ uid: msg.uid, from, subject });
            if (verdict === null) {
              undecided = true;
              this.#opts.onLog("warn", "email_monitor.llm_undecided", { uid: msg.uid });
            } else {
              important = verdict;
            }
          }
          if (important) {
            const created = this.#opts.scheduler.daos.notifications.createWithOutbox({
              kind: "monitor",
              title: `重要邮件：${subject}`,
              body: `发件人：${from || "未知"}\n${cfg.mailbox} · 未读`,
              priority: "high",
              scheduledFor: this.#opts.clock.wall(),
              dedupeKey: `email:${String(mailbox.uidValidity ?? 0)}:${msg.uid}`,
            });
            if (created.created) count += 1;
          }
          if (!undecided) toMark.push(msg.uid);
        }
        if (toMark.length > 0) {
          try {
            await client.messageFlagsAdd(toMark.join(","), ["\\Seen"], { uid: true });
          } catch (err) {
            this.#opts.onLog("warn", "email_monitor.mark_seen_failed", { error: String(err) });
          }
        }
      } finally {
        await client.logout().catch(() => {
          /* 注销失败不影响本轮结果 */
        });
      }
      return count;
    } catch (err) {
      this.#opts.onLog("error", "email_monitor.poll_failed", { error: String(err) });
      return 0;
    } finally {
      this.#polling = false;
    }
  }
}
