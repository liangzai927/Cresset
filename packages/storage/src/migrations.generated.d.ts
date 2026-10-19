/**
 * ⚠️ 本文件由 tools/gen-migrations.mjs 生成，请勿手工编辑。
 * 源文件：packages/storage/migrations/*.sql
 * 重新生成：node tools/gen-migrations.mjs（新增迁移后加 --force）
 */
export interface Migration {
    /** 顺序 id，必须从 1 连续递增 */
    readonly id: number;
    readonly name: string;
    /** SQL 内容的 sha256，用于运行期校验（防止已应用迁移被改动） */
    readonly checksum: string;
    readonly sql: string;
}
/**
 * 全部迁移（内嵌 SQL）。
 *
 * ⚠️ 本常量由 `tools/gen-migrations.mjs` 从 `migrations/*.sql` 生成，**请勿手工编辑**。
 * 之所以内嵌而非运行时读文件：daemon 用 esbuild 打包，运行时读不到仓库里的 .sql。
 */
export declare const MIGRATIONS: readonly Migration[];
//# sourceMappingURL=migrations.generated.d.ts.map