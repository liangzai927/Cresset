/**
 * M2 默认 Skill 包
 *
 * 这些 YAML 是**内嵌字符串**，因为 daemon 打包后读不到仓库里的 examples/ 目录。
 * 安装策略是"只补缺失，不覆盖已有文件"：用户改过的 Skill 不能被升级悄悄覆盖。
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { importSkill, skillsDir } from "./skill-store.js";

/** 一个内置 Skill 示例 */
export interface DefaultSkill {
  filename: string;
  content: string;
}

/** 默认技能包：覆盖系统、文件、网页、RSS 四类监测 */
export const DEFAULT_SKILLS: DefaultSkill[] = [
  {
    filename: "disk-space-guard.yaml",
    content: `name: disk-space-guard
version: 1.0.0
description: 磁盘剩余空间低于阈值时告警
author: aegis
permissions: [system.read]
cooldown: 6h
params:
  threshold_percent: 10
trigger:
  type: threshold
  monitor: system.host
  field: disk_free_percent
  op: "<"
  value: "{{params.threshold_percent}}"
action:
  notify:
    priority: high
    title: "磁盘空间不足"
    body: "{{monitor.mount}} 剩余 {{monitor.disk_free_percent}}%（{{monitor.disk_free_gb}} GB）"
`,
  },
  {
    filename: "downloads-change.yaml",
    content: `name: downloads-change
version: 1.0.0
description: 下载目录出现新文件时通知
author: aegis
permissions: [files.read]
cooldown: 5m
params: {}
trigger:
  type: change
  monitor: files.downloads
action:
  notify:
    priority: normal
    title: "下载目录有新文件"
    body: "{{monitor.path}}（{{monitor.size}} 字节）"
`,
  },
  {
    filename: "large-file-guard.yaml",
    content: `name: large-file-guard
version: 1.0.0
description: 下载目录出现超大文件时提醒
author: aegis
permissions: [files.read]
cooldown: 30m
params:
  threshold_bytes: 104857600
trigger:
  type: threshold
  monitor: files.downloads
  field: size
  op: ">"
  value: "{{params.threshold_bytes}}"
action:
  notify:
    priority: normal
    title: "下载了超大文件"
    body: "{{monitor.path}}（{{monitor.size}} 字节）"
`,
  },
  {
    filename: "page-change.yaml",
    content: `name: page-change
version: 1.0.0
description: 网页内容变化时通知
author: aegis
permissions: [network.read]
cooldown: 10m
params: {}
trigger:
  type: change
  monitor: web.example
action:
  notify:
    priority: normal
    title: "网页内容更新"
    body: "{{monitor.title}}：{{monitor.excerpt}}"
`,
  },
  {
    filename: "rss-change.yaml",
    content: `name: rss-change
version: 1.0.0
description: RSS/Atom 出现新条目时通知
author: aegis
permissions: [network.read]
cooldown: 5m
params: {}
trigger:
  type: change
  monitor: rss.example
action:
  notify:
    priority: normal
    title: "订阅更新"
    body: "{{monitor.title}} {{monitor.link}}"
`,
  },
];

/** 安装默认包；返回安装/跳过的文件名 */
export function installDefaultSkills(dataDir: string): { installed: string[]; skipped: string[] } {
  const installed: string[] = [];
  const skipped: string[] = [];
  for (const skill of DEFAULT_SKILLS) {
    const target = join(skillsDir(dataDir), skill.filename);
    if (existsSync(target)) {
      skipped.push(skill.filename);
      continue;
    }
    importSkill(dataDir, skill.filename, skill.content);
    installed.push(skill.filename);
  }
  return { installed, skipped };
}
