/**
 * 产品标识的**单一来源**（Single Source of Truth）
 *
 * 为什么单独成包：产品名尚未最终确定（PRD Q16 未定），而名称会渗透到一批
 * **事后很难改**的位置：
 *   - 数据目录        ~/Library/Application Support/<name>/
 *   - LaunchAgent     com.<name>.daemon
 *   - 钥匙串 service  com.<name>.credentials
 *   - Bundle ID       影响通知权限与签名
 *
 * 因此把它收敛到这一个文件：改名时只需改这里 + 写一次数据迁移脚本。
 * 其余代码一律通过 `@aegis/product` 读取，不得硬编码字符串。
 */
export interface ProductIdentity {
    /** 展示名（界面与通知里给人看的名字） */
    readonly displayName: string;
    /** 反向 DNS 前缀，用于 LaunchAgent label / 钥匙串 service / Bundle ID */
    readonly bundleIdPrefix: string;
    /** 数据目录名（macOS: ~/Library/Application Support/<dataDirName>） */
    readonly dataDirName: string;
    /** 界面语言（PRD Q16 建议：界面中文优先，代码与配置字段英文） */
    readonly locale: string;
}
/**
 * 当前标识（暂定名 aegis）。
 * ⚠️ 改这里意味着已有用户的数据目录/label/钥匙串条目需要迁移。
 */
export declare const PRODUCT: ProductIdentity;
/** LaunchAgent label（macOS 开机自启） */
export declare const DAEMON_LABEL: string;
/** 钥匙串 service 名（凭据存储） */
export declare const KEYCHAIN_SERVICE: string;
export { type DataPaths, isWindows, resolveDataDir, resolveDataPaths, UDS_PATH_LIMIT, } from "./paths.js";
//# sourceMappingURL=index.d.ts.map