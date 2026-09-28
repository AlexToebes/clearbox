/**
 * Deterministic fake mailbox generator for browser demo mode (see
 * `src/dev/demoServices.ts`). Produces `GmailMessage[]` in exactly the
 * shape `messages.get?format=metadata` would return, so it flows through
 * the *real* `toMessageRow`/scan/SQL pipeline unmodified — only the Gmail
 * API itself is faked, not anything downstream of it.
 *
 * Every brand name below is fictional (the classic set of Microsoft's own
 * placeholder company names); the few real domains used (github.com,
 * linkedin.com, amazon.com, accounts.google.com, slack.com, dropbox.com)
 * stand in for generic transactional/notification infrastructure, not for
 * any specific message content.
 */

import type { GmailMessage } from "@/lib/gmail/types";

export interface GenerateFakeMailboxOptions {
  /** Deterministic seed — the same seed + messageCount always produces the
   * same mailbox. */
  seed: number;
  messageCount: number;
  /** "Now", in milliseconds since the epoch. Message dates are spread over
   * the six years before this. Defaults to `Date.now()`. */
  now?: number;
}

// ---------------------------------------------------------------------
// Deterministic PRNG (mulberry32) and small helpers built on it.
// ---------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Rng {
  /** Uniform [0, 1). */
  next(): number;
  /** Uniform integer in [min, max] (inclusive). */
  int(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
  /** New array with `items` in Fisher–Yates shuffled order. */
  shuffle<T>(items: readonly T[]): T[];
  chance(probability: number): boolean;
}

function createRng(seed: number): Rng {
  const next = mulberry32(seed);
  const int = (min: number, max: number) =>
    min + Math.floor(next() * (max - min + 1));
  return {
    next,
    int,
    pick: (items) => items[int(0, items.length - 1)]!,
    shuffle: (items) => {
      const copy = items.slice();
      for (let i = copy.length - 1; i > 0; i--) {
        const j = int(0, i);
        [copy[i], copy[j]] = [copy[j]!, copy[i]!];
      }
      return copy;
    },
    chance: (probability) => next() < probability,
  };
}

/** Standard normal sample via Box–Muller, using two draws from `rng`. */
function randomNormal(rng: Rng): number {
  const u1 = Math.max(rng.next(), 1e-9);
  const u2 = rng.next();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

const MIN_SIZE_BYTES = 2 * 1024;
const MAX_SIZE_BYTES = 8 * 1024 * 1024;

/** Log-normal-ish message size, centered around ~40 KB, with a rare (3%)
 * attachment-sized bump. Clamped to [2 KB, 8 MB]. */
function randomSize(rng: Rng): number {
  const mu = Math.log(40 * 1024);
  const sigma = 1.3;
  let bytes = Math.exp(mu + sigma * randomNormal(rng));
  if (rng.chance(0.03)) {
    bytes *= rng.int(5, 25);
  }
  return Math.round(Math.min(MAX_SIZE_BYTES, Math.max(MIN_SIZE_BYTES, bytes)));
}

const SIX_YEARS_MS = 6 * 365 * 24 * 60 * 60 * 1000;

/** A date within the last six years, skewed toward more recent dates
 * (growth over time): for uniform `u`, `u^GROWTH_POWER` concentrates
 * density near 0 (i.e. near "now"). */
function randomDate(rng: Rng, now: number): number {
  const GROWTH_POWER = 1.8;
  const t = Math.pow(rng.next(), GROWTH_POWER);
  return Math.round(now - t * SIX_YEARS_MS);
}

/** `=?UTF-8?B?...?=` RFC 2047 encoded-word, round-trippable by
 * `lib/gmail/parse.ts`'s `decodeEncodedWords`. */
function encodeRfc2047(name: string): string {
  const bytes = new TextEncoder().encode(name);
  let binary = "";
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return `=?UTF-8?B?${btoa(binary)}?=`;
}

// ---------------------------------------------------------------------
// Sender rosters.
// ---------------------------------------------------------------------

type Category = "newsletter" | "notification" | "personal";

interface SenderTemplate {
  name: string | null;
  /** Header form of the name — usually equal to `name`, but overridden for
   * the couple of senders that exercise RFC 2047 encoding or a quoted
   * "Last, First" display name. */
  headerName: string | null;
  email: string;
  category: Category;
  hasUnsubscribe: boolean;
  oneClickUnsubscribe: boolean;
  unreadRate: number;
  subjects: readonly string[];
}

// Fictional brand names (Microsoft's own long-standing placeholder set) —
// deliberately not real companies.
const NEWSLETTER_BRANDS = [
  "Northwind Deals",
  "Contoso News",
  "Fabrikam Style",
  "Adventure Works Travel",
  "Tailwind Traders",
  "Wingtip Toys",
  "Litware Tech",
  "Proseware Fitness",
  "Coho Vineyard",
  "Alpine Ski House",
  "Blue Yonder Airlines",
  "Woodgrove Bank",
  "Relecloud Media",
  "Trey Research",
  "VanArsdel Home",
  "Fourth Coffee",
  "Graphic Design Institute",
  "Humongous Insurance",
  "Lucerne Publishing",
  "Margie's Travel",
  "Nod Publishers",
  "School of Fine Art",
  "City Power & Light",
  "Consolidated Messenger",
  "Fabrikam Fitness",
  "Fincher's Furniture",
  "First Up Consultants",
  "Old World Delicatessen",
  "Parnell Aerospace",
  "Shoe Box Boutique",
  "Sun State Farmers Market",
  "Tie Rack Neckwear",
  "Wide World Importers",
  "Wingtip Gadgets",
  "Bellows Outfitters",
] as const;

const NEWSLETTER_SUBJECTS = [
  "{brand} Weekly: this week's top picks",
  "Your {brand} cart is waiting for you",
  "{pct}% off everything at {brand}",
  "New arrivals from {brand}",
  "Last chance: {brand}'s sale ends tonight",
  "{brand}: you've got rewards waiting",
  "This week at {brand}",
  "{brand} Insider: what's new",
] as const;

function brandDomain(brand: string, index: number): string {
  const slug = brand
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9\s]/g, "")
    .trim()
    .split(/\s+/)
    .join(index % 2 === 0 ? "" : "-");
  const tlds = [".com", ".io", ".co", ".net"];
  return `${slug}${tlds[index % tlds.length]}`;
}

