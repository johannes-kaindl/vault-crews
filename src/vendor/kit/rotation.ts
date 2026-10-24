// vendored from code-kit@0.36.0, src/ts/pure/rotation.ts — do not hand-edit; re-vendor via tools/sync-kit.sh
/** Which of a set of timestamp-named directories have to go, so that the newest `keep`
 *  survive. Used for rotating backups, snapshots and any other write-once, keep-N store.
 *
 *  Two independent versions existed before this one (obsidian-plugins/, 2026-07..2026-08):
 *  `vault-rag/src/index_backup.ts` (`selectBackupsToDelete`, embedding index backups) and
 *  `obsidian-transmute/src/core/vault/snapshot.ts` (`selectSnapshotsToDelete`, undo snapshots).
 *
 *  ── Precondition, and the reason the naming stayed behind ───────────────────────────────
 *  **Names must sort lexicographically into chronological order.** Both callers get that from
 *  an ISO timestamp with the path-hostile characters replaced. Deriving that name did NOT move
 *  in here, because the two versions genuinely disagree about it: vault-rag keeps milliseconds
 *  (`replace(/[:.]/g, "-")`), obsidian-transmute drops them (`replace(/\.\d+Z?$/, "")`). Both
 *  are correct for their own store, both are one line, and neither is a fact about rotation —
 *  what this module needs is only that the names sort. A caller whose names do not sort (a
 *  locale date, a bare counter) must not use this.
 *
 *  ── Divergences resolved on the way in (both pinned by test) ────────────────────────────
 *  **Order of the result.** vault-rag returned the doomed entries ascending, transmute
 *  descending. Both callers only iterate and delete, so neither noticed — the contract here is
 *  oldest first.
 *  **A negative `keep`.** vault-rag deleted everything, transmute kept all but one
 *  (`slice(-1)`). It is a caller bug either way; it now reads as "keep at most none".
 */

/** The entries to delete, oldest first, so that the newest `keep` of `names` survive.
 *  `names` is not modified. See the module header for the sorting precondition. */
export function selectRotatedOut(names: string[], keep: number): string[] {
  const survivors = Math.max(0, keep);
  if (names.length <= survivors) return [];
  return [...names].sort().slice(0, names.length - survivors);
}

/* ── Grandfather-father-son retention ────────────────────────────────────────────────────
 *
 *  `selectRotatedOut` keeps the newest N. A snapshot taken *before a write* is more useful
 *  spread over time: the newest few of today, plus one per calendar day, week and month.
 *  Sister function in the same file because it shares the contract ("entries in, names out,
 *  the caller deletes") — but not the precondition: this one takes times, not sorting names.
 *
 *  Template: `finance-ledger/src/core/snapshot/gfs-retention.ts` (finance-ledger@241e357),
 *  whose golden tables (checked against an independent CPython reference: Europe/Berlin
 *  daylight-saving change 2026-10-25, ISO week 53, ten snapshots on one day, an entry from the
 *  future) were taken over. Lifted into the kit so that finance-ledger, 3d-codeblocks and the
 *  settings assistant do not each carry a copy.
 *
 *  Default policy and semantics are a decision of the maintainer (2026-10-03): the newest
 *  `today` of the current day, and for the last `days` days / `weeks` weeks / `months` months
 *  the **oldest** entry of each window — a snapshot is the state *before* a write, so the oldest
 *  of a window is the state before that day, week or month began.
 *
 *  ── Two rules for the caller ────────────────────────────────────────────────────────────
 *  **The caller parses the name into a time.** The retention hangs on no naming convention:
 *  it gets `{ name, time }` (milliseconds since epoch). "Unknown means keep" is therefore the
 *  caller's business: a name whose time it cannot read is simply not passed in, and what is not
 *  in `entries` is never in `drop`.
 *  **Callers delete only after the new snapshot has been written** — the retention keeps no
 *  "last remainder": a single entry older than the oldest window is in `drop`.
 *
 *  ── Protecting entries: `keepNewest` and `protect` (added 0.17.0) ───────────────────────
 *  GFS keeps the **oldest** entry of each window. A caller whose entry times are not the time the
 *  entry was written has no "newest is safe" guarantee: vault-rag names its index backups after the
 *  `built_at` of the index container, so with backups of 10-08 07:00 and 10-09 09:00 / 15:00 / 21:00
 *  at `now` = 10-10 12:00 the newest (10-09 21:00) lands in `drop`. `keepNewest` protects the
 *  newest entry that is not after `now`. `protect` is the general form — a list of names that are
 *  never in `drop` — and covers what settings-assistant (`snapshots.ts`) did by filtering `drop`
 *  afterwards (the snapshot taken in the very run). Both default off, so existing callers are
 *  unchanged; both are additive, and a protected entry that no window keeps is labelled
 *  `"protected"` (`keep` and `drop` stay disjoint, which a `drop.filter` could not promise).
 *  The two are separate options because they answer different questions — "never lose the latest"
 *  needs no name, "never lose this one" is a name the caller already holds.
 *
 *  ── Calendar ────────────────────────────────────────────────────────────────────────────
 *  Day, week (ISO, Monday start) and month borders come from an injected {@link GfsCalendar};
 *  `now` is injected too (no `Date.now()`, no file system). A calendar maps an instant to the
 *  integer ordinal of its day, week and month, so a window is "ordinal difference below N" and a
 *  daylight-saving jump or a year border (ISO week 53) cannot move it. Default
 *  {@link localCalendar}: the calendar of the user's runtime time zone — a snapshot "from
 *  yesterday" is one the user saw yesterday. {@link utcCalendar} is for reproducible callers;
 *  {@link zoneCalendar} for a named IANA zone independent of the machine. Entries after `now`
 *  (clock skew) are always kept and labelled `"future"`. */

