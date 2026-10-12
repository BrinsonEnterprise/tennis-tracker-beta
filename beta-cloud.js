// Beta cloud layer for Tennis Stat Tracker.
// The app stays local-first; this module snapshots the local database to Supabase
// for signed-in testers, restores it on a new/cleared device, and collects
// feedback + client errors. It talks to the app only through window.__tennisBeta.
(() => {
  "use strict";

  const cfg = window.BETA_CONFIG || {};
  const bridge = window.__tennisBeta;
  if (!bridge) {
    console.error("[beta-cloud] App bridge missing; cloud backup disabled.");
    return;
  }

  const KEYS = Object.freeze({
    meta: "tst-beta-cloud-meta",
    auth: "tst-beta-auth"
  });
  const TIMING = Object.freeze({
    debounceMs: 30000,
    minIntervalMs: 180000,
    hiddenMinGapMs: 30000,
    retryBaseMs: 15000,
    retryMaxMs: 300000
  });
  const MAX_ERROR_REPORTS = 10;
  const ROLE_LABELS = Object.freeze({ parent: "Parent / guardian", coach: "Coach", athlete: "Adult player" });

  const configured = Boolean(
    cfg.supabaseUrl && cfg.supabaseAnonKey && window.supabase && typeof window.supabase.createClient === "function"
  );

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------
  const storage = {
    get(key) { try { return window.localStorage.getItem(key); } catch (_) { return null; } },
    set(key, value) { try { window.localStorage.setItem(key, value); } catch (_) { /* quota or privacy mode */ } },
    remove(key) { try { window.localStorage.removeItem(key); } catch (_) { /* ignore */ } }
  };

  function readJson(key, fallback) {
    const raw = storage.get(key);
    if (!raw) return fallback;
    try { return { ...fallback, ...JSON.parse(raw) }; } catch (_) { return fallback; }
  }

  function uuid() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") return window.crypto.randomUUID();
    const bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  async function digest(text) {
    if (window.crypto && window.crypto.subtle) {
      const buffer = await window.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
      return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, "0")).join("");
    }
    let hash = 0;
    for (let i = 0; i < text.length; i += 1) hash = (Math.imul(31, hash) + text.charCodeAt(i)) | 0;
    return `fallback-${text.length}-${hash}`;
  }

  function deviceLabel() {
    const ua = navigator.userAgent || "";
    const platform = /iPad/.test(ua) ? "iPad"
      : /iPhone/.test(ua) ? "iPhone"
      : /Android/.test(ua) ? "Android"
      : /Macintosh/.test(ua) ? "Mac"
      : /Windows/.test(ua) ? "Windows"
      : "Device";
    const browser = /CriOS|Chrome/.test(ua) ? "Chrome" : /FxiOS|Firefox/.test(ua) ? "Firefox" : /Safari/.test(ua) ? "Safari" : "Browser";
    const installed = window.matchMedia && window.matchMedia("(display-mode: standalone)").matches;
    return `${platform} · ${browser}${installed ? " · app" : ""}`;
  }

  function relativeTime(iso) {
    if (!iso) return "never";
    const diff = Date.now() - new Date(iso).getTime();
    if (!Number.isFinite(diff)) return "unknown";
    const minutes = Math.round(diff / 60000);
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours} hr ago`;
    return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes)) return "";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1048576) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / 1048576).toFixed(1)} MB`;
  }

  function errorMessage(error) {
    if (!error) return "Unknown error";
    if (typeof error === "string") return error;
    return error.message || error.error_description || "Unknown error";
  }

  function isLocalStoreEmpty(summary) {
    return summary.matches === 0 && summary.players <= 2;
  }

  // Minimal DOM builder; all text goes through textContent (no innerHTML).
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([key, value]) => {
      if (value === false || value === null || value === undefined) return;
      if (key === "class") el.className = value;
      else if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2), value);
      else if (value === true) el.setAttribute(key, "");
      else el.setAttribute(key, String(value));
    });
    children.flat().forEach((child) => {
      if (child === null || child === undefined || child === false) return;
      el.append(child instanceof Node ? child : document.createTextNode(String(child)));
    });
    return el;
  }

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  const meta = readJson(KEYS.meta, { lastBackupAt: null, lastHash: null, lastError: null, lastAttemptAt: null });
  const saveMeta = () => storage.set(KEYS.meta, JSON.stringify(meta));

  const client = configured
    ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: KEYS.auth }
      })
    : null;

  const sync = { dirty: false, timer: null, inFlight: null, retryMs: 0, pending: null, status: "off" };
  const ui = { view: "home", message: null, busy: false, backups: null, restoreTarget: null, cloudHasData: false };
  let session = null;
  const errorQueue = [];
  let errorReportsSent = 0;

  // ---------------------------------------------------------------------------
  // Backup engine
  // ---------------------------------------------------------------------------
  function setStatus(status) {
    sync.status = status;
    updateFab();
  }

  function scheduleBackup(delayMs) {
    window.clearTimeout(sync.timer);
    if (!client || !session) return;
    const sinceLast = meta.lastAttemptAt ? Date.now() - new Date(meta.lastAttemptAt).getTime() : Infinity;
    const wait = Math.max(delayMs, TIMING.minIntervalMs - sinceLast, sync.retryMs, 0);
    sync.timer = window.setTimeout(() => { runBackup("auto"); }, wait);
  }

  async function runBackup(reason) {
    if (!client || !session) return { ok: false, skipped: "signed-out" };
    if (!navigator.onLine) {
      setStatus(sync.dirty ? "pending" : sync.status);
      return { ok: false, skipped: "offline" };
    }
    if (sync.inFlight) {
      sync.dirty = true;
      return sync.inFlight;
    }
    sync.inFlight = performBackup(reason).finally(() => {
      sync.inFlight = null;
      if (sync.dirty && sync.status !== "error") scheduleBackup(TIMING.debounceMs);
    });
    return sync.inFlight;
  }

  async function performBackup(reason) {
    const isAutomatic = reason === "auto" || reason === "app-hidden";
    const summary = bridge.summary();
    if (isAutomatic && isLocalStoreEmpty(summary)) {
      // Never let a fresh/empty device become the newest cloud copy automatically.
      sync.dirty = false;
      setStatus("synced");
      return { ok: true, skipped: "empty" };
    }

    const serialized = bridge.serialize();
    const hash = await digest(serialized);
    if (isAutomatic && hash === meta.lastHash) {
      sync.dirty = false;
      setStatus("synced");
      return { ok: true, skipped: "unchanged" };
    }

    // Reuse the id when retrying the same snapshot so a lost response cannot duplicate it.
    if (!sync.pending || sync.pending.hash !== hash) sync.pending = { hash, id: uuid() };
    sync.dirty = false;
    meta.lastAttemptAt = new Date().toISOString();
    saveMeta();
    setStatus("syncing");

    const { error } = await client.from("beta_backups").insert({
      client_backup_id: sync.pending.id,
      app_version: Number(bridge.appVersion) || 0,
      device_label: deviceLabel(),
      reason,
      payload: JSON.parse(serialized)
    });

    if (error && error.code !== "23505") {
      sync.dirty = true;
      sync.retryMs = Math.min(sync.retryMs ? sync.retryMs * 2 : TIMING.retryBaseMs, TIMING.retryMaxMs);
      meta.lastError = errorMessage(error);
      saveMeta();
      setStatus("error");
      scheduleBackup(sync.retryMs);
      return { ok: false, error };
    }

    sync.pending = null;
    sync.retryMs = 0;
    meta.lastBackupAt = new Date().toISOString();
    meta.lastHash = hash;
    meta.lastError = null;
    saveMeta();
    setStatus(sync.dirty ? "pending" : "synced");
    return { ok: true };
  }

  window.__tennisBetaOnPersist = () => {
    sync.dirty = true;
    if (!session) return;
    if (sync.status !== "syncing" && sync.status !== "error") setStatus("pending");
    scheduleBackup(TIMING.debounceMs);
  };

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "hidden" || !session || !sync.dirty) return;
    const sinceLast = meta.lastAttemptAt ? Date.now() - new Date(meta.lastAttemptAt).getTime() : Infinity;
    if (sinceLast >= TIMING.hiddenMinGapMs) runBackup("app-hidden");
  });
  window.addEventListener("online", () => { if (sync.dirty) scheduleBackup(2000); flushErrors(); });

  // ---------------------------------------------------------------------------
  // Error reporting
  // ---------------------------------------------------------------------------
  function queueError(message, stack, source) {
    if (errorReportsSent + errorQueue.length >= MAX_ERROR_REPORTS) return;
    const text = String(message || "Unknown error").slice(0, 2000);
    if (errorQueue.some((item) => item.message === text)) return;
    errorQueue.push({ message: text, stack: stack ? String(stack).slice(0, 8000) : null, source: source ? String(source).slice(0, 500) : null });
    flushErrors();
  }

  async function flushErrors() {
    if (!client || !session || !navigator.onLine || !errorQueue.length) return;
    const batch = errorQueue.splice(0, errorQueue.length).map((item) => ({
      ...item,
      app_version: Number(bridge.appVersion) || 0,
      device_label: deviceLabel()
    }));
    errorReportsSent += batch.length;
    const { error } = await client.from("beta_client_errors").insert(batch);
    if (error) console.warn("[beta-cloud] error report failed", errorMessage(error));
  }

  window.addEventListener("error", (event) => queueError(event.message, event.error && event.error.stack, event.filename));
  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    queueError(reason && reason.message ? reason.message : String(reason), reason && reason.stack, "unhandledrejection");
  });

  // ---------------------------------------------------------------------------
  // Auth
  // ---------------------------------------------------------------------------
  const MIN_PASSWORD_LENGTH = 8;

  function friendlyAuthError(error) {
    const msg = errorMessage(error);
    if (/invalid login credentials/i.test(msg)) return "That email and password don't match. Check them, or tap “Forgot password”.";
    if (/already registered|already been registered|user already exists/i.test(msg)) return "An account with this email already exists. Tap “I already have an account” to sign in.";
    if (/email not confirmed/i.test(msg)) return "This account still needs email confirmation. Ask the beta team to turn off “Confirm email” in Supabase.";
    if (/password should be at least/i.test(msg)) return `Use a password with at least ${MIN_PASSWORD_LENGTH} characters.`;
    if (/rate limit|too many/i.test(msg)) return "Too many attempts. Wait a few minutes and try again.";
    return msg;
  }

  async function saveProfile(role) {
    const { error } = await client.from("beta_profiles").upsert(
      { role, beta_terms_version: cfg.betaTermsVersion || "beta" },
      { onConflict: "user_id" }
    );
    if (error) console.warn("[beta-cloud] profile save failed", errorMessage(error));
  }

  async function createAccount(email, password, role) {
    const { data, error } = await client.auth.signUp({ email, password });
    if (error) throw new Error(friendlyAuthError(error));
    if (!data.session) {
      // Email confirmation is still on in Supabase; the user must confirm before signing in.
      return { needsConfirmation: true };
    }
    await saveProfile(role);
    return { needsConfirmation: false };
  }

  async function signIn(email, password) {
    const { error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw new Error(friendlyAuthError(error));
  }

  async function sendPasswordReset(email) {
    const redirectTo = new URL("reset.html", window.location.href).href;
    const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo });
    if (error) throw new Error(friendlyAuthError(error));
  }

  async function checkCloudHasData() {
    const { data, error } = await client
      .from("beta_backups")
      .select("id")
      .gt("match_count", 0)
      .limit(1);
    ui.cloudHasData = !error && Array.isArray(data) && data.length > 0;
  }

  function onSignedIn() {
    setStatus(sync.dirty ? "pending" : "synced");
    flushErrors();
    const summary = bridge.summary();
    checkCloudHasData().then(() => {
      if (isLocalStoreEmpty(summary) && ui.cloudHasData) {
        ui.message = { kind: "info", text: "This device is empty but your cloud backup has data. Use “Restore from cloud” to bring it here." };
        if (panel.open) renderPanel();
        else openPanel();
      } else if (sync.dirty || !meta.lastBackupAt) {
        scheduleBackup(5000);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Restore + feedback
  // ---------------------------------------------------------------------------
  async function loadBackups() {
    const { data, error } = await client
      .from("beta_backups")
      .select("id, created_at, device_label, reason, player_count, match_count, size_bytes")
      .order("created_at", { ascending: false })
      .limit(12);
    if (error) throw error;
    return data || [];
  }

  async function restoreBackup(backup) {
    const summary = bridge.summary();
    if (summary.liveMatch) throw new Error("Finish or pause the live match before restoring.");
    if (!isLocalStoreEmpty(summary)) {
      const safety = await runBackup("before-restore");
      if (!safety.ok && safety.skipped !== "unchanged") {
        throw new Error("Couldn't back up this device's current data first, so nothing was replaced. Check your connection and try again.");
      }
    }
    const { data, error } = await client.from("beta_backups").select("payload").eq("id", backup.id).single();
    if (error) throw error;
    bridge.replaceStore(data.payload);
    meta.lastHash = await digest(bridge.serialize());
    saveMeta();
    sync.dirty = false;
    setStatus("synced");
  }

  async function sendFeedback(message) {
    const { error } = await client.from("beta_feedback").insert({
      message,
      app_version: Number(bridge.appVersion) || 0,
      device_label: deviceLabel()
    });
    if (error) throw error;
  }

  // ---------------------------------------------------------------------------
  // UI
  // ---------------------------------------------------------------------------
  const STATUS_TEXT = Object.freeze({
    off: "Cloud backup off",
    pending: "Changes waiting to back up",
    syncing: "Backing up…",
    synced: "Backed up",
    error: "Backup failed — will retry"
  });

  const fab = h("button", { type: "button", id: "betaCloudFab", class: "beta-fab", "aria-haspopup": "dialog" },
    h("span", { class: "beta-fab-icon", "aria-hidden": "true" }, "☁"),
    h("span", { class: "beta-fab-dot", "aria-hidden": "true" })
  );
  const panel = h("dialog", { id: "betaCloudPanel", class: "beta-panel", "aria-labelledby": "betaPanelTitle" });
  const toastRegion = h("div", { class: "beta-toast", role: "status", "aria-live": "polite" });

  function updateFab() {
    const status = configured ? (session ? sync.status : "off") : "off";
    fab.dataset.status = status;
    fab.setAttribute("aria-label", `Beta: ${STATUS_TEXT[status] || STATUS_TEXT.off}. Open backup and feedback.`);
    fab.title = STATUS_TEXT[status] || "";
  }

  function updateFabVisibility() {
    const nav = document.getElementById("bottomNav");
    const fullScreen = nav ? nav.classList.contains("hidden") : false;
    fab.hidden = fullScreen && !panel.open;
  }

  function toast(text) {
    toastRegion.textContent = text;
    toastRegion.classList.add("show");
    window.clearTimeout(toast.timer);
    toast.timer = window.setTimeout(() => toastRegion.classList.remove("show"), 3200);
  }

  function setMessage(kind, text) {
    ui.message = text ? { kind, text } : null;
  }

  async function withBusy(action) {
    if (ui.busy) return;
    ui.busy = true;
    renderPanel();
    try {
      await action();
    } catch (error) {
      setMessage("error", errorMessage(error));
    } finally {
      ui.busy = false;
      renderPanel();
    }
  }

  function openPanel() {
    ui.view = "home";
    renderPanel();
    if (typeof panel.showModal === "function") panel.showModal();
    else panel.setAttribute("open", "");
    updateFabVisibility();
  }

  function closePanel() {
    if (typeof panel.close === "function") panel.close();
    else panel.removeAttribute("open");
    ui.message = null;
    ui.restoreTarget = null;
    ui.authPassword = "";
    updateFabVisibility();
    fab.focus();
  }

  function button(label, onClick, variant = "primary", extra = {}) {
    return h("button", { type: "button", class: `beta-btn beta-btn-${variant}`, disabled: ui.busy, onclick: onClick, ...extra }, label);
  }

  function messageBlock() {
    if (!ui.message) return null;
    return h("p", { class: `beta-msg beta-msg-${ui.message.kind}`, role: ui.message.kind === "error" ? "alert" : "status" }, ui.message.text);
  }

  function viewNotConfigured() {
    const mail = cfg.feedbackEmail
      ? h("a", { class: "beta-btn beta-btn-secondary", href: `mailto:${cfg.feedbackEmail}?subject=${encodeURIComponent("Tennis Tracker beta feedback")}` }, "Email feedback")
      : null;
    return [
      h("p", {}, "Cloud backup isn't configured in this build. Your data is saved on this device only."),
      mail
    ];
  }

  function viewSignedOut() {
    const mode = ui.authMode || "create";
    const emailInput = h("input", { id: "betaEmail", class: "beta-input", type: "email", autocomplete: "email", required: true, value: ui.authEmail || "" });
    const rememberEmail = () => { ui.authEmail = emailInput.value.trim(); };
    const switchMode = (next) => () => { rememberEmail(); ui.authPassword = ""; ui.authMode = next; setMessage(null); renderPanel(); };

    if (mode === "reset") {
      const form = h("form", {
        class: "beta-form", novalidate: true,
        onsubmit: (event) => {
          event.preventDefault();
          const email = emailInput.value.trim().toLowerCase();
          if (!emailInput.checkValidity()) { setMessage("error", "Enter a valid email address."); renderPanel(); return; }
          rememberEmail();
          withBusy(async () => {
            await sendPasswordReset(email);
            setMessage("success", `If an account exists for ${email}, a reset link is on its way. Open it, choose a new password, then sign in here.`);
          });
        }
      },
        h("p", {}, "We'll email you a link to choose a new password."),
        h("label", { for: "betaEmail" }, "Email"),
        emailInput,
        h("button", { type: "submit", class: "beta-btn beta-btn-primary", disabled: ui.busy }, ui.busy ? "Sending…" : "Email me a reset link"),
        button("Back to sign in", switchMode("signin"), "link")
      );
      return [form];
    }

    const isCreate = mode === "create";
    const passwordInput = h("input", {
      id: "betaPassword", class: "beta-input", type: "password", required: true, value: ui.authPassword || "",
      oninput: (event) => { ui.authPassword = event.target.value; },
      minlength: String(MIN_PASSWORD_LENGTH), autocomplete: isCreate ? "new-password" : "current-password",
      "aria-describedby": isCreate ? "betaPasswordHelp" : null
    });
    const showPassword = h("input", { id: "betaShowPassword", type: "checkbox", onchange: (event) => { passwordInput.type = event.target.checked ? "text" : "password"; } });

    if (!isCreate) {
      const form = h("form", {
        class: "beta-form", novalidate: true,
        onsubmit: (event) => {
          event.preventDefault();
          const email = emailInput.value.trim().toLowerCase();
          if (!emailInput.checkValidity()) { setMessage("error", "Enter a valid email address."); renderPanel(); return; }
          if (!passwordInput.value) { setMessage("error", "Enter your password."); renderPanel(); return; }
          rememberEmail();
          withBusy(async () => {
            await signIn(email, passwordInput.value);
            ui.authPassword = "";
            setMessage("success", "Signed in. Backups are on.");
            ui.view = "home";
          });
        }
      },
        h("p", {}, "Sign in to back up this device and restore your data on a new phone."),
        h("label", { for: "betaEmail" }, "Email"),
        emailInput,
        h("label", { for: "betaPassword" }, "Password"),
        passwordInput,
        h("div", { class: "beta-check" }, showPassword, h("label", { for: "betaShowPassword" }, "Show password")),
        h("button", { type: "submit", class: "beta-btn beta-btn-primary", disabled: ui.busy }, ui.busy ? "Signing in…" : "Sign in"),
        button("Forgot password?", switchMode("reset"), "link"),
        button("Create a new account", switchMode("create"), "link")
      );
      return [form];
    }

    const roleSelect = h("select", { id: "betaRole", class: "beta-input", required: true, onchange: (event) => { ui.authRole = event.target.value; } },
      Object.entries(ROLE_LABELS).map(([value, label]) => h("option", { value, selected: value === (ui.authRole || "parent") }, label))
    );
    const consent = h("input", { id: "betaConsent", type: "checkbox", required: true, checked: Boolean(ui.authConsent),
      onchange: (event) => { ui.authConsent = event.target.checked; } });
    const form = h("form", {
      class: "beta-form", novalidate: true,
      onsubmit: (event) => {
        event.preventDefault();
        const email = emailInput.value.trim().toLowerCase();
        rememberEmail();
        ui.authRole = roleSelect.value;
        if (!emailInput.checkValidity()) { setMessage("error", "Enter a valid email address."); renderPanel(); return; }
        if (passwordInput.value.length < MIN_PASSWORD_LENGTH) { setMessage("error", `Use a password with at least ${MIN_PASSWORD_LENGTH} characters.`); renderPanel(); return; }
        if (!consent.checked) { setMessage("error", "Please confirm the beta terms to continue."); renderPanel(); return; }
        withBusy(async () => {
          const result = await createAccount(email, passwordInput.value, roleSelect.value);
          ui.authPassword = "";
          if (result.needsConfirmation) {
            ui.authMode = "signin";
            setMessage("info", "Account created. Check your email to confirm it, then sign in.");
          } else {
            setMessage("success", "Account created. Backups are on.");
            ui.view = "home";
          }
        });
      }
    },
      h("p", {}, "Create a free account to back up this device to the cloud and restore it if your phone is lost or cleared. Everything still works offline."),
      h("label", { for: "betaEmail" }, "Email"),
      emailInput,
      h("label", { for: "betaPassword" }, "Choose a password"),
      passwordInput,
      h("p", { id: "betaPasswordHelp", class: "beta-help" }, `At least ${MIN_PASSWORD_LENGTH} characters.`),
      h("div", { class: "beta-check" }, showPassword, h("label", { for: "betaShowPassword" }, "Show password")),
      h("label", { for: "betaRole" }, "I'm a"),
      roleSelect,
      h("div", { class: "beta-check" },
        consent,
        h("label", { for: "betaConsent" },
          "I'm an adult (18+, or the age of majority where I live) and agree to the ",
          h("a", { href: "privacy.html", target: "_blank", rel: "noopener" }, "beta terms & privacy notice"),
          ". The app is provided as-is and used at my own risk. If I track a minor who isn't my child, I have their parent or guardian's permission.")
      ),
      h("button", { type: "submit", class: "beta-btn beta-btn-primary", disabled: ui.busy }, ui.busy ? "Creating account…" : "Create account"),
      button("I already have an account", switchMode("signin"), "link")
    );
    return [form];
  }

  function viewSignedInHome() {
    const summary = bridge.summary();
    const email = session && session.user ? session.user.email : "";
    const lastLine = meta.lastBackupAt ? `Last backup ${relativeTime(meta.lastBackupAt)}` : "No backup yet from this device";
    return [
      h("dl", { class: "beta-facts" },
        h("dt", {}, "Signed in"), h("dd", {}, email),
        h("dt", {}, "Status"), h("dd", {}, `${STATUS_TEXT[sync.status] || ""}. ${lastLine}.`),
        h("dt", {}, "On this device"), h("dd", {}, `${summary.matches} matches · ${summary.players} players`)
      ),
      meta.lastError && sync.status === "error" ? h("p", { class: "beta-msg beta-msg-error" }, `Last error: ${meta.lastError}`) : null,
      h("div", { class: "beta-actions" },
        button(ui.busy ? "Working…" : "Back up now", () => withBusy(async () => {
          const result = await runBackup("manual");
          if (!result.ok) throw result.error || new Error(result.skipped === "offline" ? "You're offline. It will back up when you reconnect." : "Backup didn't run.");
          setMessage("success", "Backed up.");
        })),
        button("Restore from cloud…", () => withBusy(async () => {
          ui.backups = await loadBackups();
          ui.view = "restore";
          setMessage(null);
        }), "secondary"),
        button("Send feedback", () => { ui.view = "feedback"; setMessage(null); renderPanel(); }, "secondary"),
        button("Sign out", () => withBusy(async () => {
          if (sync.dirty) await runBackup("manual");
          const { error } = await client.auth.signOut();
          if (error) throw error;
          ui.authMode = "signin";
          setMessage("info", "Signed out. Your data stays on this device.");
        }), "link"),
        button("Delete my cloud account & data…", () => { ui.view = "delete"; setMessage(null); renderPanel(); }, "link")
      )
    ];
  }

  function viewDeleteAccount() {
    return [
      h("p", {}, "This permanently deletes your cloud backups, feedback, error reports and sign-in from our servers. It can't be undone."),
      h("p", { class: "beta-help" }, "Data saved on this phone is not affected. You can keep using the app offline."),
      h("div", { class: "beta-actions" },
        button(ui.busy ? "Deleting…" : "Delete permanently", () => withBusy(async () => {
          window.clearTimeout(sync.timer);
          const { error } = await client.rpc("beta_delete_my_account");
          if (error) throw error;
          await client.auth.signOut({ scope: "local" });
          meta.lastBackupAt = null;
          meta.lastHash = null;
          meta.lastError = null;
          saveMeta();
          ui.view = "home";
          ui.authMode = "create";
          setMessage("success", "Your cloud account and data were deleted.");
        }), "danger"),
        button("Cancel", () => { ui.view = "home"; renderPanel(); }, "secondary")
      )
    ];
  }

  function viewRestore() {
    const backups = ui.backups || [];
    if (ui.restoreTarget) {
      const target = ui.restoreTarget;
      const summary = bridge.summary();
      return [
        h("p", {}, `Replace the data on this device with the backup from ${relativeTime(target.created_at)} (${target.match_count} matches, ${target.player_count} players)?`),
        isLocalStoreEmpty(summary) ? null : h("p", { class: "beta-help" }, `This device currently has ${summary.matches} matches. They'll be backed up to the cloud first, so you can switch back.`),
        h("div", { class: "beta-actions" },
          button(ui.busy ? "Restoring…" : "Replace data on this device", () => withBusy(async () => {
            await restoreBackup(target);
            ui.restoreTarget = null;
            ui.view = "home";
            setMessage("success", "Restored. The app now shows the cloud data.");
            toast("Restore complete");
          }), "danger"),
          button("Cancel", () => { ui.restoreTarget = null; renderPanel(); }, "secondary")
        )
      ];
    }
    if (!backups.length) {
      return [h("p", {}, "No cloud backups yet."), button("Back", () => { ui.view = "home"; renderPanel(); }, "secondary")];
    }
    return [
      h("p", { class: "beta-help" }, "Choose a backup. Newest first."),
      h("ul", { class: "beta-list" },
        backups.map((item) => h("li", {},
          h("button", {
            type: "button", class: "beta-row", disabled: ui.busy,
            onclick: () => { ui.restoreTarget = item; renderPanel(); }
          },
            h("span", { class: "beta-row-main" }, `${relativeTime(item.created_at)} · ${item.match_count} matches`),
            h("span", { class: "beta-row-sub" }, `${item.device_label || "Unknown device"} · ${item.player_count} players · ${formatBytes(item.size_bytes)}`)
          )
        ))
      ),
      button("Back", () => { ui.view = "home"; renderPanel(); }, "secondary")
    ];
  }

  function viewFeedback() {
    const textarea = h("textarea", { id: "betaFeedback", class: "beta-input", rows: "5", maxlength: "4000", required: true });
    return [
      h("form", {
        class: "beta-form", novalidate: true,
        onsubmit: (event) => {
          event.preventDefault();
          const message = textarea.value.trim();
          if (!message) { setMessage("error", "Write a short note first."); renderPanel(); return; }
          withBusy(async () => {
            await sendFeedback(message);
            ui.view = "home";
            setMessage("success", "Thanks — feedback sent.");
          });
        }
      },
        h("label", { for: "betaFeedback" }, "What worked, what broke, what's missing?"),
        textarea,
        h("button", { type: "submit", class: "beta-btn beta-btn-primary", disabled: ui.busy }, ui.busy ? "Sending…" : "Send feedback"),
        button("Back", () => { ui.view = "home"; setMessage(null); renderPanel(); }, "link")
      )
    ];
  }

  function renderPanel() {
    const focusedId = document.activeElement && panel.contains(document.activeElement) ? document.activeElement.id : null;
    let body;
    if (!configured) body = viewNotConfigured();
    else if (!session) body = viewSignedOut();
    else if (ui.view === "restore") body = viewRestore();
    else if (ui.view === "feedback") body = viewFeedback();
    else if (ui.view === "delete") body = viewDeleteAccount();
    else body = viewSignedInHome();

    const nodes = [
      h("div", { class: "beta-panel-head" },
        h("h2", { id: "betaPanelTitle" }, "Beta · Backup & feedback"),
        h("button", { type: "button", class: "beta-close", "aria-label": "Close", onclick: closePanel }, "×")
      ),
      messageBlock(),
      ...body
    ].filter((node) => node instanceof Node);
    panel.replaceChildren(...nodes);
    if (focusedId) {
      const again = document.getElementById(focusedId);
      if (again) again.focus();
    }
  }

  panel.addEventListener("cancel", (event) => { event.preventDefault(); closePanel(); });
  panel.addEventListener("click", (event) => { if (event.target === panel) closePanel(); });
  fab.addEventListener("click", openPanel);

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------
  function mount() {
    document.body.append(fab, panel, toastRegion);
    updateFab();
    updateFabVisibility();
    const nav = document.getElementById("bottomNav");
    if (nav) new MutationObserver(updateFabVisibility).observe(nav, { attributes: true, attributeFilter: ["class"] });

    if (navigator.storage && typeof navigator.storage.persist === "function") {
      navigator.storage.persist().catch(() => {});
    }

    if (!client) return;
    // Fires INITIAL_SESSION on load, then on every sign-in/out/refresh.
    // Supabase calls are deferred out of the callback to avoid the auth lock deadlock.
    client.auth.onAuthStateChange((event, nextSession) => {
      const wasSignedIn = Boolean(session);
      session = nextSession;
      window.setTimeout(() => {
        if (!session) {
          window.clearTimeout(sync.timer);
          setStatus("off");
        } else if (!wasSignedIn) {
          onSignedIn();
        }
        if (panel.open) renderPanel();
      }, 0);
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
  else mount();
})();
