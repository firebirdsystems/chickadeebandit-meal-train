# Meal Train

Meals for a family going through something — a new baby, a surgery, a loss.

The people who sign up for a meal train are mostly **not** in the household: they
are neighbours, church, coworkers, the school run. They will never install an
app. So this app is built around one writable share link:

- **A train** — the care period, with who it's for, dietary needs, and how to
  deliver ("cooler on the porch, don't ring the bell").
- **Nights** — one row per meal. Lay out a whole range at once, or add them one
  at a time.
- **A member takes a night** — closes it to everyone, household and link alike.
- **A neighbour takes a night** — through the shared link, no account, bounded
  by that night's *link spots* and claimed atomically by the hub, so two people
  can never take the same last night.

Adults manage trains and nights; everyone in the household can read. Sign-ups
collected through the link are `endpoint_only` — the app can show them but can
never edit or delete somebody's commitment.

## How the two ledgers stay honest

A night holds one meal. A member claim sets `status = 'covered'`, which is also
the filter the public form's date list runs on — so the member door and the link
door shut together, and no second capacity column is needed (unlike `volunteer`
and `potluck`, where members and guests claim the same row from two ledgers).
Two meals on one day are two rows.

## Quick start

```bash
npm run dev     # http://localhost:3001
npm run build   # produces dist/bundle.json
npm test        # manifest + share-contract + logic checks
```
