/**
 * 开机自启（macOS LaunchAgent）
 *
 * ## 为什么需要它
 *
 * 本产品的核心承诺是"24 小时常驻"。若用户重启电脑后必须手动打开应用，
 * 那这个承诺就断了 —— 而且失败方式是**静默的**：用户以为提醒还在跑。
 *
 * ## 机制（R0 spike S4 已验证）
 *
 * 在 `~/Library/LaunchAgents/<label>.plist` 写一个 plist，注册后：
 *   - `RunAtLoad=true` → 登录时启动
 *   - `KeepAlive=true` → 崩溃后由 launchd 拉起（这是"崩溃自恢复"的一半）
 *
 * ## 关键设计决定：让谁自启
 *
 * 自启的是 **daemon**，不是界面。
 *
 * | 若自启界面 | 若自启 daemon |
 * | --- | --- |
 * | 用户登录就弹出一个窗口 | 静默在后台开始工作 |
 * | 关掉窗口后仍然没在跑 | 关掉窗口不影响提醒 |
 * | 需要 GUI 会话 | 无 GUI 也能运行（`--data-dir` 模式） |
 *
 * 因此 plist 里执行的是 `node <daemon入口> --data-dir <数据目录>`。
 * 界面由用户按需打开，daemon 一直在。
 *
 * ## 已知限制
 *
 * - 只实现 macOS；Windows（计划任务）与 Linux（systemd user unit）留接口（M8）
 * - `launchctl` 在受限沙箱里会失败（R0 实测 `Bootstrap failed: 5`）——
 *   因此所有操作都**返回结构化结果**而不是抛错，让界面能显示"为什么没成功"
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** 自启操作的统一结果（不抛错，便于界面展示原因） */
export interface AutostartResult {
  ok: boolean;
  /** 人话说明，失败时直接展示给用户 */
  detail: string;
}

/** 自启配置：`args` 必须包含 daemon 入口与 `--data-dir`，否则开机后会启动错的服务 */
export interface AutostartOptions {
  /** LaunchAgent 标签，如 `com.aegis.daemon` */
  label: string;
  /** 要执行的可执行文件（系统 Node 绝对路径） */
  execPath: string;
  /** 传参（如 daemon 入口与 --data-dir） */
  args: string[];
  /** 覆盖 LaunchAgents 目录（测试用） */
  launchAgentsDir?: string;
}

/** 生成 plist XML。导出以便单测断言内容而不真的写文件 */
export function buildLaunchAgentPlist(opts: AutostartOptions): string {
  /** XML 转义：路径里可能有 `&` `<` `>`（用户目录名非 ASCII 也可能，但 XML 能表达） */
  const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const argsXml = [opts.execPath, ...opts.args].map((a) => `    <string>${esc(a)}</string>`).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${esc(opts.label)}</string>
  <key>ProgramArguments</key>
  <array>
${argsXml}
  </array>
  <!-- 登录时启动 -->
  <key>RunAtLoad</key>
  <true/>
  <!-- 崩溃后由 launchd 拉起；这是"崩溃自恢复"的保障（PRD NFR-R2） -->
  <key>KeepAlive</key>
  <true/>
  <!-- 后台低优先级：不抢占前台应用资源 -->
  <key>ProcessType</key>
  <string>Background</string>
  <!-- 工作目录设为用户主目录，避免相对路径解析问题 -->
  <key>WorkingDirectory</key>
  <string>${esc(homedir())}</string>
  <key>StandardOutPath</key>
  <string>${esc(join(homedir(), "Library", "Logs", "Aegis", "daemon.out.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${esc(join(homedir(), "Library", "Logs", "Aegis", "daemon.err.log"))}</string>
</dict>
</plist>
`;
}

/** plist 的完整路径 */
export function plistPath(opts: AutostartOptions): string {
  const dir = opts.launchAgentsDir ?? join(homedir(), "Library", "LaunchAgents");
  return join(dir, `${opts.label}.plist`);
}

/**
 * 安装开机自启。
 *
 * 步骤：写 plist → `launchctl unload`（忽略失败）→ `launchctl load`。
 * 先 unload 是为了"重复开启"时不报 already loaded。
 */
export function installAutostart(opts: AutostartOptions): AutostartResult {
  if (process.platform !== "darwin") {
    return { ok: false, detail: `当前平台 ${process.platform} 暂不支持（计划在 M8 提供）` };
  }

  const path = plistPath(opts);
  try {
    const dir = join(path, "..");
    mkdirSync(dir, { recursive: true });
    // 确保日志目录存在（plist 里引用了它，不存在时 launchd 会启动失败）
    mkdirSync(join(homedir(), "Library", "Logs", "Aegis"), { recursive: true });
    writeFileSync(path, buildLaunchAgentPlist(opts), "utf8");
  } catch (err) {
    return { ok: false, detail: `写入 plist 失败：${(err as Error).message}` };
  }

  try {
    // 忽略 unload 的失败：本来就没加载时它必然报错
    try {
      execFileSync("launchctl", ["unload", path], { stdio: "pipe" });
    } catch {
      /* 预期：未加载 */
    }
    execFileSync("launchctl", ["load", path], { stdio: "pipe" });
  } catch (err) {
    const e = err as { stderr?: Buffer; message: string };
    const stderr = e.stderr ? e.stderr.toString().trim() : "";
    return {
      ok: false,
      detail: `launchctl load 失败：${stderr || e.message}（受限环境常见，可在系统设置里手动添加）`,
    };
  }

  return { ok: true, detail: "已设置开机自启（登录后在后台运行提醒服务）" };
}

/** 关闭开机自启：unload 后删除 plist */
export function uninstallAutostart(opts: AutostartOptions): AutostartResult {
  if (process.platform !== "darwin") {
    return { ok: false, detail: `当前平台 ${process.platform} 暂不支持` };
  }

  const path = plistPath(opts);
  if (!existsSync(path)) {
    return { ok: true, detail: "开机自启未开启" };
  }

  try {
    execFileSync("launchctl", ["unload", path], { stdio: "pipe" });
  } catch {
    // 已经不在运行也照样删文件 —— 目标是"结果状态正确"，不是"命令成功"
  }
  try {
    rmSync(path, { force: true });
  } catch (err) {
    return { ok: false, detail: `删除 plist 失败：${(err as Error).message}` };
  }
  return { ok: true, detail: "已关闭开机自启" };
}

/**
 * 查询是否已开启。
 *
 * 判定标准是**文件存在**而不是 `launchctl list` 的输出：
 * plist 存在就代表"下次登录会启动"，这正是用户关心的语义。
 */
export function isAutostartEnabled(opts: AutostartOptions): boolean {
  return existsSync(plistPath(opts));
}
