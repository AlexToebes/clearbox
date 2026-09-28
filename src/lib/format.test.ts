import { describe, expect, it } from "vitest";
import {
  formatBytes,
  formatCompact,
  formatMonthLabel,
  formatPercent,
} from "./format";

describe("formatBytes", () => {
  it.each([
    [0, "0 B"],
    [1, "1 B"],
    [1023, "1,023 B"],
    [1024, "1.0 KB"],
    [1536, "1.5 KB"],
    [1024 * 1024, "1.0 MB"],
    [1024 * 1024 * 2.5, "2.5 MB"],
    [1024 * 1024 * 1024, "1.0 GB"],
    [1024 * 1024 * 1024 * 12.34, "12.3 GB"],
  ])("formats %d bytes as %s", (input, expected) => {
    expect(formatBytes(input)).toBe(expected);
  });
});

describe("formatCompact", () => {
  it.each([
    [0, "0"],
    [999, "999"],
    [12_900, "12.9K"],
    [20_000, "20K"],
    [1_234_567, "1.2M"],
  ])("formats %d as %s", (input, expected) => {
    expect(formatCompact(input)).toBe(expected);
  });
});

describe("formatPercent", () => {
  it.each([
    [0, "0%"],
    [0.001, "<1%"],
    [0.004, "<1%"],
    [0.006, "1%"],
    [0.021, "2%"],
    [0.5, "50%"],
    [1, "100%"],
  ])("formats %d as %s", (input, expected) => {
    expect(formatPercent(input)).toBe(expected);
  });
});

describe("formatMonthLabel", () => {
  it.each([
    ["2025-03", "Mar '25"],
    ["2025-01", "Jan '25"],
    ["2005-12", "Dec '05"],
    ["1999-07", "Jul '99"],
  ])("formats %s (short) as %s", (input, expected) => {
    expect(formatMonthLabel(input)).toBe(expected);
  });

  it.each([
    ["2025-03", "March 2025"],
    ["2025-01", "January 2025"],
    ["2005-12", "December 2005"],
  ])("formats %s (long) as %s", (input, expected) => {
    expect(formatMonthLabel(input, true)).toBe(expected);
  });
});
