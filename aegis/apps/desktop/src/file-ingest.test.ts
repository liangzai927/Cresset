/**
 * 文档摄取测试：txt 直接读，docx 用 textutil 转换。
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DOCUMENT_EXTENSIONS, extractDocumentText } from "./file-ingest.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aegis-ingest-"));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("extractDocumentText", () => {
  it("读取 Markdown/TXT", () => {
    const file = join(dir, "a.md");
    writeFileSync(file, "# 标题\n正文");
    expect(extractDocumentText(file)).toContain("正文");
  });

  it("用 textutil 读取 docx", () => {
    const txt = join(dir, "sample.txt");
    const docx = join(dir, "sample.docx");
    writeFileSync(txt, "Hello Aegis\n第二行\n");
    execFileSync("/usr/bin/textutil", ["-convert", "docx", txt, "-output", docx]);
    expect(extractDocumentText(docx)).toContain("第二行");
  });

  it("拒绝不支持的格式", () => {
    const file = join(dir, "x.pdf");
    writeFileSync(file, "x");
    expect(() => extractDocumentText(file)).toThrow(/暂不支持/);
  });

  it("扩展名清单包含 docx/rtf", () => {
    expect(DOCUMENT_EXTENSIONS).toContain("docx");
    expect(DOCUMENT_EXTENSIONS).toContain("rtf");
  });
});
