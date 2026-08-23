import { describe, it, expect } from "vitest";
import {
  canManage, resolveCurrentMember, dateLabel, datesInRange, normalizeTimestamp,
  guestClaimsForDate, guestClaimCount, isDateGuestFull, acceptsLinkSignups, parseCapacity,
  dateState, isDateHandled, toggledClosedFields,
  isOrphanedCoverage, datesForTrain, openDatesForForm, trainTotals, searchableFields,
} from "../src/logic.js";

const adult = { id: "a1", name: "Alex", role: "adult" };
const child = { id: "c1", name: "Casey", role: "child" };

const date = (over = {}) => ({
  id: "d1", train_id: "t1", meal_date: "2026-03-03", label: "Tue, Mar 3",
  train_title: "Alvarez", note: "", capacity: 1, status: "open",
  covered_by: null, covered_dish: "", covered_at: null, created_at: "2026-03-01T00:00:00Z",
  ...over,
});
const guest = (over = {}) => ({
  id: "g1", train_id: "t1", date_id: "d1", guest_name: "Marta",
  bringing: "Lasagna", guest_note: "", created_at: "2026-03-01 17:04:00", ...over,
});

describe("canManage", () => {
  it("mirrors the adult_writable policy on trains and dates", () => {
    expect(canManage(adult)).toBe(true);
    expect(canManage(child)).toBe(false);
    expect(canManage(null)).toBe(false);
  });
});

describe("resolveCurrentMember", () => {
  it("uses only the hub-injected identity in an installed app", () => {
    expect(resolveCurrentMember(child, [adult], false)).toBe(child);
    expect(resolveCurrentMember(null, [adult], false)).toEqual({
      id: "guest", name: "Guest", role: "guest",
    });
  });

  it("keeps the standalone demo interactive", () => {
    expect(resolveCurrentMember(null, [adult], true)).toBe(adult);
  });
});

describe("dateLabel", () => {
  it("formats the human date the public form's dropdown shows", () => {
    expect(dateLabel("2026-03-03")).toBe("Tue, Mar 3");
    expect(dateLabel("2026-12-25")).toBe("Fri, Dec 25");
  });

  it("does not shift the weekday with the device timezone", () => {
    // The input is a bare yyyy-mm-dd with no zone. Reading it through LOCAL
    // getters names the previous day west of UTC — the same class of bug as
    // `date('now')` in an agenda query. `naive` is the implementation this one
    // is not: if the timezone swap below ever stops taking effect, the control
    // assertion fails rather than letting the real one pass vacuously.
    const naive = (iso) => new Date(iso).getDate();
    const original = process.env.TZ;
    try {
      process.env.TZ = "Pacific/Midway";       // UTC-11
      expect(naive("2026-03-03"), "timezone swap had no effect — this test proves nothing").toBe(2);
      expect(dateLabel("2026-03-03")).toBe("Tue, Mar 3");
      process.env.TZ = "Pacific/Kiritimati";   // UTC+14
      expect(dateLabel("2026-03-03")).toBe("Tue, Mar 3");
    } finally {
      if (original === undefined) delete process.env.TZ; else process.env.TZ = original;
    }
  });

  it("passes anything that is not a plain date through untouched", () => {
    expect(dateLabel("")).toBe("");
    expect(dateLabel(null)).toBe("");
  });
});

describe("datesInRange", () => {
  it("covers the whole care period, inclusive of both ends", () => {
    expect(datesInRange("2026-03-01", "2026-03-04"))
      .toEqual(["2026-03-01", "2026-03-02", "2026-03-03", "2026-03-04"]);
  });

  it("crosses a month and a daylight-saving boundary without skipping a day", () => {
    // US DST starts 2026-03-08. Stepping in local time would repeat or skip it.
    expect(datesInRange("2026-03-07", "2026-03-09"))
      .toEqual(["2026-03-07", "2026-03-08", "2026-03-09"]);
    expect(datesInRange("2026-01-30", "2026-02-02"))
      .toEqual(["2026-01-30", "2026-01-31", "2026-02-01", "2026-02-02"]);
  });

  it("treats a missing or backwards end as a single night", () => {
    expect(datesInRange("2026-03-03", "")).toEqual(["2026-03-03"]);
    expect(datesInRange("2026-03-03", "2026-03-01")).toEqual(["2026-03-03"]);
  });

  it("is bounded, so a typo'd year cannot try to open thousands of rows", () => {
    expect(datesInRange("2026-03-01", "2099-03-01")).toHaveLength(60);
  });

  it("returns nothing without a valid start", () => {
    expect(datesInRange("", "2026-03-04")).toEqual([]);
    expect(datesInRange("nonsense", "2026-03-04")).toEqual([]);
  });
});

