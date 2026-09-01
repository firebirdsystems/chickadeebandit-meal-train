import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { describe, it, expect } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(__dirname, "../manifest.json"), "utf-8"));

const VALID_STORAGE   = ["kv", "db", "none"];
const VALID_AUDIENCES = ["everyone", "adults", "children"];

describe("manifest.json", () => {
  it("has required string fields", () => {
    for (const field of ["id", "name", "version", "description", "entrypoint", "runtime", "icon"]) {
      expect(manifest[field], `missing field: ${field}`).toBeTruthy();
    }
  });

  it("entrypoint is index.html", () => expect(manifest.entrypoint).toBe("index.html"));
  it("runtime is static",        () => expect(manifest.runtime).toBe("static"));

  it("storage is declared and valid", () => {
    expect(manifest.storage, "storage field is required").toBeTruthy();
    expect(VALID_STORAGE).toContain(manifest.storage);
  });

  it("version follows semver", () => expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/));

  it("permissions.default_audience is valid", () => {
    expect(VALID_AUDIENCES).toContain(manifest.permissions.default_audience);
  });

  it("permissions.requires_approval is boolean", () => {
    expect(typeof manifest.permissions.requires_approval).toBe("boolean");
  });

  it("data_access has reads and writes arrays", () => {
    expect(Array.isArray(manifest.data_access.reads)).toBe(true);
    expect(Array.isArray(manifest.data_access.writes)).toBe(true);
  });
});

// ── ai_access SQL file validation ─────────────────────────────────────────────
// Auto-discovers all db_exports/db_mutations/db_inserts/db_deletes entries and
// validates each SQL file for type, household_id filter, and single-statement.

if (manifest.ai_access) {
  const ai = manifest.ai_access;

  const SQL_TYPES = [
    { field: "db_exports",   dir: "queries",   keyword: /^(SELECT|WITH)\b/i, label: "SELECT or WITH" },
    { field: "db_mutations", dir: "mutations",  keyword: /^UPDATE\b/i,        label: "UPDATE"         },
    { field: "db_inserts",   dir: "inserts",    keyword: /^INSERT\b/i,        label: "INSERT"         },
    { field: "db_deletes",   dir: "deletes",    keyword: /^DELETE\b/i,        label: "DELETE"         },
  ];

  for (const { field, dir, keyword, label } of SQL_TYPES) {
    const names = ai[field] ?? [];
    if (names.length === 0) continue;

    describe(`ai_access.${field}`, () => {
      it(`each name has a src/${dir}/{name}.sql file`, () => {
        for (const name of names) {
          const path = join(__dirname, `../src/${dir}/${name}.sql`);
          expect(existsSync(path), `missing: src/${dir}/${name}.sql`).toBe(true);
        }
      });

      it(`each SQL file starts with ${label}`, () => {
        for (const name of names) {
          const path = join(__dirname, `../src/${dir}/${name}.sql`);
          if (!existsSync(path)) continue;
          const sql = readFileSync(path, "utf-8").trim();
          expect(
            keyword.test(sql),
            `src/${dir}/${name}.sql must start with ${label}, got: ${sql.slice(0, 50)}`
          ).toBe(true);
        }
      });

      it(`each SQL file is a single statement (no semicolons)`, () => {
        for (const name of names) {
          const path = join(__dirname, `../src/${dir}/${name}.sql`);
          if (!existsSync(path)) continue;
          const sql = readFileSync(path, "utf-8");
          expect(
            sql.includes(";"),
            `src/${dir}/${name}.sql must not contain semicolons`
          ).toBe(false);
        }
      });
    });
  }

  if (ai.db_inserts?.length) {
    describe("ai_access.db_inserts schemas", () => {
      it("each insert has a src/schemas/{name}.json file", () => {
        for (const name of ai.db_inserts) {
          const path = join(__dirname, `../src/schemas/${name}.json`);
          expect(existsSync(path), `missing: src/schemas/${name}.json`).toBe(true);
        }
      });

      it("each schema file is valid JSON", () => {
        for (const name of ai.db_inserts) {
          const path = join(__dirname, `../src/schemas/${name}.json`);
          if (!existsSync(path)) continue;
          expect(
            () => JSON.parse(readFileSync(path, "utf-8")),
            `src/schemas/${name}.json must be valid JSON`
          ).not.toThrow();
        }
      });

      it("each schema declares type:array with an items definition", () => {
        for (const name of ai.db_inserts) {
          const path = join(__dirname, `../src/schemas/${name}.json`);
          if (!existsSync(path)) continue;
          let schema;
          try { schema = JSON.parse(readFileSync(path, "utf-8")); } catch { continue; }
          expect(schema.type, `src/schemas/${name}.json must declare "type": "array"`).toBe("array");
          expect(
            Array.isArray(schema.items) || (typeof schema.items === "object" && schema.items !== null),
            `src/schemas/${name}.json must declare "items" to validate params`
          ).toBe(true);
        }
      });

      it("schema maxItems matches the number of $N placeholders in the SQL", () => {
        for (const name of ai.db_inserts) {
          const sqlPath    = join(__dirname, `../src/inserts/${name}.sql`);
          const schemaPath = join(__dirname, `../src/schemas/${name}.json`);
          if (!existsSync(sqlPath) || !existsSync(schemaPath)) continue;
          const sql = readFileSync(sqlPath, "utf-8");
          let schema;
          try { schema = JSON.parse(readFileSync(schemaPath, "utf-8")); } catch { continue; }
          const paramNums = [...sql.matchAll(/\$(\d+)/g)].map(m => parseInt(m[1], 10));
          const maxParam  = paramNums.length > 0 ? Math.max(...paramNums) : 0;
          expect(
            schema.maxItems,
            `src/schemas/${name}.json maxItems (${schema.maxItems}) must equal SQL $N count (${maxParam})`
          ).toBe(maxParam);
        }
      });
    });
  }
}

