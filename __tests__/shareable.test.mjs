import { readFileSync, readdirSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { describe, it, expect } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(__dirname, "../manifest.json"), "utf-8"));
const appHtml = readFileSync(join(__dirname, "../src/index.html"), "utf-8");
const logicJs = readFileSync(join(__dirname, "../src/logic.js"), "utf-8");

const migrationsDir = join(__dirname, "../migrations");
const schema = readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(join(migrationsDir, f), "utf-8"))
  .join("\n");

// Mirrors the hub's BUILTIN_APP_DB_PLAINTEXT_COLS + suffix rules
// (packages/hub/src/cloudflare/manifest-common.ts). A column the hub filters,
// orders, joins or compares on must be plaintext: ciphertext is AES-GCM with a
// random IV, so an equality against an encrypted column silently matches
// nothing and a numeric comparison is meaningless.
const BUILTIN_PLAINTEXT = new Set([
  "id", "household_id", "created_at", "updated_at", "sent_at", "read_at",
  "expires_at", "last_synced_at", "completed", "all_day",
  "status", "type", "category", "week", "emoji", "icon",
  "position", "sort_order", "pinned", "key", "version",
  "visibility", "audience",
  "membership_type", "membership_roles",
]);

function isPlaintext(column) {
  return (
    BUILTIN_PLAINTEXT.has(column) ||
    /_(id|at|date|by)$/.test(column) ||
    (manifest.db_plaintext_columns ?? []).includes(column)
  );
}

function columnsOf(table) {
  const body = schema.match(
    new RegExp(`CREATE TABLE IF NOT EXISTS app_meal_train__${table} \\(([\\s\\S]*?)\\n\\);`),
  );
  expect(body, `no CREATE TABLE for ${table}`).toBeTruthy();
  const created = body[1]
    .split("\n")
    .map((line) => line.trim().match(/^([a-z_]+)\s+(TEXT|INTEGER|REAL|BLOB)\b/))
    .filter(Boolean)
    .map((m) => m[1]);
  // Later migrations add columns by ALTER; read those too, or this helper
  // reports a live column as missing (the trap volunteer hit).
  const altered = [...schema.matchAll(
    new RegExp(`ALTER TABLE app_meal_train__${table} ADD COLUMN ([a-z_]+)\\b`, "g"),
  )].map((m) => m[1]);
  return [...created, ...altered];
}

const item = manifest.shareable.train;
const feed = item.feed;
const submit = item.submit;
const dateField = submit.fields.find((f) => f.column === "date_id");

describe("shareable.train", () => {
  it("shares the train itself, and projects only columns it has", () => {
    expect(item.table).toBe("trains");
    const columns = columnsOf("trains");
    expect(columns).toContain(item.title_column);
    for (const col of item.columns) {
      expect(columns, `item projects unknown column ${col.column}`).toContain(col.column);
    }
  });

  it("closes every link on a train by closing the train", () => {
    // Share reads BYPASS row policies, so the only gate on the public page is
    // this one. It admits `open` alone: a closed train must stop both showing
    // and — because the submit path re-checks the same predicate — collecting.
    expect(item.visible_where).toEqual({ column: "status", values: ["open"] });
    expect(isPlaintext("status")).toBe(true);
  });

  it("declares no owner_column, so an automation-opened train is still shareable", () => {
    // `owner_column` gates minting on created_by matching the caller. The
    // open_train automation writes created_by = "automation", which is no
    // member id — an owner gate would make exactly the trains an automation
    // opens permanently unshareable. Adult is the gate instead.
    expect(item.owner_column).toBeUndefined();
    expect(manifest.automation_actions.open_train.steps[0].values.created_by).toBe("automation");
  });

  it("never publishes a member's name or id to the internet", () => {
    // `dates` carries covered_by. The feed and every aggregate read
    // guest_claims, which has no member column at all.
    const tables = [feed.table, ...(item.aggregates ?? []).map((a) => a.table)];
    expect(tables.every((t) => t === "guest_claims")).toBe(true);
    expect(columnsOf("guest_claims").some((c) => c === "member_id" || c === "covered_by")).toBe(false);
  });
});

