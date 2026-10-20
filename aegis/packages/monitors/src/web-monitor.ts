/**
 * 网页 / RSS 监测器（M2 / PRD FR-B3）
 *
 * 当前切片支持两种模式：
 *   - page：抓取页面，提取标题 + 可见文本，规范化后做指纹；内容真正变化才产生事实；
 *   - rss：解析 RSS/Atom 的 item/entry，出现新条目时逐条产生事实。
 *
 * 刻意不引入 HTML/XML 解析依赖：M2 先保证"变化检测 + 失败可见"，
 * CSS 选择器/JSONPath 与完整 XML 解析在后续迭代补齐。
 */

import { createHash } from "node:crypto";
import { type Clock, SystemClock } from "@aegis/clock";
import type { Monitor, MonitorError, MonitorFact, MonitorScanResult } from "./types.js";

/** 网页监测模式 */
export type WebMonitorMode = "page" | "rss";

/** 网页监测器配置 */
export interface WebMonitorOptions {
  id: string;
  url: string;
  mode?: WebMonitorMode;
  clock?: Clock;
  /** 测试注入；默认使用全局 fetch */
  fetchImpl?: typeof fetch;
  /** 响应体上限（字符），避免把巨大页面读进内存；默认 2MB */
  maxChars?: number;
}

/** RSS/Atom 条目的最小字段集 */
interface FeedItem {
  id: string;
  title: string;
  link: string;
}

/** 实体解码只覆盖最常见的几种，避免引入完整 XML 库 */
function decodeEntities(input: string): string {
  return input
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/** 去掉标签并压缩空白 */
function textOf(input: string): string {
  return decodeEntities(input.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/** 页面规范化：标题 + 可见文本；动态脚本/样式不参与指纹 */
function normalizePage(html: string): { title: string; text: string } {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "";
  const text = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  return { title: textOf(title), text: textOf(text) };
}

/** 从 RSS `<item>` / Atom `<entry>` 中提取 id/title/link */
function parseFeedItems(xml: string): FeedItem[] {
  const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) ?? [];
  const items: FeedItem[] = [];
  for (const block of blocks) {
    const title = textOf(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(block)?.[1] ?? "");
    const link =
      textOf(/<link[^>]*>([\s\S]*?)<\/link>/i.exec(block)?.[1] ?? "") ||
      (/<link[^>]*href=["']([^"']+)["'][^>]*\/?>/i.exec(block)?.[1] ?? "");
    const id =
      textOf(/<guid[^>]*>([\s\S]*?)<\/guid>/i.exec(block)?.[1] ?? "") ||
      textOf(/<id[^>]*>([\s\S]*?)<\/id>/i.exec(block)?.[1] ?? "") ||
      link ||
      title;
    if (!id) continue;
    items.push({ id, title, link });
  }
  return items;
}

/** 网页/RSS 监测器实现 */
export class WebMonitor implements Monitor {
  readonly id: string;
  readonly permission = "network.read" as const;
  readonly #url: string;
  readonly #mode: WebMonitorMode;
  readonly #clock: Clock;
  readonly #fetch: typeof fetch;
  readonly #maxChars: number;
  #lastPageHash: string | null = null;
  #seenItems: Set<string> | null = null;
  #baselineDone = false;

  constructor(options: WebMonitorOptions) {
    this.id = options.id;
    this.#url = options.url;
    this.#mode = options.mode ?? "page";
    this.#clock = options.clock ?? new SystemClock();
    this.#fetch = options.fetchImpl ?? fetch;
    this.#maxChars = options.maxChars ?? 2_000_000;
  }

  /** 抓取一次并检测变化；首次扫描只建基线 */
  async scan(): Promise<MonitorScanResult> {
    const errors: MonitorError[] = [];
    const facts: MonitorFact[] = [];
    const at = this.#clock.wall();

    let response: Response;
    try {
      response = await this.#fetch(this.#url, {
        headers: { "user-agent": "Aegis-Monitor/0.1" },
        signal: AbortSignal.timeout(10_000),
        redirect: "follow",
      });
    } catch (err) {
      errors.push({ path: this.#url, message: `请求失败：${(err as Error).message}` });
      return { facts, errors };
    }

    if (!response.ok) {
      errors.push({ path: this.#url, message: `HTTP ${response.status}` });
      return { facts, errors };
    }

    let body: string;
    try {
      body = (await response.text()).slice(0, this.#maxChars);
    } catch (err) {
      errors.push({ path: this.#url, message: `读取响应失败：${(err as Error).message}` });
      return { facts, errors };
    }

    if (this.#mode === "rss") {
      const items = parseFeedItems(body);
      if (!this.#baselineDone) {
        this.#seenItems = new Set(items.map((i) => i.id));
        this.#baselineDone = true;
        return { facts, errors };
      }
      const seen = this.#seenItems ?? new Set<string>();
      for (const item of items) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        facts.push({
          monitor: this.id,
          kind: "web.changed",
          at,
          fields: { url: this.#url, item_id: item.id, title: item.title, link: item.link },
        });
      }
      this.#seenItems = seen;
      return { facts, errors };
    }

    const page = normalizePage(body);
    const hash = createHash("sha256").update(`${page.title}\n${page.text}`).digest("hex");
    if (!this.#baselineDone) {
      this.#lastPageHash = hash;
      this.#baselineDone = true;
      return { facts, errors };
    }
    if (hash !== this.#lastPageHash) {
      this.#lastPageHash = hash;
      facts.push({
        monitor: this.id,
        kind: "web.changed",
        at,
        fields: {
          url: this.#url,
          fingerprint: hash,
          title: page.title,
          excerpt: page.text.slice(0, 500),
        },
      });
    }
    return { facts, errors };
  }
}