// The Today agenda and the glance tile both read `dates`, the CHILD table. Every
// filter a train-level decision implies therefore has to be spelled out here —
// the row itself only knows about one night. Closing a train used to leave its
// nights on Today and on the home tile, still inviting a meal for a train whose
// share links had already stopped working.
describe("the Today and glance surfaces respect the parent train", () => {
  const surfaces = [
    ["agenda", manifest.agenda?.source?.query],
    ["glance", manifest.glance?.source?.query],
  ];

  for (const [name, query] of surfaces) {
    describe(name, () => {
      it("is a sql surface over the dates table", () => {
        expect(query, `manifest.${name}.source.query is missing`).toBeTruthy();
        expect(query).toContain("app_meal_train__dates");
      });

      it("joins the parent train and requires it to be open", () => {
        // Same shape trip-planner and kids-activities use: the parent's flag
        // lives in the JOIN ... ON, so a closed train drops its children rather
        // than surfacing them with a stale title.
        expect(query).toContain("JOIN app_meal_train__trains");
        expect(query).toMatch(/ON t\.id = d\.train_id AND t\.status = 'open'/);
      });

      it("still filters out the nights the app itself closed", () => {
        // The train-level gate is additional to the per-night one, never a
        // replacement: an open train can hold a night an organizer shut.
        expect(query).toMatch(/d\.status (?:!=|=) 'open'|d\.status != 'closed'/);
      });

      it("compares the day token against a plaintext column", () => {
        // meal_date earns plaintext from its _date suffix. An encrypted column
        // here would never compare equal and the surface would go silently empty.
        expect(query).toContain("d.meal_date");
        expect(query).toContain(":today");
      });
    });
  }

  it("keeps guest-full nights out of the needs-a-meal glance", () => {
    const query = manifest.glance.source.query;
    expect(query).toContain("SELECT COUNT(*) FROM app_meal_train__guest_claims g");
    expect(query).toContain("g.train_id = d.train_id AND g.date_id = d.id");
    expect(query).toContain("COALESCE(d.capacity, 0) > 0");
    // capacity zero reserves a night for household members, so it remains a need.
    expect(query).toMatch(/NOT \(COALESCE\(d\.capacity, 0\) > 0 AND .*COUNT/s);
  });
});

// Two fixes live at call sites rather than in an exported function, and the UI
// harness cannot reach either (the deep link needs a query string the runner
// does not pass, and the close path is gated on a confirm dialog the hub renders
// in the PARENT frame, outside the frame the runner drives). Pin them in the
// source instead of leaving them uncovered.
describe("index.html call sites", () => {
  const html = readFileSync(join(__dirname, "../src/index.html"), "utf-8");

  it("applies ?trainId on the first load only", () => {
    // handleDeepLink() used to run inside refresh(), so pressing Refresh after
    // backing out of a deep-linked train threw the organizer straight back into it.
    // Awaited since the archive split: a ?trainId pointing at a CLOSED train
    // now has to pull the closed set before it can select it.
    expect(html).toContain("if (deepLink) await handleDeepLink();");
    expect(html).toContain("refresh({ deepLink: true })");
    expect(html.match(/handleDeepLink\(\)/g)).toHaveLength(2); // the guarded call + the declaration
  });

  it("clears the member claim in the same UPDATE that closes a night", () => {
    expect(html).toMatch(
      /UPDATE app_meal_train__dates SET status = \?, covered_by = NULL, covered_dish = '', covered_at = NULL WHERE id = \?/
    );
  });

  it("never turns a typed allowance into a bare Number(x) || 0", () => {
    // That idiom reads a cleared input as zero, which shuts the night to the
    // share link. parseCapacity() carries the fallback instead.
    expect(html).not.toMatch(/Number\(\s*(?:raw|capacity)\s*\)\s*\|\|\s*0/);
    expect(html).toContain("parseCapacity(capacity, 1)");
    expect(html).toContain("parseCapacity(raw, current)");
  });
});

// The scenarios run the agenda and glance queries against the REAL runtime —
// the static validator only proves they parse. That is only worth anything
// while the two copies agree, so pin them: the scenario SQL must be the
// manifest SQL with the day token bound, since :today is the one thing the
// app-SQL door cannot bind for itself.
describe("the surface scenarios run the manifest's own queries", () => {
  const scenarios = JSON.parse(readFileSync(join(__dirname, "../scenarios.json"), "utf-8")).scenarios;
  const surfaceScenario = scenarios.find(s => s.name.includes("closed train"));
  const sqlOf = (marker) => surfaceScenario?.steps
    .filter(step => step.action === "db")
    .map(step => step.sql)
    .find(sql => sql.includes(marker));

  it("has a scenario exercising both surfaces", () => {
    expect(surfaceScenario, "no scenario covering the closed-train surface filter").toBeTruthy();
  });

  it("runs the agenda query verbatim", () => {
    expect(sqlOf("AS when_at")).toBe(manifest.agenda.source.query.replaceAll(":today", "'2026-03-01'"));
  });

  it("runs the glance query verbatim", () => {
    expect(sqlOf("AS at")).toBe(manifest.glance.source.query.replaceAll(":today", "'2026-03-01'"));
  });
});
