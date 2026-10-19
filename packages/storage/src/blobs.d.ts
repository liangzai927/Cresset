/** 一个已落盘的内容引用；`sha256` 即内容身份，相同内容天然去重 */
export interface BlobRef {
    /** 内容 sha256（十六进制） */
    readonly sha256: string;
    /** 字节数 */
    readonly bytes: number;
    /** 绝对路径 */
    readonly path: string;
}
/**
 * 内容寻址存储。
 *
 * 设计依据：**原文是唯一真相源，索引可重建**（PRD FR-G103）。
 * 写入用"临时文件 + 原子 rename"，避免进程崩溃留下半截文件被当成有效内容。
 */
export declare class BlobStore {
    #private;
    constructor(root: string);
    get root(): string;
    /** 计算内容的 sha256（十六进制小写） */
    static hash(data: string | Uint8Array): string;
    has(sha256: string): boolean;
    /**
     * 写入内容；若已存在则直接复用（去重）。
     * 采用"临时文件 + rename"保证原子性。
     */
    put(data: string | Uint8Array): BlobRef;
    /** 读取内容；不存在返回 null（不抛错，便于"引用已失效"的降级处理） */
    get(sha256: string): Buffer | null;
    getText(sha256: string): string | null;
    /** 删除一个 blob；返回是否真的删除了 */
    delete(sha256: string): boolean;
    /** 统计（容量与数量），用于 NFR-P7 的磁盘占用监控 */
    stats(): {
        count: number;
        bytes: number;
    };
    /**
     * 保守 GC：删除 `olderThanMs` 未被写入/访问过的 blob。
     * 由于 blobs 是内容寻址的，删除后若仍被引用会导致"引用已失效"——
     * 因此 R1 只提供按时间的保守清理，**调用方需自行确认无引用**。
     */
    gc(olderThanMs: number, now?: number): {
        removed: number;
        bytes: number;
    };
}
//# sourceMappingURL=blobs.d.ts.map