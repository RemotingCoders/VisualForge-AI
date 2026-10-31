-- QC defect classification (ONE Muse Spark call per QC level, after measurement):
-- the PLANNED type stays in "type"; Spark's visual re-classification of the measured
-- before/after crops lands here. Exports label with the classified type, and rows
-- with classification_confidence < 0.6 are exported separately as needs_review.
alter table VisualForge_differences add column if not exists classified_type text;
alter table VisualForge_differences add column if not exists classified_severity smallint;
alter table VisualForge_differences add column if not exists classification_confidence numeric;
alter table VisualForge_differences add column if not exists classification_label text;
