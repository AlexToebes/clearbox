import { describe, expect, it } from "vitest";
import { parseAddress, toMessageRow } from "./parse";
import type { GmailMessage } from "./types";

describe("parseAddress", () => {
  const cases: {
    name: string;
    input: string;
    expected: { name: string | null; email: string; domain: string };
  }[] = [
    {
      name: "Name <email>",
      input: "Alice Example <alice@example.com>",
      expected: {
        name: "Alice Example",
        email: "alice@example.com",
        domain: "example.com",
      },
    },
    {
      name: "quoted 'Last, First' <email>",
      input: '"Example, Alice" <alice@example.com>',
      expected: {
        name: "Example, Alice",
        email: "alice@example.com",
        domain: "example.com",
      },
    },
    {
      name: "bare email, no angle brackets",
      input: "alice@example.com",
      expected: {
        name: null,
        email: "alice@example.com",
        domain: "example.com",
      },
    },
    {
      name: "<email> only, no name",
      input: "<alice@example.com>",
      expected: {
        name: null,
        email: "alice@example.com",
        domain: "example.com",
      },
    },
    {
      name: "extra whitespace around name and address",
      input: "   Alice Example   <alice@example.com>   ",
      expected: {
        name: "Alice Example",
        email: "alice@example.com",
        domain: "example.com",
      },
    },
    {
      name: "extra whitespace, bare email",
      input: "   alice@example.com   ",
      expected: {
        name: null,
        email: "alice@example.com",
        domain: "example.com",
      },
    },
    {
      name: "uppercase address is lowercased",
      input: "Alice Example <ALICE@EXAMPLE.COM>",
      expected: {
        name: "Alice Example",
        email: "alice@example.com",
        domain: "example.com",
      },
    },
    {
      name: "uppercase bare address is lowercased",
      input: "ALICE@EXAMPLE.COM",
      expected: {
        name: null,
        email: "alice@example.com",
        domain: "example.com",
      },
    },
    {
      name: "RFC 2047 encoded name, UTF-8 base64 (B)",
      // "Café" in UTF-8 base64
      input: "=?UTF-8?B?Q2Fmw6k=?= <cafe@example.com>",
      expected: {
        name: "Café",
        email: "cafe@example.com",
        domain: "example.com",
      },
    },
    {
      name: "RFC 2047 encoded name, UTF-8 quoted-printable (Q)",
      input: "=?UTF-8?Q?Caf=C3=A9?= <cafe@example.com>",
      expected: {
        name: "Café",
        email: "cafe@example.com",
        domain: "example.com",
      },
    },
    {
      name: "RFC 2047 encoded name with underscore-as-space (Q)",
      input: "=?UTF-8?Q?Alice_Example?= <alice@example.com>",
      expected: {
        name: "Alice Example",
        email: "alice@example.com",
        domain: "example.com",
      },
    },
    {
      name: "RFC 2047 unknown charset is left as-is",
      input: "=?BOGUS-CHARSET?B?Q2Fmw6k=?= <cafe@example.com>",
      expected: {
        name: "=?BOGUS-CHARSET?B?Q2Fmw6k=?=",
        email: "cafe@example.com",
        domain: "example.com",
      },
    },
    {
      name: "garbage input with no @ falls back to lowercased trimmed input, empty domain",
      input: "  Not An Email  ",
      expected: { name: null, email: "not an email", domain: "" },
    },
    {
      name: "empty string",
      input: "",
      expected: { name: null, email: "", domain: "" },
    },
    {
      name: "angle brackets with garbage inside (no @)",
      input: "Alice <not-an-email>",
      expected: { name: null, email: "not-an-email", domain: "" },
    },
  ];

  it.each(cases)("$name", ({ input, expected }) => {
    expect(parseAddress(input)).toEqual(expected);
  });
});

describe("toMessageRow", () => {
  function message(overrides: Partial<GmailMessage> = {}): GmailMessage {
    return {
      id: "msg-1",
      threadId: "thread-1",
      internalDate: "1700000000000",
      sizeEstimate: 4321,
      labelIds: ["INBOX"],
      payload: { headers: [] },
      ...overrides,
    };
  }

  it("maps a typical message", () => {
    const row = toMessageRow(
      message({
        labelIds: ["INBOX", "UNREAD"],
        payload: {
          headers: [
            { name: "From", value: "Alice Example <alice@example.com>" },
            { name: "Subject", value: "Hello" },
            {
              name: "List-Unsubscribe",
              value: "<https://example.com/unsub>",
            },
            {
              name: "List-Unsubscribe-Post",
              value: "List-Unsubscribe=One-Click",
            },
          ],
        },
      }),
    );

    expect(row).toEqual({
      id: "msg-1",
      thread_id: "thread-1",
      from_name: "Alice Example",
      from_email: "alice@example.com",
      from_domain: "example.com",
      subject: "Hello",
      internal_date: 1_700_000_000_000,
      size_estimate: 4321,
      label_ids: JSON.stringify(["INBOX", "UNREAD"]),
      is_unread: true,
      is_trashed: false,
      list_unsubscribe: "<https://example.com/unsub>",
      list_unsubscribe_post: "List-Unsubscribe=One-Click",
    });
  });

  it("does header lookup case-insensitively", () => {
    const row = toMessageRow(
      message({
        payload: {
          headers: [
            { name: "from", value: "alice@example.com" },
            { name: "SUBJECT", value: "Hi" },
          ],
        },
      }),
    );

    expect(row.from_email).toBe("alice@example.com");
    expect(row.subject).toBe("Hi");
  });

  it("sets is_unread/is_trashed from the UNREAD/TRASH labels", () => {
    expect(toMessageRow(message({ labelIds: ["TRASH"] }))).toMatchObject({
      is_unread: false,
      is_trashed: true,
    });
    expect(
      toMessageRow(message({ labelIds: ["UNREAD", "TRASH"] })),
    ).toMatchObject({ is_unread: true, is_trashed: true });
    expect(toMessageRow(message({ labelIds: [] }))).toMatchObject({
      is_unread: false,
      is_trashed: false,
    });
  });

  it("defaults missing From to empty email/domain and null name", () => {
    const row = toMessageRow(message({ payload: { headers: [] } }));
    expect(row.from_name).toBeNull();
    expect(row.from_email).toBe("");
    expect(row.from_domain).toBe("");
  });

  it("defaults missing Subject and unsubscribe headers to null", () => {
    const row = toMessageRow(message({ payload: { headers: [] } }));
    expect(row.subject).toBeNull();
    expect(row.list_unsubscribe).toBeNull();
    expect(row.list_unsubscribe_post).toBeNull();
  });

  it("handles a missing payload entirely", () => {
    const row = toMessageRow(message({ payload: undefined }));
    expect(row.from_email).toBe("");
    expect(row.subject).toBeNull();
  });

  it("handles a missing labelIds entirely", () => {
    const row = toMessageRow(message({ labelIds: undefined }));
    expect(row.label_ids).toBe("[]");
    expect(row.is_unread).toBe(false);
    expect(row.is_trashed).toBe(false);
  });

  it("converts internalDate (ms string) to a number", () => {
    const row = toMessageRow(message({ internalDate: "1699999999999" }));
    expect(row.internal_date).toBe(1_699_999_999_999);
  });
});
