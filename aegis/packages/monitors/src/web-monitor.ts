/**
 * 网页 / RSS 监测器（M2 / PRD FR-B3）
 *
 * 支持三种模式：
 *   - page：抓取页面；可用 CSS selector 只监控某块内容，否则监控标题 + 可见文本；
 *   - json：抓取 JSON API；可用受限 JSONPath（`data.items[0].status`）只监控某个字段；
 *   - rss：解析 RSS/Atom 的 item/entry，出现新条目时逐条产生事实。
 *
 * HTML 解析用 node-html-parser（纯 JS，可被打包进 dist）；JSONPath 只实现
 * 点路径 + 数字下标的安全子集，不执行任意表达式。
 */

import { createHash } from "node:crypto";
import { type Clock, SystemClock } from "@aegis/clock";
import { parse as parseHtml } from "node-html-parser";
import type { Monitor, MonitorError, MonitorFact, MonitorScanResult } from "./types.js";

/** 网页监测模式 */
export type WebMonitorMode = "page" | "json" | "rss";

/** 网页监测器配置 */
export interface WebMonitorOptions {
  id: string;
  url: string;
  mode?: WebMonitorMode;
  /** page 模式的 CSS 选择器；为空时监控整页标题 + 可见文本 */
  selector?: string;
  /** json 模式的受限 JSONPath，如 data.items[0].status */
  jsonPath?: string;
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

/**
 * 受限 JSONPath：只支持 `a.b[0].c` 形式。
 *
 * 不引入 jsonpath 依赖、也不执行表达式 —— 监测配置来自 YAML，
 * 不能获得任意代码执行能力。字段不存在时抛错，由 scan 转成 errors。
 */
function readJsonPath(root: unknown, path: string): unknown {
  const clean = path.trim().replace(/^\$\.?/, "");
  if (!clean) return root;
  let current: unknown = root;
  for (const segment of clean.split(".")) {
    if (!segment) continue;
    const m = /^([^[\]]+)(?:\[(\d+)\])?$/.exec(segment);
    if (!m) throw new Error(`不支持的 JSONPath 片段：${segment}`);
    const [, key, index] = m;
    if (key) {
      if (typeof current !== "object" || current === null || !(key in current)) {
        throw new Error(`JSONPath 字段不存在：${key}`);
      }
      current = (current as Record<string, unknown>)[key];
    }
    if (index !== undefined) {
      if (!Array.isArray(current)) throw new Error(`JSONPath 下标用在非数组：${segment}`);
      const i = Number(index);
      if (i >= current.length) throw new Error(`JSONPath 下标越界：${segment}`);
      current = current[i];
    }
  }
  return current;
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
  readonly #selector: string | undefined;
  readonly #jsonPath: string | undefined;
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
    this.#selector = options.selector;
    this.#jsonPath = options.jsonPath;
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

    if (this.#mode === "json") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch (err) {
        errors.push({ path: this.#url, message: `JSON 解析失败：${(err as Error).message}` });
        return { facts, errors };
      }
      let selected: unknown;
      try {
        selected = this.#jsonPath ? readJsonPath(parsed, this.#jsonPath) : parsed;
      } catch (err) {
        errors.push({ path: this.#url, message: (err as Error).message });
        return { facts, errors };
      }
      const normalized = JSON.stringify(selected);
      const hash = createHash("sha256").update(normalized).digest("hex");
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
            json_path: this.#jsonPath ?? "$",
            excerpt: normalized.slice(0, 500),
          },
        });
      }
      return { facts, errors };
    }

    let title: string;
    let text: string;
    if (this.#selector) {
      try {
        const root = parseHtml(body);
        const nodes = root.querySelectorAll(this.#selector);
        if (nodes.length === 0) throw new Error(`CSS 选择器没有匹配：${this.#selector}`);
        title = textOf(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1] ?? "");
        text = nodes
          .map((n) => n.textContent)
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
      } catch (err) {
        errors.push({ path: this.#url, message: (err as Error).message });
        return { facts, errors };
      }
    } else {
      const page = normalizePage(body);
      title = page.title;
      text = page.text;
    }

    const hash = createHash("sha256").update(`${title}\n${text}`).digest("hex");
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
          title,
          excerpt: text.slice(0, 500),
          selector: this.#selector ?? null,
        },
      });
    }
    return { facts, errors };
  }
}
