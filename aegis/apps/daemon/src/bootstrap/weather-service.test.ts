/**
 * 天气服务测试：注入 fetch，不访问外网。
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VirtualClock } from "@aegis/clock";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WeatherService, weatherDescription } from "./weather-service.js";

let dir: string;
let configFile: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aegis-weather-"));
  configFile = join(dir, "config.json");
  writeFileSync(
    configFile,
    JSON.stringify({
      version: 1,
      weather: { enabled: true, latitude: 31.23, longitude: 121.47, locationName: "上海" },
    }),
  );
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("WeatherService", () => {
  it("解析 Open-Meteo 并缓存", async () => {
    const fake = (async () =>
      new Response(
        JSON.stringify({
          daily: { weather_code: [0], temperature_2m_max: [20.4], temperature_2m_min: [11.6] },
        }),
        { status: 200 },
      )) as typeof fetch;
    const service = new WeatherService({ configFile, clock: new VirtualClock(1_000), fetchImpl: fake });
    const summary = await service.refresh();
    expect(summary).toMatchObject({ location: "上海", minC: 12, maxC: 20, description: "晴" });
    expect(service.summary()).toEqual(summary);
  });

  it("失败时返回 null，不抛错", async () => {
    const fake = (async () => new Response("bad", { status: 500 })) as typeof fetch;
    const service = new WeatherService({ configFile, clock: new VirtualClock(1_000), fetchImpl: fake });
    expect(await service.refresh()).toBeNull();
  });

  it("WMO code 映射", () => {
    expect(weatherDescription(0)).toBe("晴");
    expect(weatherDescription(61)).toBe("雨");
    expect(weatherDescription(95)).toBe("雷暴");
  });
});
