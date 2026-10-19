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
export declare function buildLaunchAgentPlist(opts: AutostartOptions): string;
/** plist 的完整路径 */
export declare function plistPath(opts: AutostartOptions): string;
/**
 * 安装开机自启。
 *
 * 步骤：写 plist → `launchctl unload`（忽略失败）→ `launchctl load`。
 * 先 unload 是为了"重复开启"时不报 already loaded。
 */
export declare function installAutostart(opts: AutostartOptions): AutostartResult;
/** 关闭开机自启：unload 后删除 plist */
export declare function uninstallAutostart(opts: AutostartOptions): AutostartResult;
/**
 * 查询是否已开启。
 *
 * 判定标准是**文件存在**而不是 `launchctl list` 的输出：
 * plist 存在就代表"下次登录会启动"，这正是用户关心的语义。
 */
export declare function isAutostartEnabled(opts: AutostartOptions): boolean;
//# sourceMappingURL=autostart.d.ts.map