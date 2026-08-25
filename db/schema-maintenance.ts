export const ADD_PACKS_OPENED_COLUMN_SQL = `ALTER TABLE players
  ADD COLUMN packs_opened INTEGER NOT NULL DEFAULT 1
  CHECK (packs_opened >= 1)`;

// Legacy scores can land exactly on a six-pack boundary, where score alone
// cannot distinguish an empty pack from one that was just opened. score_version
// includes each successful pack open, so the bounded expression preserves that
// state while also safely backfilling databases created before packs existed.
export const BACKFILL_PACKS_OPENED_SQL = `UPDATE players
  SET packs_opened = min(
    (sandwiches_fed / 6) + 1,
    max(
      CASE
        WHEN sandwiches_fed = 0 THEN 1
        ELSE ((sandwiches_fed - 1) / 6) + 1
      END,
      1 + max(0, score_version - sandwiches_fed)
    )
  )`;
