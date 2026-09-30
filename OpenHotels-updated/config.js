// Deployment settings for the OpenHotels-Updated findability voting page.  Setup: findability_updated/DEPLOY.md in the study repo.
// This file is public by design: the Supabase publishable ("anon") key is a browser key, and everything it can do is limited to the
// seven functions in findability_study/supabase/schema.sql (next_query, cast_vote, change_vote, skip_query, my_votes, add_note, set_name).
window.STUDY_CONFIG = {
  SUPABASE_URL: "https://axkmvahistbayphijdji.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_RJ1vF5y_2qZzbDcLto4ifw_1wRzQCbQ",
  // Public HuggingFace Storage Bucket (or dataset repo) holding the hf_upload/ folder from findability_updated/build.py, without trailing slash.
  DATA_BASE_URL: "https://huggingface.co/buckets/alperctnkaya/OpenHotels-updated-findability/resolve",
  // Names this site's saved state in the browser (annotator code, passcode, queue position).  All sites on this domain share one
  // localStorage, so every site needs its own prefix.  Changing it later makes existing annotators start over as new ones.
  STORAGE_PREFIX: "fsu_",
};
