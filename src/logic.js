import { isAdult } from "./shared.js";
export { isAdult };

// Only adults may open a train, lay out its dates, or close one. This MIRRORS
// the `adult_writable` policy on trains/dates — a non-adult shown these
// controls would get a silent 403, so the client gate must match the server.
export function canManage(member) {
  return isAdult(member);
}

/**
 * The hub-injected member is the only authoritative identity in an installed
 * app. Falling back to the first household member can accidentally present an
 * adult's controls to a child when context loading succeeds but identity
 * injection does not. The local demo deliberately keeps its first seeded
 * member so it remains interactive outside the hub.
 */
export function resolveCurrentMember(injectedMember, members, demo = false) {
  return injectedMember
    ?? (demo ? members[0] : null)
    ?? { id: "guest", name: "Guest", role: "guest" };
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * The human date stored in `dates.label` and shown in the public form's
 * dropdown. The hub projects a stored column there — it cannot format a date —
 * so this is the one place a label is made, and every write of `meal_date`
 * writes it alongside.
 *
 * Deliberately built from UTC getters on a UTC-midnight date rather than
 * `Intl`/local getters: the input is a bare `yyyy-mm-dd` with no zone, and
 * parsing it through the device clock would shift the weekday for half the
 * world (see "Household-local dates" in CLAUDE.md).
 */
export function dateLabel(isoDate) {
  if (typeof isoDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return isoDate ?? "";
  const [y, m, d] = isoDate.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return `${WEEKDAYS[dt.getUTCDay()]}, ${MONTHS[m - 1]} ${d}`;
}

/**
 * Every `yyyy-mm-dd` from `start` to `end` inclusive — the spine of laying out
 * a care period ("meals every night for two weeks"). Stepped in UTC so a day
 * is never skipped or repeated across a daylight-saving boundary, and bounded
 * so a typo'd year cannot try to open ten thousand rows.
 */
export function datesInRange(start, end, max = 60) {
  const ok = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
  if (!ok(start)) return [];
  const last = ok(end) && end >= start ? end : start;
  const out = [];
  const cursor = new Date(`${start}T00:00:00Z`);
  const stop = new Date(`${last}T00:00:00Z`);
  while (cursor <= stop && out.length < max) {
    out.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

/**
 * SQLite's `datetime('now')` returns space-separated UTC ("2026-03-03 18:04:00"),
 * which JS parses as LOCAL time — an hours-wide error on every guest row, since
 * `guest_claims.created_at` comes from that column default rather than from the
 * app. Normalize before handing it to `Date`.
 */
export function normalizeTimestamp(ts) {
  if (typeof ts !== "string") return ts;
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(ts) ? `${ts.replace(" ", "T")}Z` : ts;
}

/**
 * The link allowance an organizer typed. A blank or nonsense field means "leave
 * it as it was", never zero: zero is a deliberate act — it shuts the night to
 * the share link — and must be typed, not arrived at by clearing an input or by
 * `Number("") || 0`. Floored and clamped to what `CHECK (capacity >= 0)` allows.
 */
export function parseCapacity(raw, fallback = 1) {
  if (raw === "" || raw === null || raw === undefined) return fallback;
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// ── the two ledgers ──────────────────────────────────────────────────────────
// A date is covered either by a household MEMBER (a column on the date row) or
// by a link GUEST (a row in `guest_claims`). They are counted differently on
// purpose: a member claim closes the date outright, while guest claims are
// bounded by `capacity`, which the hub enforces atomically inside the INSERT.

export function guestClaimsForDate(guestClaims, dateId) {
  if (!dateId) return [];
  return guestClaims.filter((g) => g.date_id === dateId);
}

export function guestClaimCount(guestClaims, dateId) {
  return guestClaimsForDate(guestClaims, dateId).length;
}

/**
 * A date has taken all the link sign-ups it will accept. Mirrors the hub's own
 * claim predicate (`COUNT >= COALESCE(capacity, 0)`), so a zero or missing
 * capacity reads full here exactly as it does server-side — which is how an
 * organizer closes one date to the public form while members can still take it.
 *
 * This is a statement about the LINK door only. Whether anybody is bringing a
 * meal is `dateState`/`isDateHandled` — see the note there.
 */
export function isDateGuestFull(date, guestClaims) {
  return guestClaimCount(guestClaims, date.id) >= Number(date.capacity || 0);
}

/**
 * Whether this date is on offer to visitors at all. Zero link spots is not an
 * accident: it is how an organizer keeps a night for the household while the
 * share link is live.
 */
export function acceptsLinkSignups(date) {
  return Number(date.capacity || 0) > 0;
}

/**
 * What a date is, for display. `covered` and `closed` are the two states that
 * drop the date out of the public form (values_from filters on `status = open`);
 * `full` means the form still lists the train but this option is spent.
 *
 * `full` requires the link to have been OPEN and then spent. A night with zero
 * link spots is full by the hub's predicate — no visitor can claim it — but
 * nobody is bringing that meal, so it stays `open`: it still needs a cook, the
 * member "I'll bring this one" button must stay, and it must not count toward
 * the train's covered tally. Collapsing the two is the bug that made
 * `capacity: 0` look like coverage.
 */
export function dateState(date, guestClaims) {
  if (date.status === "covered") return "covered";
  if (date.status === "closed") return "closed";
  if (acceptsLinkSignups(date) && isDateGuestFull(date, guestClaims)) return "full";
  return "open";
}

/** Somebody — member or guest — is bringing a meal on this date. */
export function isDateHandled(date, guestClaims) {
  const state = dateState(date, guestClaims);
  return state === "covered" || state === "full";
}

/**
 * A date whose member claim points at somebody who has left the household.
 * `member_references` clears `covered_by` to NULL on departure but cannot
 * reopen the date, so the app surfaces these for an adult to reopen rather than
 * letting a meal silently have nobody behind it.
 */
export function isOrphanedCoverage(date) {
  return date.status === "covered" && !date.covered_by;
}

/**
 * The full row change for closing or reopening a night. `status` and the
 * `covered_*` columns are ONE fact — whether somebody is bringing this meal —
 * so they move together.
 *
 * Rewriting `status` alone was a real bug: closing and then reopening a night a
 * member had taken left `covered_by`/`covered_dish` set on an open row. The
 * agenda query reads `covered_by` straight off the row, so Today credited an
 * unclaimed meal to somebody who never agreed to it, and `isOrphanedCoverage`
 * only inspects 'covered' rows, so nothing could surface it either.
 */
export function toggledClosedFields(date) {
  return {
    status: date.status === "closed" ? "open" : "closed",
    covered_by: null,
    covered_dish: "",
    covered_at: null,
  };
}

export function datesForTrain(dates, trainId) {
  return dates
    .filter((d) => d.train_id === trainId)
    .slice()
    .sort((a, b) => String(a.meal_date ?? "").localeCompare(String(b.meal_date ?? "")));
}

/**
 * The dates a visitor would actually be offered by the share form: the same
 * `status = open` filter the manifest declares, minus the ones the hub's
 * capacity claim would refuse. The share dialog warns when this is empty,
 * because the date select is `required` — with no pickable option the public
 * form fails closed and the link collects nothing.
 *
 * Both filters are named here on purpose. `dateState` is the HOUSEHOLD's view —
 * a zero-spot night is `open` there, because it still needs somebody to cook —
 * so the hub's own claim predicate has to be applied separately or the form
 * would list an option the submit endpoint refuses.
 */
export function openDatesForForm(dates, guestClaims, trainId) {
  return datesForTrain(dates, trainId)
    .filter((d) => dateState(d, guestClaims) === "open" && !isDateGuestFull(d, guestClaims));
}

/** Progress across a train: how many of its meals have somebody behind them. */
export function trainTotals(trainId, dates, guestClaims) {
  const own = datesForTrain(dates, trainId).filter((d) => d.status !== "closed");
  const handled = own.filter((d) => isDateHandled(d, guestClaims)).length;
  const total = own.length;
  return {
    handled,
    total,
    pct: total ? Math.min(100, Math.round((handled / total) * 100)) : 0,
    complete: total > 0 && handled >= total,
  };
}

/**
 * Fields the in-app search matches against (see hub-sdk `searchMatch`).
 * The recipient counts as much as the title — a train is looked up by the
 * family it is feeding, which is often not what the organizer titled it.
 */
export function searchableFields(train) {
  return [train.title, train.recipient, train.description];
}

// ── the household calendar export ────────────────────────────────────────────
// A meal train runs every night for weeks, so 120 days is already more nights
// than any real care period lays out, while keeping a train opened months ahead
// (a due date, a scheduled surgery) off the calendar until it is near.
export const CALENDAR_EXPORT_HORIZON_DAYS = 120;
export const CALENDAR_EXPORT_MAX_EVENTS = 100;

/**
 * Build the `calendar_events` payload from the nights of the open trains.
 *
 * Shape matches what the hub's cross-app aggregation consumes — see
 * `normalizeExportedEvent` in packages/hub/src/cloudflare/calendar-feed.ts.
 * Every night is all-day: `dates` carries `meal_date` and no time column, and
 * the hub derives `allDay` from the absence of a `T` in `start` anyway, so a
 * date-only row degrades on its own.
 *
 * `note`, `covered_dish`, `dietary_notes`, `delivery_notes` and `recipient` are
 * deliberately NOT exported. This payload is scope-wide and reaches the
 * household's ICS feed, which external calendar services fetch — and every one
 * of those fields is free text about a family going through a new baby, a
 * surgery, or a loss. `delivery_notes` would be the natural `location`, but it
 * is prose ("cooler on the porch, don't ring the bell, the baby naps at 5"),
 * not an address, so location stays empty rather than smuggling the note out
 * under a different key.
 *
 * The horizon is stepped from `todayIso` — the HOUSEHOLD's day — in UTC rather
 * than from the device clock, for the same reason `datesInRange` does: a bare
 * `yyyy-mm-dd` has no zone, and parsing one through the local clock moves the
 * boundary by a day for half the world.
 */
export function buildCalendarEvents(trains, dates, todayIso) {
  if (typeof todayIso !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(todayIso)) return [];
  const cursor = new Date(`${todayIso}T00:00:00Z`);
  cursor.setUTCDate(cursor.getUTCDate() + CALENDAR_EXPORT_HORIZON_DAYS);
  const horizon = cursor.toISOString().slice(0, 10);

  // Both tables are `adult_writable`, so every member of the scope already
  // reads these rows — which is the bar for exporting them at all.
  const openTrains = new Set(trains.filter(t => t.status === "open").map(t => t.id));

  return dates
    .filter(d => openTrains.has(d.train_id))
    // A closed night is one the organizer took off the list; it needs no meal
    // and belongs on nobody's calendar. A 'covered' one stays: knowing dinner
    // is handled tonight, and by whom, is exactly what the entry is for.
    .filter(d => d.status !== "closed")
    .filter(d => d.meal_date >= todayIso && d.meal_date <= horizon)
    .map(d => ({
      id: d.id,
      // Denormalized onto the night by updateTrain, so this needs no join and
      // cannot name a train under a title it no longer has.
      title: d.train_title,
      description: d.status === "covered" ? "Covered" : "Open",
      location: "",
      start: d.meal_date,
      end: d.meal_date,
      all_day: true,
      // `covered_by` is nullable on purpose: member_references clears it when
      // that person leaves the household, so an orphaned night must read as
      // concerning nobody rather than as `[null]`.
      member_ids: d.covered_by ? [d.covered_by] : [],
      source_label: "Meal Train",
    }))
    .sort((a, b) => String(a.start).localeCompare(String(b.start)))
    .slice(0, CALENDAR_EXPORT_MAX_EVENTS);
}

/**
 * The line a failed write shows ("Refused, gone, or failed" in the app-template guide):
 * "try again" only when retrying can work. `thing` and `action` are the app's own nouns
 * ("connection", "save the connection"). `found` is the caller's re-read after a write that
 * changed nothing (or a 404/409): false = the row is gone, true = it is there in another
 * state. A `forUser` error keeps the message the app wrote for it. Never shows hub text.
 */
export function failureLine(e, { action, thing, found } = {}) {
  if (e?.forUser) return e.message;
  if (e?.code === "UNIQUE_CONSTRAINT" || /UNIQUE constraint failed/i.test(String(e?.message ?? ""))) return `That ${thing} already exists.`;
  if (e?.status === 403) return `You don’t have permission to ${action}.`;
  if (e?.status === 507) return "The household’s storage is full — free up space first.";
  if (found === false || (found === undefined && e?.status === 404)) return `This ${thing} has been removed.`;
  if (found === true || e?.status === 409 || e?.status === 404) return `This ${thing} was changed by someone else — check it first.`;
  return `Couldn’t ${action} — try again.`;
}

/**
 * "Retry after a lost response" (app-template guide): whether a failed write's answer leaves
 * its outcome unknown — no status, a 400, or a 5xx other than 507 — so the page must re-read
 * by its pinned id or stamp before saying anything. A refusal the hub named is known.
 */
export function outcomeUnknown(e) {
  if (e?.forUser || e?.code === "UNIQUE_CONSTRAINT" || /UNIQUE constraint failed/i.test(String(e?.message ?? ""))) return false;
  const s = e?.status;
  return s == null || s === 400 || (s >= 500 && s !== 507);
}

/**
 * What a guarded write with a pinned id/stamp did, decided from the re-read that follows a
 * write that changed nothing (`conflict`: `changed: 0` or a batch's 409) or an unknown outcome.
 *   reread      — the re-read succeeded
 *   landed      — the re-read finds the row carrying THIS attempt's pinned id/stamp
 *   found       — the row is still there (undefined: that part of the read is unknown)
 *   parentFound — the row's container is still loaded (false: it went with it)
 * Returns "landed" (run the success path once), "failed" (unknown outcome, not found: the
 * failure line, pin kept), "unknown" (a conflict the re-read could not explain: the plain line,
 * pin kept), or a refusal — "parent-removed" / "removed" / "changed" (pin forgotten).
 */
export function pinnedWriteOutcome({ conflict, reread, landed, found, parentFound = true }) {
  if (reread && landed) return "landed";
  if (!conflict) return "failed";
  if (!reread) return "unknown";
  if (!parentFound) return "parent-removed";
  if (found === undefined) return "unknown";
  return found ? "changed" : "removed";
}