describe("shareable.train.feed", () => {
  it("reads the guest table the share form writes to", () => {
    expect(feed.table).toBe(submit.table);
    expect(feed.fk_column).toBe(submit.fk_column);
    expect(feed.fk_column).toBe("train_id");
  });

  it("projects only columns that exist on guest_claims", () => {
    const columns = columnsOf("guest_claims");
    for (const col of feed.columns) {
      expect(columns, `feed projects unknown column ${col.column}`).toContain(col.column);
    }
  });

  it("orders on a plaintext column that exists", () => {
    expect(columnsOf("guest_claims")).toContain(feed.order_column);
    expect(isPlaintext(feed.order_column), `${feed.order_column} must be plaintext to order on`).toBe(true);
  });

  it("declares no filters it cannot enforce", () => {
    for (const filter of feed.where ?? []) expect(isPlaintext(filter.column)).toBe(true);
    if (feed.parent_where) expect(isPlaintext(feed.parent_where.column)).toBe(true);
  });

  it("publishes every column the guest was asked for, and nothing else", () => {
    const submitted = new Set(submit.fields.map((f) => f.column));
    for (const col of feed.columns.map((c) => c.column)) {
      if (col === "created_at") continue;          // stamped by the DB, not typed
      if (col === "date_id") continue;             // never projected — see below
      expect(submitted, `feed publishes ${col}, which no guest typed`).toContain(col);
    }
  });

  it("never publishes the raw date id", () => {
    // A feed prints stored values and cannot join, so projecting date_id would
    // show visitors a UUID. The `list` aggregate is what resolves those ids.
    expect(feed.columns.some((c) => c.column === "date_id")).toBe(false);
  });

  it("cannot truncate: the feed shows every row the app will ever hold", () => {
    expect(feed.max_items).toBe(submit.max_submissions);
    expect(feed.max_items).toBe(manifest.row_policies.guest_claims.max_rows);
  });
});

describe("shareable.train.aggregates", () => {
  const list = item.aggregates.find((a) => a.op === "list");

  it("resolves date ids to human dates through a lookup", () => {
    // Feeds cannot join; runAggregate's list op can. This is the only way the
    // public page says WHICH night each neighbour took.
    expect(list.table).toBe("guest_claims");
    expect(list.value_column).toBe("date_id");
    expect(list.lookup).toEqual({ table: "dates", label_column: "label" });
    expect(isPlaintext(list.value_column), "the lookup JOINs on this column; ciphertext never joins").toBe(true);
    expect(columnsOf("dates")).toContain(list.lookup.label_column);
  });

  it("counts guest rows only", () => {
    const count = item.aggregates.find((a) => a.op === "count");
    expect(count.table).toBe("guest_claims");
    expect(count.fk_column).toBe("train_id");
  });
});