/** `"protected"` (0.17.0) is only ever the label of an entry that `keepNewest` / `protect` keeps
 *  and no window does; {@link gfsBucket} classifies by window and never returns it. */
export type GfsBucket = "today" | "day" | "week" | "month" | "future" | "protected";

export interface GfsPolicy {
  /** The newest N entries of the current day. */
  today: number;
  /** The last N calendar days including today, the oldest entry of each. */
  days: number;
  /** The last N ISO weeks including the current, the oldest entry of each. */
  weeks: number;
  /** The last N calendar months including the current, the oldest entry of each. */
  months: number;
}

/** Starting values, not a measurement. At most 23 survive; the windows overlap, so fewer in practice. */
export const DEFAULT_GFS_POLICY: GfsPolicy = { today: 6, days: 7, weeks: 4, months: 6 };

export interface GfsEntry {
  name: string;
  /** Milliseconds since epoch. The caller parses the name. */
  time: number;
}

/** Maps an instant to the ordinals of its calendar day, week and month. Only differences and
 *  equality are used, so any consistent integer scale works. */
export interface GfsCalendar {
  /** Ordinal of the calendar day (consecutive days differ by 1). */
  day(ms: number): number;
  /** Ordinal of the day on which the ISO week (Monday start) of `ms` begins. */
  week(ms: number): number;
  /** `year * 12 + month` (consecutive months differ by 1). */
  month(ms: number): number;
}

export interface GfsOptions {
  /** Default {@link DEFAULT_GFS_POLICY}. */
  policy?: GfsPolicy;
  /** Default {@link localCalendar}. */
  calendar?: GfsCalendar;
  /** Also keep the newest entry that is not after `now`. Default off. See the module header. */
  keepNewest?: boolean;
  /** Names that are never in `drop`; a name that is not an entry is ignored. Default none. */
  protect?: readonly string[];
}

const DAY_MS = 86_400_000;

/** A calendar from the civil date of an instant: `(year, month 1–12, day)` in whatever zone. */
function civilCalendar(civil: (ms: number) => [number, number, number]): GfsCalendar {
  // Day ordinal of a civil date, via UTC so that no zone or daylight-saving jump is involved.
  const ordinal = (ms: number): number => {
    const [y, m, d] = civil(ms);
    return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
  };
  return {
    day: ordinal,
    // 1970-01-01 was a Thursday: (ordinal + 3) % 7 is 0 on a Monday.
    week: (ms) => ordinal(ms) - ((ordinal(ms) + 3) % 7),
    month: (ms) => {
      const [y, m] = civil(ms);
      return y * 12 + (m - 1);
    },
  };
}

