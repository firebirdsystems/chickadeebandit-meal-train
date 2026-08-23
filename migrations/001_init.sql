-- Meal Train — a care period someone is being fed through (a new baby, a
-- surgery recovery, a bereavement) plus the individual dates that need a meal.
--
-- The defining fact about this app is that most of the people who sign up are
-- NOT household members: they are neighbours, church, coworkers, the school
-- run. They will never install anything. So the dates table is written by
-- adults, and the sign-ups arrive through a writable share link into
-- `guest_claims`, which no app SQL may ever write (see the row policies).

-- The care period. `status` is the public gate: a train that is not `open`
-- disappears from every share link on it (manifest shareable.train.visible_where).
CREATE TABLE IF NOT EXISTS app_meal_train__trains (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL,                 -- "Meals for the Alvarez family"
  recipient       TEXT NOT NULL DEFAULT '',      -- who is being fed
  description     TEXT NOT NULL DEFAULT '',      -- why, and anything else helpers should know
  delivery_notes  TEXT NOT NULL DEFAULT '',      -- "cooler on the porch, ring the bell"
  dietary_notes   TEXT NOT NULL DEFAULT '',      -- "no dairy, no nuts"
  start_date      TEXT NOT NULL DEFAULT '',      -- plaintext by the _date suffix
  end_date        TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'open',  -- 'open' | 'closed' (built-in plaintext)
  created_by      TEXT NOT NULL,
  created_by_name TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL,
  -- Which app event opened this train, for the automation dispatcher's dedupe
  -- guard (manifest automation_actions.open_train). NULL for trains an adult
  -- created in the app.
  source_event_id TEXT
);

-- One row = ONE meal on one calendar date. Two meals the same day are two rows,
-- which is deliberately how the app expresses that: it keeps every row's
-- lifecycle independent, so a member covering one of them cannot close the
-- other to the public form.
--
-- `label` is the human date ("Tue, Mar 3") shown in the share form's dropdown.
-- The hub cannot format a date for that select — it projects a stored column —
-- so the app writes one, from a single helper, whenever it writes meal_date.
-- `train_title` is the same bargain for the Today agenda and the glance tile,
-- both of which are single-table SELECTs that cannot join back to `trains`.
CREATE TABLE IF NOT EXISTS app_meal_train__dates (
  id           TEXT PRIMARY KEY,
  train_id     TEXT NOT NULL,
  meal_date    TEXT NOT NULL,                 -- yyyy-mm-dd, plaintext by suffix
  label        TEXT NOT NULL DEFAULT '',      -- denormalized display date
  train_title  TEXT NOT NULL DEFAULT '',      -- denormalized parent title
  note         TEXT NOT NULL DEFAULT '',      -- "dinner for 5, they eat at 6"
  -- How many sign-ups this meal accepts THROUGH THE SHARE LINK. The hub counts
  -- occupancy over `guest_claims` alone and fails closed at zero, so setting it
  -- to 0 closes the date to the public form while members can still cover it.
  capacity     INTEGER NOT NULL DEFAULT 1 CHECK (capacity >= 0),
  -- 'open' | 'covered' | 'closed'. Only 'open' dates are offered by the public
  -- form (manifest values_from.where), so a member covering a date and an
  -- organizer closing one shut the same door.
  status       TEXT NOT NULL DEFAULT 'open',
  -- The member who took this date, if a member did. Nullable, because
  -- member_references clears it to NULL when that person leaves the household —
  -- the app then shows the date as unassigned so an adult can reopen it.
  covered_by   TEXT,
  covered_dish TEXT NOT NULL DEFAULT '',      -- what that member is bringing
  covered_at   TEXT,
  created_at   TEXT NOT NULL,
  FOREIGN KEY (train_id) REFERENCES app_meal_train__trains(id) ON DELETE CASCADE
);

-- Sign-ups that arrived through a share link. Written ONLY by the hub's
-- external submit path; the `endpoint_only` row policy rejects every
-- app-originated INSERT/UPDATE/DELETE against it, so nothing in the app can
-- edit or erase a commitment an anonymous neighbour made.
--
-- No foreign keys, matching potluck's guest_signups and volunteer's
-- guest_claims: these rows are authored outside the app, and the parent linkage
-- is already guaranteed there — `train_id` IS the share link's item id, and
-- `date_id` is admitted only by an EXISTS against `dates` folded into the
-- INSERT's own WHERE, which is also what enforces `capacity` atomically.
--
-- Every column the submit path writes must be plaintext (the write path never
-- runs the app-DB codec) — see manifest.db_plaintext_columns. `created_at` has
-- a DB default because an external INSERT sets only id + fk + declared fields.
CREATE TABLE IF NOT EXISTS app_meal_train__guest_claims (
  id         TEXT NOT NULL PRIMARY KEY,
  train_id   TEXT NOT NULL,
  date_id    TEXT NOT NULL DEFAULT '',
  guest_name TEXT NOT NULL DEFAULT '',
  bringing   TEXT NOT NULL DEFAULT '',
  guest_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS app_meal_train__trains_status_idx
  ON app_meal_train__trains (status, start_date);
CREATE INDEX IF NOT EXISTS app_meal_train__trains_source_event_idx
  ON app_meal_train__trains (source_event_id);
CREATE INDEX IF NOT EXISTS app_meal_train__dates_train_idx
  ON app_meal_train__dates (train_id, meal_date);
CREATE INDEX IF NOT EXISTS app_meal_train__dates_date_idx
  ON app_meal_train__dates (meal_date, status);
CREATE INDEX IF NOT EXISTS app_meal_train__guest_claims_train_idx
  ON app_meal_train__guest_claims (train_id);
CREATE INDEX IF NOT EXISTS app_meal_train__guest_claims_date_idx
  ON app_meal_train__guest_claims (date_id);