// The dynamic night select: the hub resolves `dates` for the public form and
// folds a per-option capacity claim into the INSERT's own WHERE, so two
// visitors can never take the same last night.
describe("shareable.train.submit.date_id (values_from)", () => {
  it("is a select sourcing its choices from the dates table", () => {
    expect(dateField.type).toBe("select");
    expect(dateField.values, "values and values_from are mutually exclusive").toBeUndefined();
    expect(dateField.values_from.table).toBe("dates");
    expect(dateField.values_from.fk_column).toBe("train_id");
  });

  it("keys options on columns the dates table actually has", () => {
    const columns = columnsOf("dates");
    for (const key of ["fk_column", "id_column", "label_column", "capacity_column"]) {
      expect(columns, `dates has no ${dateField.values_from[key]}`).toContain(dateField.values_from[key]);
    }
  });

  it("labels each option with a human date, not a raw yyyy-mm-dd", () => {
    // The hub projects a stored column into that dropdown and cannot format a
    // date, so the app writes `label` from dateLabel() — see the pairing test
    // below, which is what keeps it from drifting off meal_date.
    expect(dateField.values_from.label_column).toBe("label");
    expect(logicJs).toContain("export function dateLabel(");
  });

  it("writes the chosen option id into a real, plaintext column", () => {
    expect(columnsOf("guest_claims")).toContain("date_id");
    expect(isPlaintext("date_id"), "the hub writes the option id raw, outside the codec").toBe(true);
  });

  it("bounds guests with ONE capacity column, because there is no second ledger", () => {
    // volunteer and potluck need a separate guest_capacity: their members claim
    // rows in a table the hub also counts, so one column would be spent twice.
    // Here a member claim sets dates.status = 'covered', which removes the
    // night from this select entirely — the two doors shut together, and
    // `capacity` bounds link sign-ups alone.
    expect(dateField.values_from.capacity_column).toBe("capacity");
    expect(isPlaintext("capacity")).toBe(true);
    expect(columnsOf("dates")).not.toContain("guest_capacity");
    expect(appHtml).toMatch(/SET status = 'covered', covered_by = \?, covered_dish = \?, covered_at = \?/);
    expect(appHtml).toContain("NOT EXISTS (");
    expect(appHtml).toContain("SELECT 1 FROM app_meal_train__guest_claims g");
    expect(appHtml).toContain("result.changed !== 1");
  });

  it("offers only nights the app itself considers open", () => {
    expect(dateField.values_from.where).toEqual([{ column: "status", values: ["open"] }]);
    expect(isPlaintext("status")).toBe(true);
  });

  it("is required, so nobody can sign up while dodging the capacity bound", () => {
    // A meal offered for no particular night is useless to the family AND is a
    // way past `capacity` entirely. When every night is taken the form fails
    // closed, which is correct here: the train is covered. The share dialog
    // warns when that happens for the wrong reason (no nights laid out yet).
    expect(dateField.required).toBe(true);
    expect(appHtml).toContain('data-testid="share-no-dates"');
    expect(appHtml).toContain("openForForm(trainId).length");
  });

  it("stays inside the hub's single-statement bind budget", () => {
    // id + fk, one per field, one per fixed value, parent admission (parent id
    // + visible_where values + owner + max_rows), and per dynamic select one
    // option id plus each of its filter values.
    const gate = item.visible_where?.values?.length ?? 0;
    const dynamic = submit.fields
      .filter((f) => f.values_from)
      .reduce((n, f) => n + 1 + (f.values_from.where ?? []).reduce((k, w) => k + w.values.length, 0), 0);
    const total = 2 + submit.fields.length
      + Object.keys(submit.fixed_values ?? {}).length
      + 1 + gate
      + (item.owner_column ? 1 : 0)
      + (manifest.row_policies.guest_claims.max_rows ? 1 : 0)
      + dynamic;
    expect(total).toBeLessThanOrEqual(80);
  });
});

describe("shareable.train.submit fields", () => {
  it("writes only plaintext columns — the submit path never runs the codec", () => {
    const columns = columnsOf("guest_claims");
    for (const field of submit.fields) {
      expect(columns, `guest_claims has no ${field.column}`).toContain(field.column);
      expect(isPlaintext(field.column), `${field.column} is written outside the codec`).toBe(true);
    }
    for (const column of Object.keys(submit.fixed_values ?? {})) {
      expect(isPlaintext(column)).toBe(true);
    }
  });

  it("asks what they are bringing, which is the whole point of a meal train", () => {
    const bringing = submit.fields.find((f) => f.column === "bringing");
    expect(bringing.required).toBe(true);
  });

  it("lets the DB stamp created_at, because an external INSERT never sets it", () => {
    // The submit path writes id + fk + declared fields and nothing else, so any
    // other NOT NULL column needs a DB default. SQLite cannot add one by ALTER
    // later, which is why it is in 001.
    expect(schema).toMatch(/created_at TEXT NOT NULL DEFAULT \(datetime\('now'\)\)/);
    expect(logicJs).toContain("export function normalizeTimestamp(");
  });

  it("does not declare the submit event in publishes", () => {
    // Declaring it would let any household member forge a "a neighbour signed
    // up" event through the events endpoint. memory-wall sets the precedent.
    expect(manifest.publishes).not.toContain(submit.event);
  });
});

