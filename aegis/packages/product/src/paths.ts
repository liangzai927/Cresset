/**
 * 路径解析 —— 数据目录、库文件、锁文件、IPC 端点。
 *
 * 关键约束（来自 R0 spike 与实现约束 C-1..C-8）：
 *   - **UDS 路径长度上限 104 字节**（macOS sun_path）。若数据目录过深导致超限，
 *     必须退到短路径（/tmp/<name>-<uid>.sock）而不是直接失败。
 *   - Windows 用 NamedPipe，无路径长度问题。
 */
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { PRODUCT } from "./index.js";

/** macOS/Linux 的 sun_path 上限（含结尾 NUL，留一点余量） */
export const UDS_PATH_LIMIT = 100;

/**
 * 是否 Windows 平台。
 *
 * @param platform 可注入，便于测试平台分支而不必真的换系统
 */
export function isWindows(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32";
}

/**
 * 数据目录。
 * 解析顺序：显式传入 > 环境变量 AEGIS_DATA_DIR > 平台默认位置
 */
export function resolveDataDir(opts: { override?: string; env?: NodeJS.ProcessEnv } = {}): string {
  const env = opts.env ?? process.env;
  const fromEnv = env.AEGIS_DATA_DIR?.trim();
  if (opts.override?.trim()) return opts.override.trim();
  if (fromEnv) return fromEnv;

  if (isWindows()) {
    const appData = env.APPDATA?.trim();
    return appData ? join(appData, PRODUCT.dataDirName) : join(homedir(), PRODUCT.dataDirName);
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", PRODUCT.dataDirName);
  }
  const xdg = env.XDG_DATA_HOME?.trim() || join(homedir(), ".local", "share");
  return join(xdg, PRODUCT.dataDirName.toLowerCase());
}

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
  /**
   * 桌面通道端点文件（由 Electron 主进程写入，0600）。
   *
   * daemon 每次投递前重新读它来发现当前可用的原生通知通道，
   * 因此 Electron 重启换端口后无需重启 daemon（ADR-R3-01）。
   */
  readonly channelFile: string;
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
export function resolveDataPaths(opts: { dataDir: string; platform?: NodeJS.Platform }): DataPaths {
  const dataDir = opts.dataDir;
  const platform = opts.platform ?? process.platform;

  // IPC 端点：优先放在数据目录内；超长则退到短路径
  let ipcEndpoint: string;
  let fallbackFrom: string | null = null;
  if (isWindows(platform)) {
    ipcEndpoint = `\\\\.\\pipe\\${PRODUCT.bundleIdPrefix}-daemon`;
  } else {
    const preferred = join(dataDir, "daemon.sock");
    if (Buffer.byteLength(preferred, "utf8") <= UDS_PATH_LIMIT) {
      ipcEndpoint = preferred;
    } else {
      // 退到短路径（仍带 uid 以避免多用户冲突）
      const uid = typeof process.getuid === "function" ? process.getuid() : 0;
      ipcEndpoint = join(tmpdir(), `${PRODUCT.bundleIdPrefix}-${uid}.sock`);
      fallbackFrom = preferred;
    }
  }

  return {
    dataDir,
    dbFile: join(dataDir, "aegis.db"),
    blobsDir: join(dataDir, "blobs"),
    snapshotsDir: join(dataDir, "snapshots"),
    logsDir: join(dataDir, "logs"),
    lockFile: join(dataDir, "daemon.lock"),
    handshakeFile: join(dataDir, "handshake.json"),
    readyFile: join(dataDir, "daemon.ready"),
    configFile: join(dataDir, "config.json"),
    channelFile: join(dataDir, "channel.json"),
    ipcEndpoint,
    ipcEndpointFallbackFrom: fallbackFrom,
  };
}