describe("normalizeTimestamp", () => {
  it("reads SQLite's datetime('now') as the UTC it actually is", () => {
    // guest_claims.created_at comes from a DB default, not from the app, and
    // its space-separated form is parsed as LOCAL time by JS.
    expect(normalizeTimestamp("2026-03-01 17:04:00")).toBe("2026-03-01T17:04:00Z");
  });

  it("leaves an ISO stamp and non-strings alone", () => {
    expect(normalizeTimestamp("2026-03-01T17:04:00Z")).toBe("2026-03-01T17:04:00Z");
    expect(normalizeTimestamp(null)).toBe(null);
  });
});

describe("the guest ledger", () => {
  it("counts only sign-ups naming that night", () => {
    const guests = [guest(), guest({ id: "g2", date_id: "d2" })];
    expect(guestClaimsForDate(guests, "d1")).toHaveLength(1);
    expect(guestClaimCount(guests, "d2")).toBe(1);
  });

  it("matches no night for an empty date id", () => {
    expect(guestClaimsForDate([guest({ date_id: "" })], "")).toEqual([]);
  });

  it("fills a night at capacity, mirroring the hub's own claim predicate", () => {
    expect(isDateGuestFull(date({ capacity: 1 }), [guest()])).toBe(true);
    expect(isDateGuestFull(date({ capacity: 2 }), [guest()])).toBe(false);
  });

  it("reads a zero allowance as full, so it fails closed exactly like the hub", () => {
    // The hub's predicate is `COUNT >= COALESCE(capacity, 0)`. A night with no
    // link spots must look closed to visitors here too, or the app would offer
    // a sign-up the submit endpoint refuses.
    expect(isDateGuestFull(date({ capacity: 0 }), [])).toBe(true);
    expect(isDateGuestFull(date({ capacity: null }), [])).toBe(true);
  });

  it("separates 'not on offer to visitors' from 'the visitors filled it'", () => {
    // Both read full by the hub's predicate, and only one of them means a meal
    // is handled — which is the distinction dateState below turns on.
    expect(acceptsLinkSignups(date({ capacity: 0 }))).toBe(false);
    expect(acceptsLinkSignups(date({ capacity: null }))).toBe(false);
    expect(acceptsLinkSignups(date({ capacity: 1 }))).toBe(true);
  });
});

describe("parseCapacity", () => {
  it("reads a typed allowance, floored", () => {
    expect(parseCapacity("3")).toBe(3);
    expect(parseCapacity("2.7")).toBe(2);
    expect(parseCapacity(0)).toBe(0);
  });

  it("treats a cleared field as 'leave it alone', never as zero", () => {
    // `Number("") || 0` is 0, which would silently shut the night to the share
    // link the moment somebody cleared the box or tabbed through the add form.
    // Zero closes a door and has to be typed on purpose.
    expect(parseCapacity("", 1)).toBe(1);
    expect(parseCapacity(undefined, 1)).toBe(1);
    expect(parseCapacity(null, 4)).toBe(4);
  });

  it("refuses what CHECK (capacity >= 0) would reject, and nonsense", () => {
    expect(parseCapacity("-1", 1)).toBe(1);
    expect(parseCapacity("lots", 2)).toBe(2);
    expect(parseCapacity(NaN, 2)).toBe(2);
  });
});

describe("dateState", () => {
  it("distinguishes the two ways a night gets covered", () => {
    expect(dateState(date(), [])).toBe("open");
    expect(dateState(date({ status: "covered", covered_by: "a1" }), [])).toBe("covered");
    expect(dateState(date({ status: "closed" }), [])).toBe("closed");
    expect(dateState(date({ capacity: 1 }), [guest()])).toBe("full");
  });

  it("leaves a night with no link spots OPEN — zero capacity shuts one door, not both", () => {
    // `capacity: 0` is how an organizer keeps a night for the household while
    // the share link is live. It is full by the hub's predicate (no visitor can
    // claim it) but nobody is bringing that meal: reading it as `full` painted
    // the night "Covered by the link", took away the member "I'll bring this
    // one" button, and counted it as handled — the exact opposite of the intent.
    expect(dateState(date({ capacity: 0 }), [])).toBe("open");
    expect(dateState(date({ capacity: null }), [])).toBe("open");
    expect(isDateHandled(date({ capacity: 0 }), [])).toBe(false);
  });

  it("still calls it full once a spot that WAS offered is taken", () => {
    // The distinction is "was the link ever open here", not "is capacity zero
    // now" — an organizer lowering spots to 0 after a neighbour signed up must
    // not un-cover their meal.
    expect(dateState(date({ capacity: 0 }), [guest()])).toBe("open");
    expect(dateState(date({ capacity: 1 }), [guest()])).toBe("full");
  });

  it("counts a night as handled whether a member or a neighbour took it", () => {
    expect(isDateHandled(date({ status: "covered" }), [])).toBe(true);
    expect(isDateHandled(date(), [guest()])).toBe(true);
    expect(isDateHandled(date(), [])).toBe(false);
    expect(isDateHandled(date({ status: "closed" }), [])).toBe(false);
  });
});