// Guest rows are authored by anonymous visitors through a path that bypasses
// every member-side gate, so the table stays endpoint_only: the app may read
// the rows but may never edit or delete them. Widening it to adult_writable
// would hand every adult in a shared space edit rights over sign-ups on someone
// else's train — steward_writes_only is inert outside a roster, and meal-train
// cannot be roster-installed anyway (its contexts carry no shared_space.roster
// token) — a worse trade than living without a delete affordance.
describe("row_policies.guest_claims", () => {
  const policy = manifest.row_policies.guest_claims;

  it("stays write-closed to members", () => {
    expect(policy.kind).toBe("endpoint_only");
    expect(policy.read).toBe("everyone");
  });

  it("declares no member-facing write surface over external rows", () => {
    expect(policy.steward_writes_only).toBeUndefined();
    expect(policy.audit_writes).toBeUndefined();
  });

  it("is not roster-installable, which is why the read stays open", () => {
    expect(manifest.contexts).not.toContain("shared_space.roster");
  });

  it("keeps the per-link and per-table caps in step", () => {
    expect(policy.max_rows).toBe(submit.max_submissions);
  });
});

// endpoint_only children cannot be deleted by ANY app SQL, so without these
// declarations a deleted train would leave invisible, undeletable, billed rows
// behind — and the orphaned sign-ups of a removed night would never be
// reclaimable at all.
describe("delete_cascades", () => {
  it("reclaims the guest rows a deleted train or night leaves behind", () => {
    expect(manifest.delete_cascades.trains).toEqual([
      { table: "guest_claims", foreign_key: "train_id" },
      { table: "dates", foreign_key: "train_id" },
    ]);
    expect(manifest.delete_cascades.dates).toEqual([
      { table: "guest_claims", foreign_key: "date_id" },
    ]);
  });

  it("names guest_claims BEFORE dates, so the grandchildren go first", () => {
    const [first] = manifest.delete_cascades.trains;
    expect(first.table).toBe("guest_claims");
  });

  it("tells the organizer what a removal destroys before it happens", () => {
    // The cascade is silent by design; a real person's commitment vanishing
    // must not be.
    expect(appHtml).toContain("already claimed this night through the shared link");
  });

  it("sends each declared delete as ONE statement, never a batch", () => {
    // The /api/db batch form refuses a delete_cascades table rather than
    // silently skipping the reclaim.
    expect(appHtml).toContain("DELETE FROM app_meal_train__trains WHERE id = ?");
    expect(appHtml).toContain("DELETE FROM app_meal_train__dates WHERE id = ?");
  });
});

