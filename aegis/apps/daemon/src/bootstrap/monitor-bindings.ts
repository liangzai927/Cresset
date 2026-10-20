/**
 * 把 config.monitors 构造成运行时绑定。
 *
 * 校验顺序（任何一步失败都记录并跳过该实例，不静默）：
 *   1. 加载 YAML Skill；
 *   2. Skill 的 trigger.monitor 必须等于实例 id；
 *   3. Skill 必须声明监测器所需权限。
 */

import { homedir } from "node:os";
import { resolve } from "node:path";
import type { Clock } from "@aegis/clock";
import { FileMonitor, SystemMonitor, WebMonitor } from "@aegis/monitors";
import { loadSkillFile, type Skill } from "@aegis/skills";
import type { DaemonConfig } from "./config.js";
import type { MonitorBinding, MonitorLog } from "./monitor-runtime.js";

/** 展开 `~/`；配置文件里的下载目录通常写 `~/Downloads` */
function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : path;
}

/** 一个 config.monitors 元素 */
type MonitorConfig = DaemonConfig["monitors"][number];

/** 构造全部绑定；失败项写日志后跳过 */
export function buildMonitorBindings(
  configs: MonitorConfig[],
  dataDir: string,
  clock: Clock,
  log: MonitorLog,
): MonitorBinding[] {
  const bindings: MonitorBinding[] = [];

  for (const cfg of configs) {
    if (!cfg.enabled) {
      log("info", "monitor.disabled", { monitor: cfg.id });
      continue;
    }
    const skills: Skill[] = [];
    for (const path of cfg.skills) {
      try {
        const skill = loadSkillFile(resolve(dataDir, path));
        if (skill.trigger.monitor !== cfg.id) {
          log("error", "monitor.skill_mismatch", {
            monitor: cfg.id,
            skill: skill.name,
            triggerMonitor: skill.trigger.monitor,
          });
          continue;
        }
        skills.push(skill);
      } catch (err) {
        log("error", "monitor.skill_load_failed", { monitor: cfg.id, path, error: (err as Error).message });
      }
    }
    if (skills.length === 0) {
      log("warn", "monitor.no_skills", { monitor: cfg.id });
      continue;
    }

    const monitor =
      cfg.kind === "files"
        ? new FileMonitor({
            id: cfg.id,
            root: resolve(dataDir, expandHome(cfg.root)),
            patterns: cfg.patterns,
            ignore: cfg.ignore,
            stableMs: cfg.stableMs,
            clock,
          })
        : cfg.kind === "web"
          ? new WebMonitor({
              id: cfg.id,
              url: cfg.url,
              mode: cfg.mode,
              ...(cfg.selector ? { selector: cfg.selector } : {}),
              ...(cfg.jsonPath ? { jsonPath: cfg.jsonPath } : {}),
              clock,
            })
          : new SystemMonitor({ id: cfg.id, clock });

    const permitted = skills.filter((skill) => {
      if (skill.permissions.includes(monitor.permission)) return true;
      log("error", "monitor.skill_permission_denied", {
        monitor: cfg.id,
        skill: skill.name,
        required: monitor.permission,
        declared: skill.permissions,
      });
      return false;
    });
    if (permitted.length === 0) continue;

    bindings.push({
      monitor,
      kind: cfg.kind,
      skills: permitted,
      intervalMs: Math.max(1_000, cfg.intervalS * 1_000),
    });
    log("info", "monitor.bound", {
      monitor: cfg.id,
      kind: cfg.kind,
      skills: permitted.map((s) => s.name),
      intervalS: cfg.intervalS,
    });
  }

  return bindings;
}
