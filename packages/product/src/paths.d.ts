/** macOS/Linux 的 sun_path 上限（含结尾 NUL，留一点余量） */
export declare const UDS_PATH_LIMIT = 100;
/**
 * 是否 Windows 平台。
 *
 * @param platform 可注入，便于测试平台分支而不必真的换系统
 */
export declare function isWindows(platform?: NodeJS.Platform): boolean;
/**
 * 数据目录。
 * 解析顺序：显式传入 > 环境变量 AEGIS_DATA_DIR > 平台默认位置
 */
export declare function resolveDataDir(opts?: {
    override?: string;
    env?: NodeJS.ProcessEnv;
}): string;
/** 目录布局（与《M0+M1 详细设计》§4.1 一致） */
export interface DataPaths {
    readonly dataDir: string;
    readonly dbFile: string;
    readonly blobsDir: string;
    readonly snapshotsDir: string;
    readonly logsDir: string;
    readonly lockFile: string;
    readonly handshakeFile: string;
    readonly readyFile: string;
    readonly configFile: string;
    /** IPC 端点：UDS 路径（posix）或 NamedPipe 名（win32） */
    readonly ipcEndpoint: string;
    /** 当 UDS 路径超长被改写时，记录原始期望路径（供诊断） */
    readonly ipcEndpointFallbackFrom: string | null;
}
/**
 * 解析数据目录下的全部路径。
 *
 * ⚠️ UDS 路径受 macOS `sun_path` 长度限制（104 字节）。数据目录过深时，
 * 这里会自动退到短路径（`/tmp/<bundleIdPrefix>-<uid>.sock`），
 * 并通过 `ipcEndpointFallbackFrom` 记录原始期望路径供诊断 —— 而不是直接失败。
 */
export declare function resolveDataPaths(opts: {
    dataDir: string;
    platform?: NodeJS.Platform;
}): DataPaths;
//# sourceMappingURL=paths.d.ts.map