// Two columns on `dates` mirror data that lives elsewhere, because the surfaces
// that read them (a share-form dropdown, a single-table agenda/glance SELECT)
// cannot format a date or join to the parent. Denormalization is only safe
// while every writer maintains it.
describe("the denormalized columns stay in step", () => {
  it("builds a date row in exactly one place", () => {
    expect(appHtml).toContain("function newDateRow(train, mealDate, note, capacity = 1)");
    expect(appHtml).toContain("label: dateLabel(mealDate)");
    expect(appHtml).toContain("train_title: train.title");
    // Only that one helper feeds the only INSERT.
    const inserts = appHtml.match(/INSERT INTO app_meal_train__dates/g) ?? [];
    expect(inserts).toHaveLength(1);
  });

  it("re-stamps train_title on every night when the train is renamed", () => {
    // Otherwise Today and the home-strip tile would keep naming a train under a
    // title it no longer has.
    expect(appHtml).toContain("UPDATE app_meal_train__dates SET train_title = ? WHERE train_id = ?");
    const updateFn = appHtml.slice(appHtml.indexOf("async function updateTrain("));
    expect(updateFn.slice(0, updateFn.indexOf("\n}\n"))).toContain("SET train_title = ?");
  });

  it("commits parent and denormalized child writes atomically", () => {
    expect(appHtml).toContain("async function dbBatch(statements)");
    expect(appHtml).toContain("body: JSON.stringify(body)");
    const createFn = appHtml.slice(appHtml.indexOf("async function createTrain("));
    expect(createFn.slice(0, createFn.indexOf("\n}\n"))).toContain("await dbBatch(statements)");
    const updateFn = appHtml.slice(appHtml.indexOf("async function updateTrain("));
    expect(updateFn.slice(0, updateFn.indexOf("\n}\n"))).toContain("await dbBatch([");
  });

  it("reads those columns from the surfaces that cannot join", () => {
    expect(manifest.agenda.source.query).toContain("train_title AS title");
    expect(manifest.glance.source.query).toContain("train_title AS title");
    expect(manifest.agenda.source.query).toContain("meal_date = :today");
    expect(isPlaintext("meal_date"), "a day token can only compare a plaintext column").toBe(true);
  });
});

describe("the app's own controls over the share surface", () => {
  it("never writes the guest table", () => {
    expect(appHtml).not.toMatch(/(INSERT INTO|UPDATE|DELETE FROM) app_meal_train__guest_claims/);
    expect(appHtml).toContain("SELECT * FROM app_meal_train__guest_claims");
  });

  it("writes capacity on dates, the one control it does own", () => {
    expect(appHtml).toContain("UPDATE app_meal_train__dates SET capacity = ? WHERE id = ?");
  });

  it("gates every share control on the hub having injected the URLs", () => {
    expect(appHtml).toContain("createShareHelper(window.__SHARE_CREATE_URL");
    expect(appHtml).toContain("share.enabled && canManage()");
  });

  it("mints links against the declared item type", () => {
    expect(appHtml).toContain('share.create("train"');
    expect(Object.keys(manifest.shareable)).toEqual(["train"]);
  });

  it("hides Share on a closed train, where the link would be dead on arrival", () => {
    expect(appHtml).toContain("share.enabled && canManage() && !closed");
  });
});

describe("automation_actions.open_train", () => {
  const step = manifest.automation_actions.open_train.steps[0];

  it("writes only columns the trains table has", () => {
    const columns = columnsOf("trains");
    for (const column of Object.keys(step.values)) {
      expect(columns, `trains has no ${column}`).toContain(column);
    }
  });

  it("supplies every NOT NULL column that has no default", () => {
    const body = schema.match(/CREATE TABLE IF NOT EXISTS app_meal_train__trains \(([\s\S]*?)\n\);/)[1];
    const required = body.split("\n")
      .map((l) => l.trim())
      .filter((l) => /NOT NULL/.test(l) && !/DEFAULT/.test(l))
      .map((l) => l.match(/^([a-z_]+)\b/)[1]);
    for (const column of required) {
      expect(Object.keys(step.values), `open_train omits NOT NULL column ${column}`).toContain(column);
    }
  });

  it("dedupes on a plaintext column, so a retry cannot open a second train", () => {
    const dedupe = manifest.automation_actions.open_train.dedupe;
    expect(dedupe).toEqual({ table: "trains", column: "source_event_id" });
    expect(columnsOf("trains")).toContain("source_event_id");
    expect(isPlaintext("source_event_id")).toBe(true);
    expect(step.values.source_event_id).toBe("$event_id");
  });

  it("opens no nights, and says so", () => {
    // Which nights need a meal is a human decision — a range an automation
    // guessed would be wrong in both directions. An automation-opened train is
    // therefore shareable but empty, which is exactly what the share dialog's
    // no-nights warning is for.
    expect(step.table).toBe("trains");
    expect(manifest.automation_actions.open_train.steps).toHaveLength(1);
    expect(manifest.automation_actions.open_train.description).toMatch(/lays out the dates/);
  });
});
