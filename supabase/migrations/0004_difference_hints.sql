-- Capability 2 (hints + per-difference difficulty): 3 progressive hints written by one
-- Spark call per level, plus a 1 (easiest) to 5 (hardest) difficulty rating per
-- difference. Drives /api/hint targeting and difficulty-weighted scoring.
alter table VisualForge_differences add column if not exists hints jsonb;
alter table VisualForge_differences add column if not exists difficulty smallint;
