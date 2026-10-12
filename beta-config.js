// Beta cloud configuration.
// Fill these from Supabase → Project Settings → API.
// The anon (publishable) key is designed to be public; Row Level Security protects the data.
// NEVER put the service_role / secret key in this file.
window.BETA_CONFIG = Object.freeze({
  supabaseUrl: "https://fndtslmrltzwxzcyjhzp.supabase.co",
  supabaseAnonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZuZHRzbG1ybHR6d3h6Y3lqaHpwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE4MzAwMjMsImV4cCI6MjEwNzQwNjAyM30.eAvXdaRBspuiymqHFxIfMnrP2efcPr3XQGVec1L9odc",
  betaTermsVersion: "2026-10-beta3",
  feedbackEmail: "dc@brinsonenterprise.com"
});