describe("toggledClosedFields", () => {
  it("clears the member claim when a covered night is closed", () => {
    expect(toggledClosedFields(date({ status: "covered", covered_by: "a1", covered_dish: "Chili", covered_at: "x" })))
      .toEqual({ status: "closed", covered_by: null, covered_dish: "", covered_at: null });
  });

  it("reopens to a night nobody is claiming", () => {
    // The bug this pins: rewriting `status` alone left covered_by set on an
    // OPEN row, so the agenda query (which reads covered_by straight off the
    // row) credited an unclaimed meal to a member who had given it up — and
    // isOrphanedCoverage, which only inspects 'covered' rows, could not see it.
    const reopened = { ...date({ status: "closed" }), ...toggledClosedFields(date({ status: "closed", covered_by: "a1", covered_dish: "Chili" })) };
    expect(reopened.status).toBe("open");
    expect(reopened.covered_by).toBe(null);
    expect(reopened.covered_dish).toBe("");
    expect(dateState(reopened, [])).toBe("open");
  });
});

describe("isOrphanedCoverage", () => {
  it("flags a night whose member left the household", () => {
    // member_references clears covered_by to NULL on departure but cannot
    // reopen the night, so nothing would be bringing that meal.
    expect(isOrphanedCoverage(date({ status: "covered", covered_by: null }))).toBe(true);
    expect(isOrphanedCoverage(date({ status: "covered", covered_by: "a1" }))).toBe(false);
    expect(isOrphanedCoverage(date({ status: "open", covered_by: null }))).toBe(false);
  });
});

describe("openDatesForForm", () => {
  const dates = [
    date({ id: "d1", meal_date: "2026-03-01" }),
    date({ id: "d2", meal_date: "2026-03-02", status: "covered", covered_by: "a1" }),
    date({ id: "d3", meal_date: "2026-03-03", status: "closed" }),
    date({ id: "d4", meal_date: "2026-03-04", capacity: 0 }),
    date({ id: "d5", meal_date: "2026-03-05", train_id: "other" }),
  ];

  it("offers exactly what the manifest's values_from filter would", () => {
    // status = 'open' (the declared where) minus the ones the hub's capacity
    // claim would refuse.
    expect(openDatesForForm(dates, [], "t1").map(d => d.id)).toEqual(["d1"]);
  });

  it("withholds a zero-spot night from the form even though it still needs a meal", () => {
    // d4 reads `open` for the household — a member may take it — and must still
    // never be offered to a visitor, because the hub's claim would refuse it.
    // The two halves of `capacity: 0` are asserted together here so a fix to
    // one cannot quietly undo the other.
    const d4 = dates.find(d => d.id === "d4");
    expect(dateState(d4, [])).toBe("open");
    expect(openDatesForForm(dates, [], "t1").map(d => d.id)).not.toContain("d4");
  });

  it("drops a night once link sign-ups fill it", () => {
    const open = openDatesForForm([date({ id: "d1", capacity: 1 })], [guest()], "t1");
    expect(open).toEqual([]);
  });

  it("is what the share dialog warns on: an empty list means the form is dead", () => {
    // The date select is `required`, so with no pickable option the public form
    // fails closed and the link collects nothing.
    expect(openDatesForForm(dates, [], "nobody-home")).toEqual([]);
  });

  it("keeps nights in date order", () => {
    const shuffled = [date({ id: "b", meal_date: "2026-03-09" }), date({ id: "a", meal_date: "2026-03-02" })];
    expect(datesForTrain(shuffled, "t1").map(d => d.id)).toEqual(["a", "b"]);
  });
});

describe("trainTotals", () => {
  const dates = [
    date({ id: "d1" }),
    date({ id: "d2", status: "covered", covered_by: "a1" }),
    date({ id: "d3", status: "closed" }),
  ];

  it("counts both ledgers toward one progress number", () => {
    // d2 by a member, d1 by a neighbour; d3 is closed and out of the reckoning.
    const t = trainTotals("t1", dates, [guest({ date_id: "d1" })]);
    expect(t).toMatchObject({ handled: 2, total: 2, pct: 100, complete: true });
  });

  it("does not count a closed night as needing a meal", () => {
    expect(trainTotals("t1", [date({ id: "d3", status: "closed" })], []))
      .toMatchObject({ handled: 0, total: 0, complete: false });
  });

  it("counts a zero-spot night as still needing a meal", () => {
    // Closing a night to the link is not coverage. Counting it as handled told
    // the organizer the train was full when nobody had agreed to cook.
    expect(trainTotals("t1", [date({ id: "d1", capacity: 0 })], []))
      .toMatchObject({ handled: 0, total: 1, pct: 0, complete: false });
  });

  it("reports partial progress", () => {
    expect(trainTotals("t1", dates, [])).toMatchObject({ handled: 1, total: 2, pct: 50, complete: false });
  });
});

describe("searchableFields", () => {
  it("finds a train by the family it is feeding, not just its title", () => {
    const fields = searchableFields({ title: "Two weeks of dinners", recipient: "Alvarez", description: "New baby" });
    expect(fields).toContain("Alvarez");
    expect(fields).toContain("New baby");
  });
});
