/**
 * EmailNotifier 测试：注入 transport，不发真实邮件。
 */

import { describe, expect, it } from "vitest";
import { EmailNotifier, type EmailTransport } from "./email-notifier.js";

function fakeTransport(send: () => Promise<unknown>): EmailTransport {
  return { sendMail: send };
}

describe("EmailNotifier", () => {
  it("用 SMTP 配置发送纯文本邮件", async () => {
    let message: unknown = null;
    const n = new EmailNotifier({
      host: "smtp.example.com",
      port: 465,
      secure: true,
      from: "aegis@example.com",
      to: "me@example.com",
      user: "aegis",
      password: async () => "pw",
      transportFactory: (opts) => {
        expect(opts.auth).toEqual({ user: "aegis", pass: "pw" });
        return fakeTransport(async () => {
          message = "sent";
        });
      },
    });
    expect(await n.send({ title: "提醒", body: "正文" })).toEqual({ outcome: "success" });
    expect(message).toBe("sent");
  });

  it("无密码 → permanent；auth 错误 → permanent", async () => {
    const noPass = new EmailNotifier({
      host: "smtp.example.com",
      port: 465,
      secure: true,
      from: "a@example.com",
      to: "b@example.com",
      password: async () => null,
    });
    expect((await noPass.send({ title: "t" })).outcome).toBe("permanent_error");

    const badAuth = new EmailNotifier({
      host: "smtp.example.com",
      port: 465,
      secure: true,
      from: "a@example.com",
      to: "b@example.com",
      password: async () => "pw",
      transportFactory: () =>
        fakeTransport(async () => {
          const err = new Error("Invalid login") as Error & { code: string };
          err.code = "EAUTH";
          throw err;
        }),
    });
    expect((await badAuth.send({ title: "t" })).outcome).toBe("permanent_error");
  });

  it("连接超时 → timeout", async () => {
    const n = new EmailNotifier({
      host: "smtp.example.com",
      port: 465,
      secure: true,
      from: "a@example.com",
      to: "b@example.com",
      password: async () => "pw",
      transportFactory: () =>
        fakeTransport(async () => {
          const err = new Error("timeout") as Error & { code: string };
          err.code = "ETIMEDOUT";
          throw err;
        }),
    });
    expect((await n.send({ title: "t" })).outcome).toBe("timeout");
  });
});
