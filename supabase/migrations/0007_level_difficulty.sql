-- Level difficulty: the job difficulty the level was generated with (easy /
-- medium / hard). In QC mode this is the inspector level — it drove the planner
-- rule and the measured-defect area floor (easy 0.25% / medium 0.12% of the
-- image, hard none) — and it is shown in the gallery and in the QC reveal
-- ("Inspector level: Easy"). Older levels simply have it null.
alter table VisualForge_levels add column if not exists difficulty text;