/** The UTC calendar. Reproducible regardless of the machine. */
export const utcCalendar: GfsCalendar = civilCalendar((ms) => {
  const d = new Date(ms);
  return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()];
});

/** The calendar of the runtime's own time zone (`Date` local getters). The default. */
export const localCalendar: GfsCalendar = civilCalendar((ms) => {
  const d = new Date(ms);
  return [d.getFullYear(), d.getMonth() + 1, d.getDate()];
});

/** The calendar of a named IANA zone (`"Europe/Berlin"`), independent of the machine. */
export function zoneCalendar(timeZone: string): GfsCalendar {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  return civilCalendar((ms) => {
    const part = (type: string): number => Number(fmt.formatToParts(ms).find((p) => p.type === type)?.value);
    return [part("year"), part("month"), part("day")];
  });
}

/** The display order: the shortest window wins, so a grouped list shows every entry once. */
const RANK: readonly GfsBucket[] = ["today", "day", "week", "month", "future", "protected"];

/** The windows an entry satisfies as a *candidate* (not whether it is the oldest of its window). */
function windowsOf(time: number, now: number, policy: GfsPolicy, cal: GfsCalendar): GfsBucket[] {
  if (time > now) return ["future"];
  const out: GfsBucket[] = [];
  if (cal.day(time) === cal.day(now)) out.push("today");
  if (cal.day(now) - cal.day(time) < policy.days) out.push("day");
  if (cal.week(now) - cal.week(time) < policy.weeks * 7) out.push("week");
  if (cal.month(now) - cal.month(time) < policy.months) out.push("month");
  return out;
}

/** The shortest window an entry falls into, `null` if it is outside all of them. Classifies the
 *  entry only; whether it is also the *oldest* of its window — and so kept — is decided by
 *  `selectGfsRetention`. An entry after `now` is `"future"`. */
export function gfsBucket(entry: GfsEntry, now: number, opts: GfsOptions = {}): GfsBucket | null {
  const found = windowsOf(entry.time, now, opts.policy ?? DEFAULT_GFS_POLICY, opts.calendar ?? localCalendar);
  return RANK.find((b) => found.includes(b)) ?? null;
}

/** Which entries stay and which may go. `keep` and `drop` are both oldest first (ties by name);
 *  each kept entry carries its display `bucket` (rank today > day > week > month; `future` for an
 *  entry after `now`; `protected` for one only `keepNewest` / `protect` keeps) and all `buckets` it satisfies — the windows overlap, an entry can owe its
 *  place to two. `entries` is not modified. */
