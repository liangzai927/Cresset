/**
 * 天气（M3）—— Open-Meteo，无需 API Key。
 *
 * 用户从预设地区下拉多选；每个地区带自己的经纬度。
 * 只发送经纬度，不发送任何用户数据/提醒内容。单个地区失败只让该地区缺席。
 */

import type { Clock } from "@aegis/clock";
import { loadConfig } from "./config.js";

/** 天气摘要 */
export interface WeatherSummary {
  location: string;
  minC: number;
  maxC: number;
  description: string;
  fetchedAt: number;
}

/** WMO weather_code → 中文 */
export function weatherDescription(code: number): string {
  if (code === 0) return "晴";
  if (code >= 1 && code <= 3) return "多云";
  if (code === 45 || code === 48) return "雾";
  if (code >= 51 && code <= 57) return "毛毛雨";
  if (code >= 61 && code <= 67) return "雨";
  if (code >= 71 && code <= 77) return "雪";
  if (code >= 80 && code <= 82) return "阵雨";
  if (code >= 85 && code <= 86) return "阵雪";
  if (code >= 95) return "雷暴";
  return "未知天气";
}

/** 天气服务；缓存 30 分钟，单个地区失败保留旧缓存 */
export class WeatherService {
  readonly #opts: { configFile: string; clock: Clock; fetchImpl?: typeof fetch };
  #cache: WeatherSummary[] = [];
  #lastFetch = 0;

  constructor(opts: { configFile: string; clock: Clock; fetchImpl?: typeof fetch }) {
    this.#opts = opts;
  }

  /** 当前多地区缓存 */
  summary(): WeatherSummary[] {
    return this.#cache;
  }

  /** 缓存超过 30 分钟才刷新 */
  async refreshIfStale(): Promise<WeatherSummary[]> {
    if (this.#cache.length > 0 && this.#opts.clock.wall() - this.#lastFetch < 30 * 60_000) {
      return this.#cache;
    }
    return this.refresh();
  }

  /** 拉取所选地区的今天天气；失败的地区保留旧值 */
  async refresh(): Promise<WeatherSummary[]> {
    const cfg = loadConfig(this.#opts.configFile).config.weather;
    if (!cfg.enabled || cfg.locations.length === 0) {
      this.#cache = [];
      this.#lastFetch = this.#opts.clock.wall();
      return [];
    }
    const previous = new Map(this.#cache.map((w) => [w.location, w]));
    const results = await Promise.all(
      cfg.locations.map(async (loc) => {
        const fresh = await this.#fetchOne(loc.name, loc.latitude, loc.longitude);
        return fresh ?? previous.get(loc.name) ?? null;
      }),
    );
    this.#cache = results.filter((w): w is WeatherSummary => w !== null);
    this.#lastFetch = this.#opts.clock.wall();
    return this.#cache;
  }

  /** 拉取一个地区；失败返回 null */
  async #fetchOne(name: string, latitude: number, longitude: number): Promise<WeatherSummary | null> {
    const url = new URL("https://api.open-meteo.com/v1/forecast");
    url.searchParams.set("latitude", String(latitude));
    url.searchParams.set("longitude", String(longitude));
    url.searchParams.set("daily", "weather_code,temperature_2m_max,temperature_2m_min");
    url.searchParams.set("forecast_days", "1");
    url.searchParams.set("timezone", "auto");
    try {
      const res = await (this.#opts.fetchImpl ?? fetch)(url, {
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as {
        daily?: {
          weather_code?: number[];
          temperature_2m_max?: number[];
          temperature_2m_min?: number[];
        };
      };
      const code = body.daily?.weather_code?.[0];
      const max = body.daily?.temperature_2m_max?.[0];
      const min = body.daily?.temperature_2m_min?.[0];
      if (typeof code !== "number" || typeof max !== "number" || typeof min !== "number") {
        throw new Error("天气响应缺少字段");
      }
      return {
        location: name,
        minC: Math.round(min),
        maxC: Math.round(max),
        description: weatherDescription(code),
        fetchedAt: this.#opts.clock.wall(),
      };
    } catch {
      return null;
    }
  }
}
