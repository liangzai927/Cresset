/**
 * 天气（M3）—— Open-Meteo，无需 API Key。
 *
 * 只发送经纬度；不发送任何用户数据/提醒内容。网络失败不阻断早报，
 * 只让天气行缺席，并在日志里留下原因。
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

/** 天气服务；缓存 30 分钟，失败保留旧缓存 */
export class WeatherService {
  readonly #opts: { configFile: string; clock: Clock; fetchImpl?: typeof fetch };
  #cache: WeatherSummary | null = null;

  constructor(opts: { configFile: string; clock: Clock; fetchImpl?: typeof fetch }) {
    this.#opts = opts;
  }

  /** 当前缓存 */
  summary(): WeatherSummary | null {
    return this.#cache;
  }

  /** 缓存超过 30 分钟才刷新 */
  async refreshIfStale(): Promise<WeatherSummary | null> {
    if (this.#cache && this.#opts.clock.wall() - this.#cache.fetchedAt < 30 * 60_000) {
      return this.#cache;
    }
    return this.refresh();
  }

  /** 拉取今天天气；失败返回旧缓存或 null */
  async refresh(): Promise<WeatherSummary | null> {
    const cfg = loadConfig(this.#opts.configFile).config.weather;
    if (!cfg.enabled || cfg.latitude === undefined || cfg.longitude === undefined) return null;
    const url = new URL("https://api.open-meteo.com/v1/forecast");
    url.searchParams.set("latitude", String(cfg.latitude));
    url.searchParams.set("longitude", String(cfg.longitude));
    url.searchParams.set("daily", "weather_code,temperature_2m_max,temperature_2m_min");
    url.searchParams.set("forecast_days", "1");
    url.searchParams.set("timezone", "auto");
    try {
      const res = await (this.#opts.fetchImpl ?? fetch)(url, {
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as {
        daily?: { weather_code?: number[]; temperature_2m_max?: number[]; temperature_2m_min?: number[] };
      };
      const code = body.daily?.weather_code?.[0];
      const max = body.daily?.temperature_2m_max?.[0];
      const min = body.daily?.temperature_2m_min?.[0];
      if (typeof code !== "number" || typeof max !== "number" || typeof min !== "number") {
        throw new Error("天气响应缺少字段");
      }
      this.#cache = {
        location: cfg.locationName ?? `${cfg.latitude.toFixed(2)},${cfg.longitude.toFixed(2)}`,
        minC: Math.round(min),
        maxC: Math.round(max),
        description: weatherDescription(code),
        fetchedAt: this.#opts.clock.wall(),
      };
      return this.#cache;
    } catch {
      return this.#cache;
    }
  }
}
