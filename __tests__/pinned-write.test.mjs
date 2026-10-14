import { describe, it, expect } from "vitest";
import { outcomeUnknown, pinnedWriteOutcome } from "../src/logic.js";

const err = (props, message = "hub text") => Object.assign(new Error(message), props);

describe("outcomeUnknown", () => {
  it("is unknown with no status, a 400, or a 5xx other than 507", () => {
    expect(outcomeUnknown(new TypeError("Failed to fetch"))).toBe(true);
    expect(outcomeUnknown(err({ status: 400 }))).toBe(true);
    expect(outcomeUnknown(err({ status: 500 }))).toBe(true);
    expect(outcomeUnknown(err({ status: 503 }))).toBe(true);
  });
  it("is known for a refusal the hub named", () => {
    expect(outcomeUnknown(err({ status: 403 }))).toBe(false);
    expect(outcomeUnknown(err({ status: 404 }))).toBe(false);
    expect(outcomeUnknown(err({ status: 409 }))).toBe(false);
    expect(outcomeUnknown(err({ status: 507 }))).toBe(false);
    expect(outcomeUnknown(err({ status: 400, code: "UNIQUE_CONSTRAINT" }))).toBe(false);
    expect(outcomeUnknown(err({ status: 400 }, "UNIQUE constraint failed: x.id"))).toBe(false);
    expect(outcomeUnknown(err({ forUser: true }, "Pick a night"))).toBe(false);
  });
});

describe("pinnedWriteOutcome", () => {
  it("a re-read carrying this attempt's pin means it landed, conflict or not", () => {
    expect(pinnedWriteOutcome({ conflict: true, reread: true, landed: true, found: true })).toBe("landed");
    expect(pinnedWriteOutcome({ conflict: false, reread: true, landed: true, found: true })).toBe("landed");
    expect(pinnedWriteOutcome({ conflict: true, reread: true, landed: true, found: undefined, parentFound: false })).toBe("landed");
  });
  it("an unknown outcome that did not land stays a plain failure", () => {
    expect(pinnedWriteOutcome({ conflict: false, reread: true, landed: false, found: true })).toBe("failed");
    expect(pinnedWriteOutcome({ conflict: false, reread: false, landed: false })).toBe("failed");
  });
  it("a conflict the re-read cannot explain is unknown, never a claim", () => {
    expect(pinnedWriteOutcome({ conflict: true, reread: false, landed: false })).toBe("unknown");
    expect(pinnedWriteOutcome({ conflict: true, reread: true, landed: false, found: undefined })).toBe("unknown");
  });
  it("a conflict that did not land is a refusal, split by the re-read", () => {
    expect(pinnedWriteOutcome({ conflict: true, reread: true, landed: false, found: true })).toBe("changed");
    expect(pinnedWriteOutcome({ conflict: true, reread: true, landed: false, found: false })).toBe("removed");
    expect(pinnedWriteOutcome({ conflict: true, reread: true, landed: false, found: false, parentFound: false })).toBe("parent-removed");
  });
});