function buildNewsletterSenders(rng: Rng): SenderTemplate[] {
  return NEWSLETTER_BRANDS.map((brand, index) => {
    const domain = brandDomain(brand, index);
    const subjects = NEWSLETTER_SUBJECTS.map((s) =>
      s.replace("{brand}", brand).replace("{pct}", String(rng.int(10, 60))),
    );
    return {
      name: brand,
      headerName: brand,
      email: `newsletter@${domain}`,
      category: "newsletter" as const,
      hasUnsubscribe: true,
      oneClickUnsubscribe: rng.chance(0.5),
      unreadRate: 0.85,
      subjects,
    };
  });
}

interface NotificationSpec {
  email: string;
  hasUnsubscribe: boolean;
  subjects: readonly string[];
}

const NOTIFICATION_SPECS: NotificationSpec[] = [
  {
    email: "notifications@github.com",
    hasUnsubscribe: false,
    subjects: [
      "[clearbox/clearbox] New pull request opened",
      "[clearbox/clearbox] Review requested",
      "Your weekly digest for clearbox/clearbox",
    ],
  },
  {
    email: "no-reply@github.com",
    hasUnsubscribe: false,
    subjects: ["Please verify your email address", "Security alert"],
  },
  {
    email: "messages-noreply@linkedin.com",
    hasUnsubscribe: true,
    subjects: [
      "You have a new message",
      "You appeared in 9 searches this week",
    ],
  },
  {
    email: "jobs-noreply@linkedin.com",
    hasUnsubscribe: true,
    subjects: ["New jobs matching your search", "Your job alert: 12 new roles"],
  },
  {
    email: "notifications-noreply@linkedin.com",
    hasUnsubscribe: true,
    subjects: ["Someone viewed your profile", "You have new notifications"],
  },
  {
    email: "shipment-tracking@amazon.com",
    hasUnsubscribe: false,
    subjects: ["Your package has shipped", "Out for delivery today"],
  },
  {
    email: "order-update@amazon.com",
    hasUnsubscribe: false,
    subjects: ["Your order has been placed", "Order confirmation"],
  },
  {
    email: "account-update@amazon.com",
    hasUnsubscribe: false,
    subjects: ["Your account details were updated"],
  },
  {
    email: "no-reply@amazon.com",
    hasUnsubscribe: false,
    subjects: ["Your receipt", "Did you forget something?"],
  },
  {
    email: "no-reply@accounts.google.com",
    hasUnsubscribe: false,
    subjects: [
      "Security alert for your Google Account",
      "New sign-in on Windows",
    ],
  },
  {
    email: "feedback@slack.com",
    hasUnsubscribe: false,
    subjects: ["You have unread messages", "Weekly workspace summary"],
  },
  {
    email: "no-reply@dropbox.com",
    hasUnsubscribe: false,
    subjects: ["A file was shared with you", "Your storage is almost full"],
  },
];

