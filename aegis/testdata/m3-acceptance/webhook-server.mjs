#!/usr/bin/env node
/**
 * M3 验收用本地 Webhook 接收端
 *
 * 只监听 127.0.0.1，不对外暴露。用于验证：
 *   - Aegis 的 Webhook 配置是否正确
 *   - fanout 是否真的发送到了 Webhook
 *   - 测试按钮和真实通知是否都能到达
 *
 * 用法：
 *   node testdata/m3-acceptance/webhook-server.mjs
 *   PORT=8788 node testdata/m3-acceptance/webhook-server.mjs
 *
 * 端点：
 *   POST /ok    返回 200，并打印 JSON
 *   POST /fail  返回 500，用于验证失败分类
 */

import { createServer } from "node:http";

const port = Number(process.env.PORT ?? "8787");
const host = "127.0.0.1";

const server = createServer((req, res) => {
  if (req.method !== "POST") {
    res.writeHead(405, { "content-type": "text/plain" });
    res.end("只接受 POST");
    return;
  }

  let raw = "";
  req.on("data", (chunk) => {
    raw += chunk;
    if (raw.length > 100_000) req.destroy();
  });
  req.on("end", () => {
    let payload = raw;
    try {
      payload = JSON.parse(raw);
    } catch {
      // 保留原始文本，方便排查格式问题
    }
    console.log(
      JSON.stringify(
        {
          at: new Date().toISOString(),
          path: req.url,
          payload,
        },
        null,
        2,
      ),
    );

    const fail = req.url?.startsWith("/fail");
    res.writeHead(fail ? 500 : 200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: !fail }));
  });
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`✗ 端口 ${port} 已被占用。`);
    console.error("  查看占用进程：lsof -nP -iTCP:" + port + " -sTCP:LISTEN");
    console.error(`  换一个端口：PORT=${port + 1} node testdata/m3-acceptance/webhook-server.mjs`);
    console.error(`  然后把 http://${host}:${port + 1}/ok 填到 Aegis Webhook。`);
  } else {
    console.error(`✗ Webhook 服务启动失败：${err.message}`);
  }
  process.exit(1);
});

server.listen(port, host, () => {
  console.log(`webhook 测试服务器：http://${host}:${port}/ok`);
  console.log("把上述 URL 填到 Aegis 设置 → 通知渠道 → Webhook，然后保存并重启 daemon。");
});
