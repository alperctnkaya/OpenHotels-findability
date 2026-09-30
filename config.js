// Deployment settings for the OpenHotels-Updated findability voting page.  Setup: findability_updated/DEPLOY.md in the study repo.
// This file is public by design: the Supabase publishable ("anon") key is a browser key, and everything it can do is limited to the
// seven functions in findability_study/supabase/schema.sql (next_query, cast_vote, change_vote, skip_query, my_votes, add_note, set_name).
window.STUDY_CONFIG = {
  SUPABASE_URL: "https://YOUR-PROJECT-REF.supabase.co",
  SUPABASE_ANON_KEY: "YOUR-PUBLISHABLE-KEY",
  // Public HuggingFace Storage Bucket (or dataset repo) holding the hf_upload/ folder from findability_updated/build.py, without trailing slash.
  DATA_BASE_URL: "https://huggingface.co/buckets/alperctnkaya/OpenHotels-updated-findability/resolve",
};
