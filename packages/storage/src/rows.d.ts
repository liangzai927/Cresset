/**
 * 行映射助手
 *
 * node:sqlite 的 `all()` / `get()` 返回 `Record<string, SQLOutputValue>`，
 * 直接 `as SomeRow[]` 会被 TS 判为"类型不充分重叠"。散落的 `as unknown as` 断言会
 * 掩盖真实的形状错误，因此集中到这两个函数：
 *   - 转换只发生在此处，其余代码拿到的是**已声明的行类型**
 *   - 真正的正确性由 DAO 出口处的 Zod 解码（`TaskSchema.parse` 等）保证
 */
import type { StatementSync } from "node:sqlite";
/** 取多行并转换为我方声明的行类型 */
export declare function rowsOf<T>(stmt: StatementSync, ...params: unknown[]): T[];
/** 取单行（无结果返回 undefined） */
export declare function rowOf<T>(stmt: StatementSync, ...params: unknown[]): T | undefined;
/** 执行写语句并返回影响行数（**幂等裁决的依据**，不要用返回值做真值判断） */
export declare function runStmt(stmt: StatementSync, ...params: unknown[]): {
    changes: number;
};
//# sourceMappingURL=rows.d.ts.map