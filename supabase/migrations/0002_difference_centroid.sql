-- VisualForge AI — Phase 7: store the measured diff centroid so found-marker circles
-- center on the change itself even for levels loaded from the database.
alter table VisualForge_differences add column if not exists centroid jsonb;
