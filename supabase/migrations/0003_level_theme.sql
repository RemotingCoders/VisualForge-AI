-- Capability 4 (VF_THEME_GENERATION): theme-generated levels remember the theme the
-- user typed and the prompt Muse Image actually used (data[].revised_prompt), so Play
-- can caption the scene and ai-call analysis can trace level provenance.
alter table VisualForge_levels add column if not exists theme text;
alter table VisualForge_levels add column if not exists revised_prompt text;
