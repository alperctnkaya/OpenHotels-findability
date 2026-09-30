// Deployment settings for the findability voting page.  Fill in after DEPLOY.md steps 2 and 3.
// This file is public by design: the Supabase "anon" key is a browser key, and everything it can do is limited
// to the six functions in ../supabase/schema.sql (next_query, cast_vote, change_vote, skip_query, my_votes, add_note).
window.STUDY_CONFIG = {
  SUPABASE_URL: "https://ckaqzpwnmwzcllyxrjyt.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_1XIb2zm7pK3OqQdi2rgzcg_WvXoBb1L",
  // Public HuggingFace Storage Bucket (or dataset repo) holding the hf_upload/ folder from build_study.py, without trailing slash.
  DATA_BASE_URL: "https://huggingface.co/buckets/alperctnkaya/OpenHotels-findability/resolve",
  // Names this site's saved state in the browser (annotator code, passcode, queue position).  All sites on this domain share one
  // localStorage, so every site needs its own prefix.  Changing it later makes existing annotators start over as new ones.
  STORAGE_PREFIX: "fs_",
};
