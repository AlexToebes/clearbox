import { describe, expect, it } from "vitest";
import { toMessageRow } from "@/lib/gmail/parse";
import { generateFakeMailbox } from "./fakeMailbox";

const NOW = new Date("2026-09-28T00:00:00Z").getTime();

describe("generateFakeMailbox", () => {
  it("is deterministic for a given seed", () => {
    const a = generateFakeMailbox({ seed: 42, messageCount: 500, now: NOW });
    const b = generateFakeMailbox({ seed: 42, messageCount: 500, now: NOW });
    expect(a).toEqual(b);
  });

  it("produces a different mailbox for a different seed", () => {
    const a = generateFakeMailbox({ seed: 1, messageCount: 500, now: NOW });
    const b = generateFakeMailbox({ seed: 2, messageCount: 500, now: NOW });
    expect(a).not.toEqual(b);
  });

  it("produces exactly messageCount messages", () => {
    for (const messageCount of [0, 1, 37, 500, 6000]) {
      const mailbox = generateFakeMailbox({ seed: 7, messageCount, now: NOW });
      expect(mailbox).toHaveLength(messageCount);
    }
  });

  it("every message parses via toMessageRow without an empty email", () => {
    const mailbox = generateFakeMailbox({
      seed: 7,
      messageCount: 6000,
      now: NOW,
    });
    for (const message of mailbox) {
      const row = toMessageRow(message);
      expect(row.from_email).not.toBe("");
      expect(row.from_email).toContain("@");
      expect(row.id).not.toBe("");
      expect(Number.isFinite(row.internal_date)).toBe(true);
      expect(row.internal_date).toBeGreaterThan(0);
      expect(row.size_estimate).toBeGreaterThanOrEqual(2 * 1024);
      expect(row.size_estimate).toBeLessThanOrEqual(8 * 1024 * 1024);
    }
  });

  it("decodes RFC 2047 encoded and quoted display names", () => {
    const mailbox = generateFakeMailbox({
      seed: 7,
      messageCount: 6000,
      now: NOW,
    });
    const names = new Set(mailbox.map((m) => toMessageRow(m).from_name));
    expect(names).toContain("Jörg Löffler");
    expect(names).toContain("María José Fernández");
    expect(names).toContain("Doe, Jane");
  });

  it("has a realistic long-tail sender distribution", () => {
    const mailbox = generateFakeMailbox({
      seed: 7,
      messageCount: 6000,
      now: NOW,
    });
    const counts = new Map<string, number>();
    for (const message of mailbox) {
      const email = toMessageRow(message).from_email;
      counts.set(email, (counts.get(email) ?? 0) + 1);
    }

    expect(counts.size).toBeGreaterThan(100);

    const total = mailbox.length;
    const topCount = Math.max(...counts.values());
    const topShare = topCount / total;
    expect(topShare).toBeGreaterThan(0.05);
    expect(topShare).toBeLessThan(0.25);

    // Long tail: plenty of senders with just 1–5 messages.
    const smallSenders = [...counts.values()].filter((c) => c <= 5).length;
    expect(smallSenders).toBeGreaterThan(50);
  });

  it("spreads dates over roughly the last six years, skewed recent", () => {
    const mailbox = generateFakeMailbox({
      seed: 7,
      messageCount: 6000,
      now: NOW,
    });
    const dates = mailbox.map((m) => Number(m.internalDate));
    const sixYearsAgo = NOW - 6 * 365 * 24 * 60 * 60 * 1000;
    for (const date of dates) {
      expect(date).toBeLessThanOrEqual(NOW);
      expect(date).toBeGreaterThanOrEqual(sixYearsAgo - 1);
    }

    const lastYear = NOW - 365 * 24 * 60 * 60 * 1000;
    const recentCount = dates.filter((d) => d >= lastYear).length;
    const oldestYear = sixYearsAgo + 365 * 24 * 60 * 60 * 1000;
    const oldCount = dates.filter((d) => d <= oldestYear).length;
    // Growth toward recent years: the most recent year should have
    // noticeably more messages than the oldest year.
    expect(recentCount).toBeGreaterThan(oldCount);
  });

  it("marks most marketing mail unread and most personal mail read", () => {
    const mailbox = generateFakeMailbox({
      seed: 7,
      messageCount: 6000,
      now: NOW,
    });
    const rows = mailbox.map(toMessageRow);

    const marketing = rows.filter(
      (r) => r.list_unsubscribe !== null && r.from_domain !== "linkedin.com",
    );
    const marketingUnreadRate =
      marketing.filter((r) => r.is_unread === 1).length / marketing.length;
    expect(marketingUnreadRate).toBeGreaterThan(0.6);

    const personal = rows.filter(
      (r) =>
        r.from_email.endsWith("@gmail.com") ||
        r.from_email.endsWith("@yahoo.com") ||
        r.from_email.endsWith("@outlook.com"),
    );
    const personalUnreadRate =
      personal.filter((r) => r.is_unread === 1).length / personal.length;
    expect(personalUnreadRate).toBeLessThan(0.2);
  });

  it("includes a one-click List-Unsubscribe-Post for some newsletters", () => {
    const mailbox = generateFakeMailbox({
      seed: 7,
      messageCount: 6000,
      now: NOW,
    });
    const oneClick = mailbox.some((m) =>
      m.payload?.headers?.some(
        (h) =>
          h.name === "List-Unsubscribe-Post" &&
          h.value === "List-Unsubscribe=One-Click",
      ),
    );
    expect(oneClick).toBe(true);
  });

  it("returns [] for a zero message count", () => {
    expect(generateFakeMailbox({ seed: 1, messageCount: 0 })).toEqual([]);
  });
});
