// "One Another" Board — front end.
// Talks to Supabase when config.js has its settings; otherwise runs a demo with sample posts.
(() => {
  "use strict";
  const CFG = window.ONE_ANOTHER_CONFIG || {};

  const TRADES = ["Carpentry","Electrical","Plumbing","HVAC","Painting","Roofing","Drywall","Flooring","Concrete & masonry","Landscaping & lawn","Auto repair","Appliance repair","Handyman","Cleaning","Moving & hauling","Childcare","Tutoring","Tech & computers","Bookkeeping & taxes","Sewing & alterations","Other"];
  const CATEGORIES = ["Meals","Rides","Home repair","Yard work","Moving help","Childcare","Visits & company","Financial help","Supplies or items","Other"];
  const KIND = {
    prayer: { label: "Prayer request", closed: "Answered", close: "Mark answered", reopen: "Reopen", titleLabel: "What can we pray for?", bodyLabel: "Details", titlePh: "e.g. Healing for my mom after surgery", submit: "Share request" },
    need:   { label: "Need", closed: "Met", close: "Mark met", reopen: "Reopen", titleLabel: "What do you need?", bodyLabel: "Details", titlePh: "e.g. Rides to chemo on Tuesdays", submit: "Post need" },
    skill:  { label: "Trade for hire", closed: "Not taking work", close: "Pause listing", reopen: "Resume listing", titleLabel: "Your business or name", bodyLabel: "What you do", titlePh: "e.g. Ruiz Family Electric", submit: "List my trade" },
  };
  const DAY = 86400000;

  // ---------- Small helpers ----------
  const $ = (s) => document.querySelector(s);
  function h(tag, attrs = {}, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  function ago(iso) {
    const d = new Date(iso); if (isNaN(d)) return "";
    const s = (d - Date.now()) / 1000;
    if (Math.abs(s) < 60) return "just now";
    const steps = [[60, "second"], [3600, "minute"], [86400, "hour"], [604800, "day"], [2629800, "week"], [31557600, "month"]];
    for (let i = 1; i < steps.length; i++) if (Math.abs(s) < steps[i][0]) return rtf.format(Math.round(s / steps[i - 1][0]), steps[i][1]);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  }
  // Accepts "ruizelectric.com", "www.ruizelectric.com" or a full https:// address.
  // Returns a clean https:// (or http://) URL, or null if it isn't a real web address.
  function normalizeWebsite(input) {
    let s = String(input || "").trim();
    if (!s) return null;
    if (!/^https?:\/\//i.test(s)) s = "https://" + s;
    try {
      const u = new URL(s);
      if (!/^https?:$/.test(u.protocol) || !/\.[a-z]{2,}$/i.test(u.hostname) || /\s/.test(s)) return null;
      const out = u.href;
      return out.length <= 200 ? out : null;
    } catch (e) { return null; }
  }
  // A short, readable form for display: "ruizelectric.com/services"
  function prettyWebsite(url) {
    try { const u = new URL(url); return (u.hostname.replace(/^www\./, "") + u.pathname.replace(/\/$/, "")).slice(0, 60); }
    catch (e) { return url; }
  }

  let toastTimer;
  function toast(msg) {
    const t = $("#toast"); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 3000);
  }
  function showError(msg) { const n = $("#errorNotice"); n.textContent = msg || ""; n.hidden = !msg; }
  function friendly(e) {
    const m = (e && e.message) || String(e || "");
    if (/Failed to fetch|NetworkError|network/i.test(m)) return "Couldn’t reach the board. Check your connection and try again.";
    return m || "Something went wrong. Please try again.";
  }

  // ---------- Brand ----------
  (function applyBrand() {
    const b = CFG.brand || {}, root = document.documentElement.style;
    const hex = (v) => typeof v === "string" && /^#?[0-9a-f]{3,8}$/i.test(v.trim()) ? (v.trim().startsWith("#") ? v.trim() : "#" + v.trim()) : null;
    if (hex(b.primary)) root.setProperty("--brand-primary", hex(b.primary));
    if (hex(b.secondary)) root.setProperty("--brand-secondary", hex(b.secondary));
    if (hex(b.neutral)) root.setProperty("--brand-neutral", hex(b.neutral));
    if (hex(b.primaryOnDark)) root.setProperty("--brand-primary-dark", hex(b.primaryOnDark));
    if (CFG.boardName) { $("#boardName").textContent = CFG.boardName; document.title = CFG.boardName; }
    $("#churchName").textContent = CFG.churchName || "";
    $("#churchName").hidden = !CFG.churchName;
    $("#tagline").textContent = CFG.tagline || "";
  })();

  // ---------- Data layer: Supabase ----------
  function supabaseApi() {
    const sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey);
    async function rpc(fn, args) {
      const { data, error } = await sb.rpc(fn, args);
      if (error) throw new Error(error.message);
      return data;
    }
    return {
      demo: false,
      // Defer: calling Supabase from inside this callback can deadlock its auth lock.
      onAuth(cb) { sb.auth.onAuthStateChange((event) => { setTimeout(() => cb(event), 0); }); },
      async me() {
        const { data: { session } } = await sb.auth.getSession();
        if (!session) return { signedIn: false };
        const info = await rpc("get_me");
        return { signedIn: true, email: session.user.email, displayName: info && info.display_name, isModerator: !!(info && info.is_moderator) };
      },
      async signIn(email, code) {
        // The church code only matters if this email is new; existing accounts ignore it.
        const options = { emailRedirectTo: location.origin + location.pathname };
        if (code) options.data = { church_code: code };
        const { error } = await sb.auth.signInWithOtp({ email, options });
        if (error) throw new Error(error.message);
        return { sent: true };
      },
      async signInPassword(email, password) {
        const { error } = await sb.auth.signInWithPassword({ email, password });
        if (error) throw new Error(error.message);
        return { signedIn: true };
      },
      async signUp(email, password, code) {
        const { data, error } = await sb.auth.signUp({ email, password, options: { emailRedirectTo: location.origin + location.pathname, data: { church_code: code } } });
        if (error) throw new Error(error.message);
        // Supabase answers an already-registered email with a user that has no identities.
        if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) throw new Error("User already registered");
        return data.session ? { signedIn: true } : { confirm: true };
      },
      async sendReset(email) {
        const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
        if (error) throw new Error(error.message);
        return { sent: true };
      },
      async updatePassword(password) {
        const { error } = await sb.auth.updateUser({ password });
        if (error) throw new Error(error.message);
      },
      async signOut() { await sb.auth.signOut(); },
      setName: (name) => rpc("set_display_name", { p_name: name }),
      getSignupCode: () => rpc("get_signup_code"),
      setSignupCode: (code) => rpc("set_signup_code", { p_code: code }),
      async list() {
        const { data, error } = await sb.from("board_posts").select("*").order("created_at", { ascending: false }).limit(1000);
        if (error) throw new Error(error.message);
        return data || [];
      },
      create: (p) => rpc("create_post", {
        p_kind: p.kind, p_title: p.title, p_body: p.body || "", p_category: p.category || null, p_trade: p.trade || null,
        p_area: p.area || null, p_rate: p.rate || null, p_contact: p.contact || null, p_hide_name: !!p.hide_name,
        p_website: p.website || null,
      }),
      setStatus: (id, status) => rpc("set_post_status", { p_id: id, p_status: status }),
      renew: (id) => rpc("renew_post", { p_id: id }),
      remove: (id) => rpc("delete_post", { p_id: id }),
      togglePrayer: (id) => rpc("toggle_prayer", { p_id: id }),
      report: (id, reason) => rpc("report_post", { p_id: id, p_reason: reason || "" }),
      reasons: (id) => rpc("list_reports", { p_id: id }),
    };
  }

  // ---------- Data layer: demo ----------
  function demoApi() {
    const now = Date.now();
    const iso = (msAgo) => new Date(now - msAgo).toISOString();
    let me = { signedIn: false };
    let seq = 0;
    const base = { prayer_count: 0, i_prayed: false, i_reported: false, report_count: 0, is_mine: false, hide_name: false, expired: false };
    let rows = [
      { ...base, id: "d1", kind: "prayer", title: "Sample: Healing for my dad after heart surgery", body: "He’s home now but recovery is slow. Pray for strength for him and patience for my mom, who is caring for him.", author_name: "Sample member", status: "open", created_at: iso(3 * 3600e3), expires_at: iso(-57 * DAY), prayer_count: 14 },
      { ...base, id: "d2", kind: "need", title: "Sample: Rides to chemo on Tuesday mornings", body: "Appointments are at 9:00 at the regional cancer center for the next six weeks.", category: "Rides", area: "Eastside", contact: "555-0142", author_name: "Sample member", status: "open", created_at: iso(DAY), expires_at: iso(-59 * DAY) },
      { ...base, id: "d3", kind: "skill", title: "Sample: Licensed electrician", body: "Panel upgrades, outlets, lighting and troubleshooting. Licensed and insured, 15 years experience.", trade: "Electrical", area: "Within 25 miles", rate: "Free estimates", contact: "electric@example.com", website: "https://www.example.com/", author_name: "Sample tradesperson", status: "open", created_at: iso(2 * DAY), expires_at: iso(-58 * DAY) },
      { ...base, id: "d4", kind: "prayer", title: "Sample: A new job after a layoff", body: "", author_name: null, hide_name: true, status: "open", created_at: iso(4 * DAY), expires_at: iso(-56 * DAY), prayer_count: 6 },
      { ...base, id: "d5", kind: "skill", title: "Sample: Math and reading tutor", body: "Retired teacher. Grades 2–8, in person or online.", trade: "Tutoring", area: "Online or church library", rate: "$25/hr", contact: "555-0177", author_name: "Sample tradesperson", status: "open", created_at: iso(6 * DAY), expires_at: iso(-54 * DAY) },
      { ...base, id: "d6", kind: "need", title: "Sample: Meals for a family with a new baby", body: "Two dinners a week for the next three weeks would be a huge help.", category: "Meals", area: "Northside", contact: "555-0108", author_name: "Sample member", status: "closed", created_at: iso(12 * DAY), expires_at: iso(-48 * DAY) },
      { ...base, id: "d7", kind: "skill", title: "Sample: Lawn care and leaf cleanup", body: "Weekly mowing, fall cleanup, small landscaping jobs.", trade: "Landscaping & lawn", area: "Westside", contact: "555-0190", author_name: "Sample tradesperson", status: "pending", created_at: iso(2 * 3600e3), expires_at: iso(-60 * DAY) },
      { ...base, id: "d8", kind: "need", title: "Sample: Cash needed fast, message me", body: "Send gift cards and I’ll pay you back double.", category: "Financial help", contact: "scam@example.com", author_name: "Sample account", status: "open", created_at: iso(5 * 3600e3), expires_at: iso(-60 * DAY), report_count: 2 },
    ];
    const reasons = { d8: [{ reason: "Looks like a scam asking for gift cards.", created_at: iso(3600e3) }, { reason: "Not a real need.", created_at: iso(2 * 3600e3) }] };
    let authCb = () => {};
    let demoCode = "DEMO";
    const delay = (v) => new Promise((r) => setTimeout(() => r(v), 120));
    const view = () => rows
      .filter((r) => me.isModerator || r.is_mine || (["open", "closed"].includes(r.status) && !r.expired))
      .map((r) => ({
        ...r,
        author_name: r.hide_name && !r.is_mine && !me.isModerator ? null : (r.is_mine ? me.displayName : r.author_name),
        contact: me.signedIn ? r.contact : null,
        report_count: me.isModerator ? r.report_count : null,
        i_prayed: me.signedIn && r.i_prayed,
      }));
    const find = (id) => { const r = rows.find((x) => x.id === id); if (!r) throw new Error("That post no longer exists."); return r; };
    return {
      demo: true,
      onAuth(cb) { authCb = cb; },
      me: () => delay({ ...me }),
      async signIn(email) {
        me = { signedIn: true, email, displayName: null, isModerator: true };
        setTimeout(authCb, 0);
        return { sent: false };
      },
      async signInPassword(email, password) {
        if (password !== "demo-password") throw new Error("Invalid login credentials");
        me = { signedIn: true, email, displayName: null, isModerator: true };
        setTimeout(authCb, 0);
        return { signedIn: true };
      },
      async signUp(email, password, code) {
        if (password.length < 8) throw new Error("Password should be at least 8 characters.");
        if (String(code || "").trim().toLowerCase() !== demoCode.toLowerCase()) throw new Error("That church code doesn't match. Ask at church for the current code.");
        return { confirm: true };
      },
      getSignupCode: () => delay(demoCode),
      async setSignupCode(code) { demoCode = code.trim(); return delay(); },
      async sendReset(email) {
        // In the demo, act as if the reset link was clicked right away.
        me = { signedIn: true, email, displayName: "Demo Tester", isModerator: true };
        setTimeout(() => authCb("PASSWORD_RECOVERY"), 300);
        return { sent: true };
      },
      async updatePassword(password) {
        if (password.length < 8) throw new Error("Password should be at least 8 characters.");
        return delay();
      },
      async signOut() { me = { signedIn: false }; setTimeout(authCb, 0); },
      async setName(name) { me.displayName = name.trim(); return delay(); },
      list: () => delay(view()),
      async create(p) {
        rows.unshift({ ...base, ...p, id: "n" + (++seq), is_mine: true, status: me.isModerator ? "open" : "pending", created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 60 * DAY).toISOString() });
        return delay();
      },
      async setStatus(id, status) { const r = find(id); r.status = status; if (status === "open") r.report_count = 0; return delay(); },
      async renew(id) { const r = find(id); r.expired = false; r.expires_at = new Date(Date.now() + 60 * DAY).toISOString(); return delay(); },
      async remove(id) { rows = rows.filter((r) => r.id !== id); return delay(); },
      async togglePrayer(id) { const r = find(id); r.i_prayed = !r.i_prayed; r.prayer_count += r.i_prayed ? 1 : -1; return delay(r.i_prayed); },
      async report(id, reason) { const r = find(id); if (!r.i_reported) r.report_count += 1; r.i_reported = true; (reasons[id] = reasons[id] || []).unshift({ reason, created_at: new Date().toISOString() }); return delay(); },
      reasons: (id) => delay(reasons[id] || []),
    };
  }

  const live = !!(CFG.supabaseUrl && CFG.supabaseAnonKey && window.supabase);
  const api = live ? supabaseApi() : demoApi();
  if (!live) $("#demoNotice").hidden = false;
  if (CFG.supabaseUrl && !window.supabase) showError("The sign-in library didn’t load, so the board is running in demo mode. Check your connection and reload.");

  // ---------- State ----------
  const S = { me: { signedIn: false }, rows: [], loaded: false, tab: "all", q: "", trade: "", showClosed: false, kind: "prayer", reporting: null, reasons: {} };
  try {
    const saved = JSON.parse(localStorage.getItem("oab-view") || "{}");
    if (["all", "prayer", "need", "skill"].includes(saved.tab)) S.tab = saved.tab;
    S.showClosed = !!saved.showClosed;
  } catch (e) {}
  // Links from review alert emails end in #review. Remember that through a sign-in, too,
  // since the email sign-in link brings people back without it.
  let reviewIntent = location.hash === "#review";
  try { if (localStorage.getItem("oab-after-signin") === "review") reviewIntent = true; } catch (e) {}
  let reviewSignInShown = false;
  function applyReviewIntent(me) {
    if (!reviewIntent) return;
    if (me.signedIn) {
      if (me.isModerator) S.tab = "review";
      reviewIntent = false;
      try { localStorage.removeItem("oab-after-signin"); } catch (e) {}
    } else if (!reviewSignInShown) {
      reviewSignInShown = true;
      try { localStorage.setItem("oab-after-signin", "review"); } catch (e) {}
      openPanel("signInPanel");
      $("#signInMsg").textContent = "Sign in to see the posts waiting for review.";
    }
  }
  window.addEventListener("hashchange", () => {
    if (location.hash === "#review") { reviewIntent = true; applyReviewIntent(S.me); render(); }
  });

  const saveView = () => { try { localStorage.setItem("oab-view", JSON.stringify({ tab: ["mine", "review"].includes(S.tab) ? "all" : S.tab, showClosed: S.showClosed })); } catch (e) {} };

  $("#f-trade").append(h("option", { value: "", text: "Choose a trade" }), ...TRADES.map((t) => h("option", { value: t, text: t })));
  $("#f-category").append(...CATEGORIES.map((t) => h("option", { value: t, text: t })));
  $("#tradeFilter").append(h("option", { value: "", text: "All trades" }), ...TRADES.map((t) => h("option", { value: t, text: t })));
  $("#showClosed").checked = S.showClosed;

  async function refresh() {
    try {
      const [me, rows] = await Promise.all([api.me(), api.list()]);
      S.me = me; S.rows = rows; S.loaded = true;
      if (!["all", "prayer", "need", "skill"].includes(S.tab) && !(S.tab === "mine" && me.signedIn) && !(S.tab === "review" && me.isModerator)) S.tab = "all";
      applyReviewIntent(me);
      showError("");
    } catch (e) {
      showError(friendly(e));
    }
    renderAccount(); render();
  }
  async function act(fn, okMsg) {
    try { await fn(); if (okMsg) toast(okMsg); await refresh(); return true; }
    catch (e) { toast(friendly(e)); return false; }
  }

  // ---------- Panels ----------
  function openPanel(id) {
    if (id === "signInPanel" && $("#signInPanel").hidden) setAuthMode("signin");
    ["signInPanel", "newPasswordPanel", "namePanel", "composer"].forEach((p) => { $("#" + p).hidden = p !== id; });
    const first = $("#" + id).querySelector("input, textarea");
    if (first) first.focus();
  }
  function closePanel(id) { $("#" + id).hidden = true; }
  document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => closePanel(b.dataset.close)));

  function renderAccount() {
    const box = $("#account"); box.replaceChildren();
    const me = S.me;
    if (!me.signedIn) {
      box.append(h("button", { class: "btn on-band primary", type: "button", onclick: () => openPanel("signInPanel"), text: "Sign in to post" }));
      return;
    }
    if (!me.displayName && $("#newPasswordPanel").hidden) { if ($("#namePanel").hidden) openPanel("namePanel"); }
    box.append(
      h("span", { class: "who" }, "Signed in as ", h("b", { text: me.displayName || me.email || "you" }), me.isModerator ? " · Moderator" : ""),
      h("button", { class: "btn on-band small", type: "button", onclick: () => act(() => api.signOut(), "Signed out."), text: "Sign out" })
    );
    if (me.displayName) box.append(h("button", { class: "btn on-band primary", type: "button", onclick: () => { $("#composer").hidden ? openComposer() : closePanel("composer"); }, text: "+ Post to the board" }));
  }

  // ---------- Sign in: password, new account, email link, reset ----------
  const AUTH_MODES = {
    signin: { title: "Sign in", intro: "Sign in with your email and password.", password: true, autocomplete: "current-password", submit: "Sign in",
      links: [["signup", "New here? Create an account"], ["forgot", "Forgot password?"], ["link", "Email me a sign-in link instead"]] },
    signup: { title: "Create an account", intro: "Choose a password and enter the church code. We’ll email you once to confirm your address.", password: true, autocomplete: "new-password", submit: "Create account", hint: true, code: "required",
      links: [["signin", "Already have an account? Sign in"], ["link", "Email me a sign-in link instead"]] },
    link: { title: "Sign in with an email link", intro: "We’ll email you a link that signs you in. No password needed.", password: false, submit: "Email me a link", code: "optional",
      links: [["signin", "Use a password instead"]] },
    forgot: { title: "Reset your password", intro: "Enter your email and we’ll send a link to choose a new password.", password: false, submit: "Email me a reset link",
      links: [["signin", "Back to sign in"]] },
  };
  let authMode = "signin";
  function setAuthMode(mode, keepMsg) {
    authMode = mode;
    const m = AUTH_MODES[mode];
    $("#signInTitle").textContent = m.title;
    $("#signInIntro").textContent = m.intro;
    $("#passwordField").hidden = !m.password;
    $("#passwordHint").hidden = !m.hint;
    $("#codeField").hidden = !m.code;
    $("#codeLabel").textContent = m.code === "optional" ? "Church code (only if you’re new here)" : "Church code";
    const pw = $("#signInPassword");
    if (m.password) pw.setAttribute("autocomplete", m.autocomplete);
    pw.value = "";
    $("#signInBtn").textContent = m.submit;
    if (!keepMsg) { $("#signInMsg").textContent = ""; $("#signInMsg").classList.remove("bad"); }
    $("#authLinks").replaceChildren(...m.links.map(([to, label]) =>
      h("button", { class: "link-btn", type: "button", onclick: () => {
        setAuthMode(to);
        $(!$("#signInEmail").value || !AUTH_MODES[to].password ? "#signInEmail" : "#signInPassword").focus();
      }, text: label })));
  }
  setAuthMode("signin");

  $("#togglePw").addEventListener("click", () => {
    const pw = $("#signInPassword"), show = pw.type === "password";
    pw.type = show ? "text" : "password";
    $("#togglePw").textContent = show ? "Hide" : "Show";
    $("#togglePw").setAttribute("aria-pressed", String(show));
  });

  // Matches the rules set in Supabase (Authentication → Sign In / Providers → Email).
  const PASSWORD_RULE = "Use at least 8 characters, with both letters and numbers.";
  const strongEnough = (pw) => pw.length >= 8 && /[a-z]/i.test(pw) && /\d/.test(pw);

  function authMessage(e) {
    const m = (e && e.message) || "";
    if (/Invalid login credentials/i.test(m)) return "That email and password don’t match. Try again, use “Forgot password?”, or sign in with an email link.";
    if (/Email not confirmed/i.test(m)) return "Please confirm your email first. Check your inbox for the confirmation link we sent.";
    if (/already registered|already exists/i.test(m)) return "That email already has an account. Sign in instead, or use “Forgot password?” to set a new password.";
    if (/at least \d+ characters|should be at least|should contain/i.test(m)) return PASSWORD_RULE;
    if (/weak|pwned|compromised|easy to guess/i.test(m)) return "That password is too easy to guess. Try a longer one, like a short phrase.";
    if (/rate limit|security purposes|too many/i.test(m)) return "Too many tries in a short time. Please wait a minute and try again.";
    if (/church code/i.test(m)) return m;
    if (/hook|signups not allowed|database error saving new user/i.test(m)) return "We couldn’t create an account with that church code. Check the code and try again, or ask at church.";
    return friendly(e);
  }

  $("#signInForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const email = $("#signInEmail").value.trim(), password = $("#signInPassword").value, code = $("#signupCode").value.trim(), msg = $("#signInMsg");
    const bad = (text, el) => { msg.textContent = text; msg.classList.add("bad"); if (el) $(el).focus(); };
    msg.classList.remove("bad"); msg.textContent = "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return bad("Enter a full email address, like name@example.com.", "#signInEmail");
    if (AUTH_MODES[authMode].password) {
      if (!password) return bad("Enter your password.", "#signInPassword");
      if (authMode === "signup" && !strongEnough(password)) return bad(PASSWORD_RULE, "#signInPassword");
    }
    if (authMode === "signup" && !code) return bad("Enter the church code. You can get it at church.", "#signupCode");
    $("#signInBtn").disabled = true;
    try {
      if (authMode === "signin") {
        await api.signInPassword(email, password);
        closePanel("signInPanel");
        toast(api.demo ? "Signed in (demo). You’re a moderator in the demo." : "Signed in.");
      } else if (authMode === "signup") {
        const r = await api.signUp(email, password, code);
        if (r.signedIn) { closePanel("signInPanel"); toast("Account created. Welcome!"); }
        else { setAuthMode("signin", true); $("#signInEmail").value = email; msg.textContent = "Almost done! Check your email for a link to confirm your address, then sign in here with your password."; }
      } else if (authMode === "link") {
        const r = await api.signIn(email, code);
        if (r.sent) msg.textContent = "Check your email for a sign-in link. You can close this page; the link brings you back.";
        else { closePanel("signInPanel"); toast("Signed in (demo). You’re a moderator in the demo."); }
      } else if (authMode === "forgot") {
        await api.sendReset(email);
        msg.textContent = "If that email has an account, a reset link is on its way. Open it on this device to choose a new password.";
      }
    } catch (e) { bad(authMessage(e)); }
    finally { $("#signInBtn").disabled = false; }
  });

  // Arriving from a password reset email
  function showNewPassword() {
    openPanel("newPasswordPanel");
    $("#newPwMsg").textContent = "";
  }
  $("#newPasswordForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const pw = $("#newPassword").value, msg = $("#newPwMsg");
    msg.classList.remove("bad");
    if (!strongEnough(pw)) { msg.textContent = PASSWORD_RULE; msg.classList.add("bad"); return; }
    $("#newPwBtn").disabled = true;
    try {
      await api.updatePassword(pw);
      $("#newPassword").value = "";
      closePanel("newPasswordPanel");
      toast("Password saved. Use it next time you sign in.");
      await refresh();
    } catch (e) { msg.textContent = authMessage(e); msg.classList.add("bad"); }
    finally { $("#newPwBtn").disabled = false; }
  });

  $("#nameForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const name = $("#nameInput").value.trim(), msg = $("#nameMsg");
    if (!name) { msg.textContent = "Enter the name you’d like on your posts."; msg.classList.add("bad"); return; }
    msg.textContent = "";
    if (await act(() => api.setName(name), "Thanks, " + name + ".")) closePanel("namePanel");
  });

  // ---------- Composer ----------
  function setKind(kind) {
    S.kind = kind;
    document.querySelectorAll(".kind-opt").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.kind === kind)));
    document.querySelectorAll("#postForm [data-for]").forEach((el) => { el.hidden = !el.dataset.for.split(" ").includes(kind); });
    $("#l-title").textContent = KIND[kind].titleLabel;
    $("#f-title").placeholder = KIND[kind].titlePh;
    $("#l-body").textContent = KIND[kind].bodyLabel;
    $("#l-contact").textContent = kind === "need" ? "How to reach you (optional)" : "How to reach you";
    $("#submitBtn").textContent = KIND[kind].submit;
    $("#postMsg").textContent = "";
  }
  function openComposer() {
    if (!S.me.signedIn) return openPanel("signInPanel");
    if (!S.me.displayName) return openPanel("namePanel");
    setKind(KIND[S.tab] ? S.tab : S.kind);
    openPanel("composer");
  }
  document.querySelectorAll(".kind-opt").forEach((b) => b.addEventListener("click", () => setKind(b.dataset.kind)));

  $("#postForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const kind = S.kind, v = (id) => $(id).value.trim(), msg = $("#postMsg");
    const p = { kind, title: v("#f-title"), body: v("#f-body") };
    const fail = (text, el) => { msg.textContent = text; msg.classList.add("bad"); if (el) $(el).focus(); };
    if (!p.title) return fail(kind === "skill" ? "Add your business or name." : "Add a short title.", "#f-title");
    if (kind === "prayer") p.hide_name = $("#f-hide").checked;
    if (kind === "need") Object.assign(p, { category: v("#f-category"), area: v("#f-area"), contact: v("#f-contact") });
    if (kind === "skill") {
      Object.assign(p, { trade: v("#f-trade"), area: v("#f-area"), rate: v("#f-rate"), contact: v("#f-contact") });
      if (!p.trade) return fail("Choose the trade you offer.", "#f-trade");
      if (!p.contact) return fail("Add a phone number or email so people can reach you.", "#f-contact");
      const site = v("#f-website");
      if (site) {
        p.website = normalizeWebsite(site);
        if (!p.website) return fail("That website address doesn’t look right. Try something like www.yourbusiness.com.", "#f-website");
      }
    }
    $("#submitBtn").disabled = true;
    const ok = await act(() => api.create(p), S.me.isModerator ? "Posted to the board." : "Thanks! A moderator will review your post before it appears.");
    $("#submitBtn").disabled = false;
    if (ok) { $("#postForm").reset(); closePanel("composer"); if (!S.me.isModerator) { S.tab = "mine"; render(); } }
  });

  // ---------- Toolbar ----------
  document.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => { S.tab = b.dataset.tab; saveView(); render(); }));
  $("#search").addEventListener("input", (e) => { S.q = e.target.value.trim().toLowerCase(); render(); });
  $("#tradeFilter").addEventListener("change", (e) => { S.trade = e.target.value; render(); });
  $("#showClosed").addEventListener("change", (e) => { S.showClosed = e.target.checked; saveView(); render(); });

  // ---------- Board ----------
  const onBoard = (r) => (r.status === "open" || r.status === "closed") && !r.expired;
  const needsReview = (r) => r.status === "pending" || (r.report_count > 0 && r.status === "open");

  function render() {
    const me = S.me, rows = S.rows;
    const openRows = rows.filter((r) => onBoard(r) && r.status === "open");
    const count = {
      all: openRows.length,
      prayer: openRows.filter((r) => r.kind === "prayer").length,
      need: openRows.filter((r) => r.kind === "need").length,
      skill: openRows.filter((r) => r.kind === "skill").length,
      mine: rows.filter((r) => r.is_mine).length,
      review: rows.filter(needsReview).length,
    };
    document.querySelector('[data-tab="mine"]').hidden = !me.signedIn;
    document.querySelector('[data-tab="review"]').hidden = !me.isModerator;
    document.querySelectorAll(".tab").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.tab === S.tab)));
    document.querySelectorAll("[data-n]").forEach((n) => {
      const k = n.dataset.n;
      n.textContent = !S.loaded ? "" : (k === "review" ? (count.review || "") : count[k]);
    });
    $("#tradeFilter").hidden = S.tab !== "skill";
    $("#showClosed").parentElement.hidden = S.tab === "review" || S.tab === "mine";

    if (S.loaded) {
      $("#tally").replaceChildren(
        h("b", { text: count.prayer }), ` prayer request${count.prayer === 1 ? "" : "s"} · `,
        h("b", { text: count.need }), ` open need${count.need === 1 ? "" : "s"} · `,
        h("b", { text: count.skill }), ` trade${count.skill === 1 ? "" : "s"} listed`
      );
    }

    let list;
    if (S.tab === "review") list = rows.filter(needsReview);
    else if (S.tab === "mine") list = rows.filter((r) => r.is_mine);
    else list = rows.filter((r) => onBoard(r) && (S.showClosed || r.status === "open") && (S.tab === "all" || r.kind === S.tab) && (S.tab !== "skill" || !S.trade || r.trade === S.trade));
    if (S.q) list = list.filter((r) => [r.title, r.body, r.trade, r.category, r.area].some((f) => f && f.toLowerCase().includes(S.q)));
    const rank = (r) => (r.status === "closed" ? 1 : 0);
    list.sort((a, b) => rank(a) - rank(b) || String(b.created_at).localeCompare(String(a.created_at)));

    renderReviewTools();
    const board = $("#board");
    if (!S.loaded) { board.replaceChildren(empty("Loading posts…", "Gathering prayer requests, needs and trades.")); return; }
    if (!list.length) {
      const msgs = {
        all: ["The board is empty for now", "Be the first to share a prayer request, ask for help, or list the trade work you do."],
        prayer: ["No prayer requests yet", "Share what’s on your heart and let others pray with you."],
        need: ["No open needs right now", "Need a meal, a ride or a hand with something? Post it here."],
        skill: ["No trades listed yet", "Electrician, painter, tutor, mechanic? List your work so neighbors can hire you."],
        mine: ["You haven’t posted yet", "Your posts show up here, including ones waiting for review."],
        review: ["Nothing to review", "New posts and reported posts will show up here."],
      };
      const [t, p] = (S.q || S.trade) ? ["Nothing matches", "Try a different search or trade."] : msgs[S.tab];
      board.replaceChildren(empty(t, p, S.tab !== "review" && !(S.q || S.trade)));
      return;
    }
    board.replaceChildren(...list.map(card));
  }

  // Church sign-up code, shown to moderators at the top of the Review tab.
  let codeState = { value: undefined, editing: false, saving: false };
  function renderReviewTools() {
    const box = $("#reviewTools");
    const show = S.tab === "review" && S.me.isModerator;
    box.hidden = !show;
    if (!show) return;
    if (codeState.value === undefined) {
      codeState.value = null;
      api.getSignupCode().then((c) => { codeState.value = c || ""; render(); }, () => { codeState.value = ""; render(); });
    }
    const card = h("div", { class: "code-card" });
    if (codeState.editing) {
      const input = h("input", { id: "newSignupCode", maxlength: "40", value: codeState.value || "", "aria-label": "New church code", autocomplete: "off", spellcheck: "false" });
      const save = async () => {
        const v = input.value.trim();
        if (v.length < 4) { toast("Use a code with at least 4 characters."); input.focus(); return; }
        codeState.saving = true; render();
        try { await api.setSignupCode(v); codeState = { value: v, editing: false, saving: false }; toast("Church code changed. Share the new one at church."); }
        catch (e) { codeState.saving = false; toast(friendly(e)); }
        render();
      };
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") save(); if (e.key === "Escape") { codeState.editing = false; render(); } });
      card.append(
        h("label", { for: "newSignupCode" }, h("b", { text: "New church code" })),
        input,
        h("button", { class: "btn small primary", type: "button", disabled: codeState.saving, onclick: save, text: codeState.saving ? "Saving…" : "Save" }),
        h("button", { class: "btn small quiet", type: "button", onclick: () => { codeState.editing = false; render(); }, text: "Cancel" }),
        h("span", { class: "hint", text: "People who already have accounts aren’t affected. Only new sign-ups need the new code." })
      );
      setTimeout(() => { if (document.activeElement !== input) input.focus(); }, 0);
    } else {
      card.append(
        h("span", {}, "Church code for new accounts: ", codeState.value == null ? "…" : h("span", { class: "code-value", text: codeState.value || "(none set)" })),
        h("button", { class: "btn small", type: "button", disabled: codeState.value == null, onclick: () => { codeState.editing = true; render(); }, text: "Change code" })
      );
    }
    box.replaceChildren(card);
  }

  function empty(title, text, withButton) {
    return h("div", { class: "empty" }, h("h3", { text: title }), h("p", { text }),
      withButton ? h("button", { class: "btn primary", type: "button", onclick: openComposer, text: "+ Post to the board" }) : null);
  }

  function confirmButton(label, confirmLabel, cls, onConfirm) {
    const b = h("button", { class: "btn small quiet " + (cls || ""), type: "button", text: label });
    let armed = null;
    b.addEventListener("click", () => {
      if (armed) { clearTimeout(armed); armed = null; onConfirm(); return; }
      b.textContent = confirmLabel;
      armed = setTimeout(() => { armed = null; b.textContent = label; }, 4000);
    });
    return b;
  }

  function copyContact(text, el) {
    const select = () => { const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); toast("Selected. Copy it with your keyboard."); };
    try { navigator.clipboard.writeText(text).then(() => toast("Copied."), select); } catch (e) { select(); }
  }

  function card(r) {
    const K = KIND[r.kind] || KIND.need, me = S.me;
    const closed = r.status === "closed", isOpen = r.status === "open" && !r.expired;
    const reviewing = S.tab === "review";

    let stamp;
    if (r.status === "pending") stamp = h("span", { class: "stamp pending", text: "Awaiting review" });
    else if (r.status === "rejected") stamp = h("span", { class: "stamp rejected", text: "Not approved" });
    else if (r.expired) stamp = h("span", { class: "stamp expired", text: "Expired" });
    else if (closed) stamp = h("span", { class: "stamp", text: K.closed });
    else if (me.isModerator && r.report_count > 0) stamp = h("span", { class: "stamp reported", text: `Reported ×${r.report_count}` });
    else stamp = h("span", { class: "when", title: new Date(r.created_at).toLocaleString(), text: ago(r.created_at) });

    let who;
    if (r.is_mine) who = r.hide_name ? "You (name hidden from others)" : "You";
    else if (r.hide_name && !r.author_name) who = "A member of our community";
    else who = (r.author_name || "A neighbor") + (r.hide_name ? " (name hidden from others)" : "");

    const facts = [r.trade, r.category, r.area, r.rate].filter(Boolean);
    const main = h("div", { class: "main" },
      h("div", { class: "eyebrow" }, h("span", { class: "kind-label", text: K.label }), stamp),
      h("h3", { text: r.title }),
      r.body ? h("p", { class: "body", text: r.body }) : null,
      facts.length ? h("div", { class: "facts" }, facts.map((f) => h("span", { class: "fact", text: f }))) : null,
      r.kind === "skill" && r.website && /^https?:\/\//i.test(r.website)
        ? h("a", { class: "site-link", href: r.website, target: "_blank", rel: "noopener noreferrer nofollow ugc", text: prettyWebsite(r.website) })
        : null,
      h("div", { class: "byline", text: who })
    );

    // Left side of the tear-off strip
    const left = [];
    if (r.kind === "prayer" && !reviewing) {
      if (me.signedIn) {
        left.push(h("button", {
          class: "btn small" + (r.i_prayed ? " on" : ""), type: "button", "aria-pressed": String(!!r.i_prayed), disabled: !isOpen,
          onclick: () => act(() => api.togglePrayer(r.id), r.i_prayed ? null : "Thank you for praying."),
          text: r.i_prayed ? "🙏 I prayed" : "🙏 I’ll pray",
        }));
      } else if (isOpen) {
        left.push(h("button", { class: "btn small", type: "button", onclick: () => openPanel("signInPanel"), text: "🙏 Sign in to pray" }));
      }
      left.push(h("span", { class: "when", text: r.prayer_count ? `${r.prayer_count} praying` : "Be the first to pray" }));
    } else if (r.contact) {
      const c = h("span", { class: "contact-text", text: r.contact });
      left.push(c, h("button", { class: "btn small quiet", type: "button", onclick: () => copyContact(r.contact, c), text: "Copy" }));
    } else if (!me.signedIn && r.kind !== "prayer") {
      left.push(h("button", { class: "btn small", type: "button", onclick: () => openPanel("signInPanel"), text: "Sign in to see contact details" }));
    } else if (r.kind === "need") {
      left.push(h("span", { class: "when", text: "No contact given. Ask a church leader to connect you." }));
    }

    // Actions
    const actions = [];
    if (reviewing) {
      actions.push(h("button", { class: "btn small quiet ok", type: "button", onclick: () => act(() => api.setStatus(r.id, "open"), r.status === "pending" ? "Approved." : "Kept on the board."), text: r.status === "pending" ? "Approve" : "Keep" }));
      if (r.status === "pending") actions.push(h("button", { class: "btn small quiet danger", type: "button", onclick: () => act(() => api.setStatus(r.id, "rejected"), "Not approved."), text: "Decline" }));
      actions.push(confirmButton("Remove", "Confirm remove", "danger", () => act(() => api.remove(r.id), "Post removed.")));
    } else if (r.is_mine) {
      if (r.status === "open" || r.status === "closed") actions.push(h("button", { class: "btn small quiet", type: "button", onclick: () => act(() => api.setStatus(r.id, closed ? "open" : "closed"), closed ? "Reopened." : K.closed + "."), text: closed ? K.reopen : K.close }));
      const daysLeft = (new Date(r.expires_at) - Date.now()) / DAY;
      if (r.status !== "rejected" && (r.expired || daysLeft < 14)) actions.push(h("button", { class: "btn small quiet", type: "button", onclick: () => act(() => api.renew(r.id), "Renewed for 60 days."), text: "Renew" }));
      actions.push(confirmButton("Remove", "Confirm remove", "danger", () => act(() => api.remove(r.id), "Post removed.")));
    } else if (me.signedIn) {
      if (me.isModerator) actions.push(confirmButton("Remove", "Confirm remove", "danger", () => act(() => api.remove(r.id), "Post removed.")));
      else if (r.i_reported) actions.push(h("span", { class: "when", text: "Reported" }));
      else actions.push(h("button", { class: "btn small quiet", type: "button", onclick: () => { S.reporting = r.id; render(); }, text: "Report" }));
    }

    const strip = [];
    if (left.length || actions.length) strip.push(h("div", { class: "tear" }, h("div", { class: "tear-left" }, left), actions.length ? h("div", { class: "row-actions" }, actions) : null));

    // Report form
    if (S.reporting === r.id) {
      const input = h("input", { id: "report-" + r.id, maxlength: "300", placeholder: "What’s wrong with this post? (optional)", "aria-label": "Reason for reporting" });
      strip.push(h("div", { class: "tear" }, h("div", { class: "report-box" }, input, h("div", { class: "btn-row" },
        h("button", { class: "btn small primary", type: "button", onclick: () => { S.reporting = null; act(() => api.report(r.id, input.value.trim()), "Thanks. A moderator will take a look."); }, text: "Send report" }),
        h("button", { class: "btn small quiet", type: "button", onclick: () => { S.reporting = null; render(); }, text: "Cancel" })
      ))));
      setTimeout(() => input.focus(), 0);
    }

    // Report reasons for moderators
    if (reviewing && r.report_count > 0) {
      const box = h("div", { class: "tear" });
      const list = S.reasons[r.id];
      if (list) box.append(h("ul", { class: "reasons" }, list.map((x) => h("li", { text: x.reason || "No reason given" }))));
      else {
        box.append(h("span", { class: "when", text: "Loading report reasons…" }));
        api.reasons(r.id).then((l) => { S.reasons[r.id] = l || []; render(); }, () => { S.reasons[r.id] = []; });
      }
      strip.push(box);
    }

    return h("article", { class: "card" + (closed ? " closed" : "") + (r.expired ? " expired" : ""), "data-kind": r.kind }, main, ...strip);
  }

  // ---------- Boot ----------
  render();
  api.onAuth((event) => {
    if (event === "PASSWORD_RECOVERY") showNewPassword();
    refresh();
  });
  refresh();
  setInterval(() => { if (!document.hidden && !S.reporting && !codeState.editing && $("#composer").hidden) refresh(); }, 60000);
})();