function buildNotificationSenders(): SenderTemplate[] {
  return NOTIFICATION_SPECS.map((spec) => ({
    name: null,
    headerName: null,
    email: spec.email,
    category: "notification" as const,
    hasUnsubscribe: spec.hasUnsubscribe,
    oneClickUnsubscribe: false,
    unreadRate: 0.5,
    subjects: spec.subjects,
  }));
}

const FIRST_NAMES = [
  "James",
  "Mary",
  "Robert",
  "Patricia",
  "John",
  "Jennifer",
  "Michael",
  "Linda",
  "David",
  "Elizabeth",
  "William",
  "Barbara",
  "Richard",
  "Susan",
  "Joseph",
  "Jessica",
  "Thomas",
  "Sarah",
  "Charles",
  "Karen",
  "Daniel",
  "Nancy",
  "Matthew",
  "Lisa",
  "Anthony",
  "Betty",
  "Mark",
  "Margaret",
  "Priya",
  "Wei",
  "Fatima",
  "Carlos",
  "Yuki",
  "Amara",
  "Diego",
  "Ingrid",
  "Kwame",
  "Noor",
  "Liam",
  "Sofia",
] as const;

const LAST_NAMES = [
  "Smith",
  "Johnson",
  "Williams",
  "Brown",
  "Jones",
  "Garcia",
  "Miller",
  "Davis",
  "Rodriguez",
  "Martinez",
  "Hernandez",
  "Lopez",
  "Gonzalez",
  "Wilson",
  "Anderson",
  "Thomas",
  "Taylor",
  "Moore",
  "Jackson",
  "Martin",
  "Lee",
  "Perez",
  "Thompson",
  "White",
  "Harris",
  "Sanchez",
  "Clark",
  "Ramirez",
  "Patel",
  "Chen",
  "Nguyen",
  "Kim",
  "Okafor",
  "Andersson",
  "Dubois",
  "Rossi",
  "Kowalski",
  "Ivanov",
  "Haddad",
  "Nakamura",
] as const;

const PERSONAL_SUBJECTS = [
  "Re: dinner next week?",
  "Quick question",
  "Following up on this",
  "Photos from the trip",
  "Happy birthday!",
  "Can you take a look at this?",
  "Re: schedule for Friday",
  "Long time no talk",
  "Thank you!",
  "One more thing",
] as const;

const PERSONAL_EMAIL_PROVIDERS = [
  "gmail.com",
  "yahoo.com",
  "outlook.com",
  "hotmail.com",
  "icloud.com",
  "protonmail.com",
  "aol.com",
] as const;

const COMPANY_WORD_A = [
  "bright",
  "cedar",
  "river",
  "summit",
  "harbor",
  "maple",
  "granite",
  "silver",
  "amber",
  "willow",
  "cobalt",
  "orchard",
] as const;

const COMPANY_WORD_B = [
  "path",
  "row",
  "stone",
  "works",
  "labs",
  "group",
  "collective",
  "partners",
  "studio",
  "analytics",
  "ventures",
  "point",
] as const;

function buildCompanyDomains(rng: Rng, count: number): string[] {
  const combos: string[] = [];
  for (const a of COMPANY_WORD_A) {
    for (const b of COMPANY_WORD_B) {
      combos.push(`${a}${b}`);
    }
  }
  const tlds = [".com", ".io", ".co"];
  return rng
    .shuffle(combos)
    .slice(0, count)
    .map((slug, index) => `${slug}${tlds[index % tlds.length]}`);
}

