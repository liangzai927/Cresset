/**
 * 文档摄取：文本/Markdown 直接读；docx/rtf 用 macOS 自带 textutil 转纯文本。
 *
 * 为什么用 textutil：不引入第三方 Word 解析依赖，且 macOS 原生支持 docx/rtf。
 * 不支持的格式明确报错，不把二进制当 UTF-8 读成乱码。
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { extname } from "node:path";

/** 支持导入的扩展名 */
export const DOCUMENT_EXTENSIONS = ["md", "markdown", "txt", "docx", "rtf"] as const;

/** 读取文档为纯文本；失败抛可读错误 */
export function extractDocumentText(path: string): string {
  const ext = extname(path).toLowerCase();
  if (ext === ".docx" || ext === ".rtf") {
    try {
      return execFileSync("/usr/bin/textutil", ["-convert", "txt", "-stdout", path], {
        encoding: "utf8",
        timeout: 15_000,
        maxBuffer: 4_000_000,
      });
    } catch (err) {
      throw new Error(`无法解析 ${ext} 文档：${(err as Error).message.slice(0, 200)}`);
    }
  }
  if (ext === ".md" || ext === ".markdown" || ext === ".txt" || ext === "") {
    return readFileSync(path, "utf8");
  }
  throw new Error(`暂不支持 ${ext || "无扩展名"} 文件`);
}
