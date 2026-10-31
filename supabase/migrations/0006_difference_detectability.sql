-- AI-inspector detectability (Challenge the AI inspector, POST /api/ai-inspect):
-- every Spark challenge counts one attempt per difference; detectability is the
-- accumulated hits / attempts ratio (0..1) and ai_found_modes lists the modes
-- ("no-reference", "with-reference") in which Spark has ever found it.
alter table VisualForge_differences add column if not exists detectability numeric;
alter table VisualForge_differences add column if not exists ai_challenges integer not null default 0;
alter table VisualForge_differences add column if not exists ai_hits integer not null default 0;
alter table VisualForge_differences add column if not exists ai_found_modes text;
