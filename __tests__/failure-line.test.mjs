import { describe, it, expect } from "vitest";
import { failureLine } from "../src/logic.js";

const err = (props, message = "hub text") => Object.assign(new Error(message), props);
const words = { action: "save the item", thing: "item" };

describe("failureLine", () => {
  it("names a duplicate by code, or by the hub's text while production lags", () => {
    expect(failureLine(err({ status: 400, code: "UNIQUE_CONSTRAINT" }), words)).toBe("That item already exists.");
    expect(failureLine(err({ status: 400 }, "UNIQUE constraint failed: x.id"), words)).toBe("That item already exists.");
  });
  it("names a refusal without asking for a retry", () => {
    expect(failureLine(err({ status: 403 }), words)).toBe("You don’t have permission to save the item.");
    expect(failureLine(err({ status: 507 }), words)).toBe("The household’s storage is full — free up space first.");
  });
  it("splits a write that changed nothing by the caller's re-read", () => {
    expect(failureLine(null, { ...words, found: false })).toBe("This item has been removed.");
    expect(failureLine(null, { ...words, found: true })).toBe("This item was changed by someone else — check it first.");
    expect(failureLine(err({ status: 409 }), { ...words, found: false })).toBe("This item has been removed.");
    expect(failureLine(err({ status: 409 }), { ...words, found: true })).toBe("This item was changed by someone else — check it first.");
  });
  it("reads a 404 as removed and a bare 409 as changed when there is no re-read", () => {
    expect(failureLine(err({ status: 404 }), words)).toBe("This item has been removed.");
    expect(failureLine(err({ status: 409 }), words)).toBe("This item was changed by someone else — check it first.");
  });
  it("asks for a retry only when retrying can work", () => {
    for (const e of [err({}), err({ status: 500 }), err({ status: 503 }), err({ status: 400 }), new TypeError("Failed to fetch"), undefined]) {
      expect(failureLine(e, words)).toBe("Couldn’t save the item — try again.");
    }
  });
  it("keeps a line the app wrote for the user, and never shows hub text", () => {
    expect(failureLine(err({ forUser: true }, "Pick a date first."), words)).toBe("Pick a date first.");
    expect(failureLine(err({ status: 500 }, "D1_ERROR: boom"), words)).not.toMatch(/D1_ERROR/);
  });
});
