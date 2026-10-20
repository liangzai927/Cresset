/**
 * ICS 解析测试：折行、全天、UTC、转义。
 */

import { describe, expect, it } from "vitest";
import { eventsOn, parseIcs } from "./ics-calendar.js";

const SAMPLE = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "BEGIN:VEVENT",
  "UID:1",
  "DTSTART:20261020T090000",
  "DTEND:20261020T093000",
  "SUMMARY:周会",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:2",
  "DTSTART;VALUE=DATE:20261020",
  "SUMMARY:全天",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:3",
  "DTSTART:20261020T010000Z",
  "SUMMARY:UTC 事件\\, 带逗号",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

describe("ics calendar", () => {
  it("解析普通/全天/UTC 事件并按天过滤", () => {
    const events = parseIcs(SAMPLE);
    expect(events).toHaveLength(3);
    expect(events.find((e) => e.summary === "周会")).toMatchObject({
      startWall: "2026-10-20T09:00",
      allDay: false,
    });
    expect(events.some((e) => e.allDay && e.summary === "全天")).toBe(true);
    const onDay = eventsOn(events, "2026-10-20");
    expect(onDay).toHaveLength(3);
    expect(onDay.some((e) => e.summary.includes("带逗号"))).toBe(true);
  });

  it("展开折行", () => {
    const folded = "BEGIN:VEVENT\r\nDTSTART:20261020T090000\r\nSUMMARY:折\r\n 行标题\r\nEND:VEVENT\r\n";
    expect(parseIcs(folded)[0]?.summary).toBe("折行标题");
  });

  it("坏行/无 DTSTART 被忽略", () => {
    expect(parseIcs("BEGIN:VEVENT\nSUMMARY:无时间\nEND:VEVENT")).toEqual([]);
  });
});