export function selectGfsRetention(
  entries: readonly GfsEntry[],
  now: number,
  opts: GfsOptions = {},
): { keep: { name: string; bucket: GfsBucket; buckets: GfsBucket[] }[]; drop: string[] } {
  const policy = opts.policy ?? DEFAULT_GFS_POLICY;
  const cal = opts.calendar ?? localCalendar;
  const sorted = [...entries].sort((a, b) => a.time - b.time || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const hits = new Map<string, Set<GfsBucket>>();
  const mark = (name: string, bucket: GfsBucket): void => {
    const have = hits.get(name);
    if (have) have.add(bucket);
    else hits.set(name, new Set([bucket]));
  };

  for (const e of sorted) if (e.time > now) mark(e.name, "future");

  // `slice(-0)` would be everything instead of nothing, hence the guard.
  if (policy.today > 0) {
    const sameDay = sorted.filter((e) => e.time <= now && cal.day(e.time) === cal.day(now));
    for (const e of sameDay.slice(-policy.today)) mark(e.name, "today");
  }

  const oldestPerWindow = (bucket: "day" | "week" | "month", ordinal: (ms: number) => number): void => {
    const seen = new Set<number>();
    for (const e of sorted) {
      if (!windowsOf(e.time, now, policy, cal).includes(bucket)) continue;
      const key = ordinal(e.time);
      if (seen.has(key)) continue;
      seen.add(key);
      mark(e.name, bucket);
    }
  };
  oldestPerWindow("day", (ms) => cal.day(ms));
  oldestPerWindow("week", (ms) => cal.week(ms));
  oldestPerWindow("month", (ms) => cal.month(ms));

  if (opts.keepNewest) {
    // `sorted` is oldest first, so the last entry that is not in the future is the newest real one.
    for (let i = sorted.length - 1; i >= 0; i--) {
      const e = sorted[i];
      if (e && e.time <= now) { mark(e.name, "protected"); break; }
    }
  }
  if (opts.protect?.length) {
    const protectedNames = new Set(opts.protect);
    for (const e of sorted) if (protectedNames.has(e.name)) mark(e.name, "protected");
  }

  const keep: { name: string; bucket: GfsBucket; buckets: GfsBucket[] }[] = [];
  const drop: string[] = [];
  for (const e of sorted) {
    const found = hits.get(e.name);
    const buckets = found ? RANK.filter((b) => found.has(b)) : [];
    const first = buckets[0];
    if (first === undefined) drop.push(e.name);
    else keep.push({ name: e.name, bucket: first, buckets });
  }
  return { keep, drop };
}

/* ── Names that carry their time ─────────────────────────────────────────────────────────
 *
 *  {@link selectGfsRetention} needs `{ name, time }`; the caller derives the time. The time is read
 *  from the **name**, not from the file's mtime, on purpose: a copy, a sync or a backup restore sets
 *  mtimes anew, and the retention would then rotate by the wrong instant. The name survives that.
 *  (Reasoning and tests taken over from `finance-ledger/src/core/snapshot/snapshotName.ts`.)
 *
 *  Two copies existed: finance-ledger `snapshotFileName(prefix, time)` / `snapshotTimeFromName(name)`
 *  (`<prefix>-YYYY-MM-DDTHH-MM-SS-mmmZ.json`, "unknown means keep") and vault-rag `backupDirName`
 *  (`builtAt.replace(/[:.]/g, "-")`, the stamp alone, no inverse — and `Date.parse` on such a name
 *  is `NaN`). One pair carries both: the stamp is the ISO instant with `-` for `:` and `.`, always
 *  UTC (sortable and place-independent; the calendar borders are drawn later by the injected
 *  {@link GfsCalendar}), and it may sit anywhere in the name between a `prefix` and a `suffix`.
 *
 *  Not carried: a stamp without milliseconds (obsidian-transmute drops them). Such a name is `null`
 *  — and so kept. */

const STAMP_RE = /(?<!\d)(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z(?!\d)/;

/** The name for an instant: `prefix` + `YYYY-MM-DDTHH-MM-SS-mmmZ` (UTC) + `suffix`. Prefix and
 *  suffix are taken verbatim, so the caller puts the separator and the extension in
 *  (`{ prefix: "snap-", suffix: ".json" }`). With equal affixes the names sort in chronological
 *  order, which is what {@link selectRotatedOut} needs. Throws a `RangeError` for a time that is
 *  not a date (`NaN`, ±Infinity): a name that cannot be read back is worse than no name. */
export function stampedName(time: number, affixes: { prefix?: string; suffix?: string } = {}): string {
  const stamp = new Date(time).toISOString().replace(/[:.]/g, "-");
  return `${affixes.prefix ?? ""}${stamp}${affixes.suffix ?? ""}`;
}

/** The instant a name carries, or `null` if it carries none. `null` means "do not pass this entry
 *  to {@link selectGfsRetention}": what the retention does not know it does not delete — unknown
 *  means keep. A stamp that is not a real instant (month 13, 30 February) is `null` too: `Date.UTC`
 *  would roll it over to a different day, and a rotation by the wrong day is silent. If a name
 *  holds several stamps, the first one counts. */
export function timeFromStampedName(name: string): number | null {
  const m = STAMP_RE.exec(name);
  if (!m) return null;
  const [y, mo, d, h, mi, s, ms] = m.slice(1).map(Number) as [number, number, number, number, number, number, number];
  const time = Date.UTC(y, mo - 1, d, h, mi, s, ms);
  // Round trip: the same stamp must come back, otherwise the fields were out of range and rolled over.
  return Number.isNaN(time) || new Date(time).toISOString().replace(/[:.]/g, "-") !== m[0] ? null : time;
}
