import type { MessageRow } from "@/lib/db/types";
import type { GmailMessage } from "./types";

/** `=?charset?B|Q?encoded-text?=` (RFC 2047 encoded-word). */
const ENCODED_WORD = /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g;

function decodeQEncoding(text: string): string {
  return text
    .replace(/_/g, " ")
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex: string) =>
      String.fromCharCode(parseInt(hex, 16)),
    );
}

function bytesFromBinaryString(binary: string): Uint8Array {
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Decodes RFC 2047 encoded-words (`=?UTF-8?B?...?=`, `=?UTF-8?Q?...?=`) that
 * can appear in a `From` header's display name. An unknown/unsupported
 * charset is left as-is rather than throwing.
 */
function decodeEncodedWords(input: string): string {
  // Whitespace that separates two adjacent encoded-words is not part of
  // either word's content (RFC 2047 §2).
  const collapsed = input.replace(/(\?=)\s+(=\?)/g, "$1$2");

  return collapsed.replace(
    ENCODED_WORD,
    (match: string, charset: string, encoding: string, text: string) => {
      try {
        const binary =
          encoding.toUpperCase() === "B" ? atob(text) : decodeQEncoding(text);
        const decoder = new TextDecoder(charset.toLowerCase());
        return decoder.decode(bytesFromBinaryString(binary));
      } catch {
        return match;
      }
    },
  );
}

function stripQuotes(name: string): string {
  if (name.length >= 2 && name.startsWith('"') && name.endsWith('"')) {
    return name.slice(1, -1).replace(/\\(.)/g, "$1");
  }
  return name;
}

/**
 * Parses an email `From` header value into a display name and a
 * lowercased email address/domain. Never throws — malformed input (no `@`)
 * falls back to treating the whole trimmed, lowercased string as the email
 * with an empty domain.
 */
export function parseAddress(from: string): {
  name: string | null;
  email: string;
  domain: string;
} {
  const trimmed = from.trim();
  const angleMatch = /^(.*)<([^<>]*)>\s*$/s.exec(trimmed);

  const rawName = angleMatch ? angleMatch[1]!.trim() : "";
  const rawEmail = angleMatch ? angleMatch[2]!.trim() : trimmed;

  const atIndex = rawEmail.lastIndexOf("@");
  if (atIndex === -1) {
    // Garbage input: no recognizable address.
    return { name: null, email: rawEmail.toLowerCase(), domain: "" };
  }

  const email = rawEmail.toLowerCase();
  const domain = email.slice(atIndex + 1);

  const decodedName = rawName ? decodeEncodedWords(stripQuotes(rawName)) : "";
  const name = decodedName.trim() ? decodedName.trim() : null;

  return { name, email, domain };
}

function findHeader(message: GmailMessage, name: string): string | undefined {
  const lower = name.toLowerCase();
  return message.payload?.headers?.find((h) => h.name.toLowerCase() === lower)
    ?.value;
}

/** Maps a Gmail API message (metadata format) into a `messages` table row. */
export function toMessageRow(message: GmailMessage): MessageRow {
  const fromHeader = findHeader(message, "From");
  const from = fromHeader
    ? parseAddress(fromHeader)
    : { name: null, email: "", domain: "" };

  const labelIds = message.labelIds ?? [];

  return {
    id: message.id,
    thread_id: message.threadId,
    from_name: from.name,
    from_email: from.email,
    from_domain: from.domain,
    subject: findHeader(message, "Subject") ?? null,
    internal_date: Number(message.internalDate),
    size_estimate: message.sizeEstimate,
    label_ids: JSON.stringify(labelIds),
    is_unread: labelIds.includes("UNREAD") ? 1 : 0,
    is_trashed: labelIds.includes("TRASH") ? 1 : 0,
    list_unsubscribe: findHeader(message, "List-Unsubscribe") ?? null,
    list_unsubscribe_post: findHeader(message, "List-Unsubscribe-Post") ?? null,
  };
}