function slugify(name: string): string {
  return name.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");
}

function buildPersonalSenders(rng: Rng, count: number): SenderTemplate[] {
  const companyDomains = buildCompanyDomains(rng, 75);

  // A couple of fixed, always-present senders exercising header edge
  // cases `lib/gmail/parse.ts` needs to handle — kept outside the random
  // roster so they show up for every seed.
  const fixed: SenderTemplate[] = [
    {
      name: "Jörg Löffler",
      headerName: encodeRfc2047("Jörg Löffler"),
      email: "jorg.loffler@gmail.com",
      category: "personal",
      hasUnsubscribe: false,
      oneClickUnsubscribe: false,
      unreadRate: 0.05,
      subjects: PERSONAL_SUBJECTS,
    },
    {
      name: "María José Fernández",
      headerName: encodeRfc2047("María José Fernández"),
      email: "maria.fernandez@outlook.com",
      category: "personal",
      hasUnsubscribe: false,
      oneClickUnsubscribe: false,
      unreadRate: 0.05,
      subjects: PERSONAL_SUBJECTS,
    },
    {
      name: "Jane Doe",
      headerName: '"Doe, Jane"',
      email: "jane.doe@yahoo.com",
      category: "personal",
      hasUnsubscribe: false,
      oneClickUnsubscribe: false,
      unreadRate: 0.05,
      subjects: PERSONAL_SUBJECTS,
    },
  ];

  const generated: SenderTemplate[] = [];
  const usedEmails = new Set(fixed.map((s) => s.email));
  let attempts = 0;
  while (generated.length < count - fixed.length && attempts < count * 20) {
    attempts += 1;
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const domain = rng.chance(0.6)
      ? rng.pick(PERSONAL_EMAIL_PROVIDERS)
      : rng.pick(companyDomains);
    const email = `${slugify(first)}.${slugify(last)}${rng.int(0, 99) === 0 ? rng.int(1, 99) : ""}@${domain}`;
    if (usedEmails.has(email)) {
      continue;
    }
    usedEmails.add(email);
    const name = `${first} ${last}`;
    generated.push({
      name,
      headerName: name,
      email,
      category: "personal",
      hasUnsubscribe: false,
      oneClickUnsubscribe: false,
      unreadRate: 0.05,
      subjects: PERSONAL_SUBJECTS,
    });
  }

  return [...fixed, ...generated];
}

// ---------------------------------------------------------------------
// Message-count allocation (Zipf-like for newsletter/notification, a
// heavy-tailed mix — mostly 1–5, a few dozen "close contacts" — for
// personal).
// ---------------------------------------------------------------------

/** Splits `total` across `senders.length` slots using Zipf weights
 * (`1/rank`), then nudges the largest slot so the sum is exact. */
function allocateZipf(total: number, count: number): number[] {
  const weights = Array.from({ length: count }, (_, i) => 1 / (i + 1));
  const sumWeights = weights.reduce((a, b) => a + b, 0);
  const counts = weights.map((w) => Math.round((w / sumWeights) * total));
  const diff = total - counts.reduce((a, b) => a + b, 0);
  counts[0] = (counts[0] ?? 0) + diff;
  return counts;
}

function allocatePersonal(rng: Rng, total: number, count: number): number[] {
  const base = Array.from({ length: count }, (_, i) =>
    // The first ~10% are "close contacts" with a lot more mail.
    i < Math.max(1, Math.round(count * 0.1)) ? rng.int(15, 80) : rng.int(1, 5),
  );
  const sumBase = base.reduce((a, b) => a + b, 0);
  const scale = sumBase === 0 ? 0 : total / sumBase;
  const counts = base.map((c) => Math.round(c * scale));
  const diff = total - counts.reduce((a, b) => a + b, 0);
  // Apply the rounding remainder to the largest bucket, never letting it
  // go negative.
  let largestIndex = 0;
  for (let i = 1; i < counts.length; i++) {
    if ((counts[i] ?? 0) > (counts[largestIndex] ?? 0)) {
      largestIndex = i;
    }
  }
  counts[largestIndex] = Math.max(0, (counts[largestIndex] ?? 0) + diff);
  return counts;
}

// ---------------------------------------------------------------------
// Message building.
// ---------------------------------------------------------------------

