// Beta cloud configuration.
// Fill these from Supabase → Project Settings → API.
// The anon (publishable) key is designed to be public; Row Level Security protects the data.
// NEVER put the service_role / secret key in this file.
window.BETA_CONFIG = Object.freeze({
  supabaseUrl: "",
  supabaseAnonKey: "",
  betaTermsVersion: "2026-10-beta3",
  feedbackEmail: "dc@brinsonenterprise.com"
});
