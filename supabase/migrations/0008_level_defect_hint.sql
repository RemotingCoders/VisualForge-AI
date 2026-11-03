-- Level defect hint: the inspector's optional free-text defect request from
-- /qc ("What defects should appear?", max 300 characters). The QC planner
-- maps it to the closest allowed defect types in priority order; it only
-- steers planning/editing — descriptions and the Spark classification still
-- come from what was measured. Shown in the gallery and in the QC reveal
-- ("Requested: …"). Older levels simply have it null.
alter table VisualForge_levels add column if not exists defect_hint text;