function fromHeaderValue(sender: SenderTemplate): string {
  if (!sender.headerName) {
    return sender.email;
  }
  return `${sender.headerName} <${sender.email}>`;
}

function buildMessage(
  rng: Rng,
  sender: SenderTemplate,
  now: number,
  counter: number,
): GmailMessage {
  const id = `demo-${counter.toString(36)}`;
  const unread = rng.chance(sender.unreadRate);
  const labelIds = ["INBOX", ...(unread ? ["UNREAD"] : [])];
  const subject = rng.pick(sender.subjects);

  const headers: GmailMessage["payload"] = {
    headers: [
      { name: "From", value: fromHeaderValue(sender) },
      { name: "Subject", value: subject },
      ...(sender.hasUnsubscribe
        ? [
            {
              name: "List-Unsubscribe",
              value: `<https://${sender.email.split("@")[1]}/unsubscribe?u=${id}>, <mailto:unsubscribe@${sender.email.split("@")[1]}>`,
            },
            ...(sender.oneClickUnsubscribe
              ? [
                  {
                    name: "List-Unsubscribe-Post",
                    value: "List-Unsubscribe=One-Click",
                  },
                ]
              : []),
          ]
        : []),
    ],
  };

  return {
    id,
    threadId: id,
    labelIds,
    internalDate: String(randomDate(rng, now)),
    sizeEstimate: randomSize(rng),
    payload: headers,
  };
}

/**
 * Generates a deterministic fake mailbox: the same `seed` and
 * `messageCount` always produce the same `GmailMessage[]` (`now`, if
 * given, only shifts *where* the fixed date distribution lands — it
 * doesn't change relative ordering or counts).
 *
 * ~300 senders across ~120 domains, Zipf-distributed so a handful of
 * newsletters/notifications carry thousands of messages while most
 * personal senders carry a handful. See the module doc comment for the
 * mix.
 */
export function generateFakeMailbox(
  opts: GenerateFakeMailboxOptions,
): GmailMessage[] {
  const { seed, messageCount } = opts;
  const now = opts.now ?? Date.now();
  const rng = createRng(seed);

  const newsletterSenders = buildNewsletterSenders(rng);
  const notificationSenders = buildNotificationSenders();
  const personalSenders = buildPersonalSenders(rng, 253);

  const newsletterTotal = Math.round(messageCount * 0.45);
  const notificationTotal = Math.round(messageCount * 0.25);
  const personalTotal = Math.max(
    0,
    messageCount - newsletterTotal - notificationTotal,
  );

  const newsletterCounts = allocateZipf(
    newsletterTotal,
    newsletterSenders.length,
  );
  const notificationCounts = allocateZipf(
    notificationTotal,
    notificationSenders.length,
  );
  const personalCounts = allocatePersonal(
    rng,
    personalTotal,
    personalSenders.length,
  );

  const allocations: { sender: SenderTemplate; count: number }[] = [
    ...newsletterSenders.map((sender, i) => ({
      sender,
      count: newsletterCounts[i] ?? 0,
    })),
    ...notificationSenders.map((sender, i) => ({
      sender,
      count: notificationCounts[i] ?? 0,
    })),
    ...personalSenders.map((sender, i) => ({
      sender,
      count: personalCounts[i] ?? 0,
    })),
  ];

  const messages: GmailMessage[] = [];
  let counter = 0;
  for (const { sender, count } of allocations) {
    for (let i = 0; i < count; i++) {
      messages.push(buildMessage(rng, sender, now, counter));
      counter += 1;
    }
  }

  // Newest first, matching Gmail's own `messages.list` ordering — the real
  // `GmailClient` pages through ids in this order too (see
  // `src/dev/demoServices.ts`).
  messages.sort((a, b) => Number(b.internalDate) - Number(a.internalDate));

  // `allocateZipf`/`allocatePersonal` round to the requested total, but
  // may occasionally land one message short/over across every bucket
  // combined; trim or pad against the very last message so callers get
  // exactly `messageCount`.
  while (messages.length > messageCount) {
    messages.pop();
  }
  while (messages.length < messageCount) {
    const filler = rng.pick(personalSenders);
    messages.push(buildMessage(rng, filler, now, counter));
    counter += 1;
  }

  return messages;
}
