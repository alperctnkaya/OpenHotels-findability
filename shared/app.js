// OpenHotels findability — voting page.  Plain browser JS, no build step, no dependencies.
// Talks to Supabase through seven RPC functions (supabase/schema.sql in the study repo) and fetches the per-hotel JSON
// + WebP thumbnails produced by build_study.py from DATA_BASE_URL.  A "cell" is {src, w, h}: thumbnail path and size.
(() => {
  const C = window.STUDY_CONFIG;
  const $ = (id) => document.getElementById(id);
  const debug = new URLSearchParams(location.search).has("debug");   // ?debug=1 adds model details to the metadata
  const SPLITS = {
    test_non_object: { label: "room photos" },
    test_object: { label: "object crops" },
  };
  const isSplit = (s) => Object.prototype.hasOwnProperty.call(SPLITS, s);
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const PAGE = 60;                                   // items per page in "My votes"
  const MAX_VOTES = 3;
  const EAGER_IMAGES = 12;
  const PRELOAD_IMAGES = 12;
  const WARM_LIMIT = 200;
  const labelText = (l) => (l === "findable" ? "Findable" : "Not findable");
  const fmt = (n) => Number(n || 0).toLocaleString();
  const imageId = (src) => String(src || "").replace(/^thumbs[/]/, "").replace(/\.(webp|jpg|jpeg|png)$/i, "");

  // ── identity: a random code kept in this browser ─────────────────────────────────────────────────
  const PREFIX = (C && C.STORAGE_PREFIX) || "fs_";    // set per site in config.js: every site on this domain shares one localStorage
  const store = {
    get(k) { try { return localStorage.getItem(PREFIX + k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(PREFIX + k, v); } catch { /* private mode etc. */ } },
  };
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
    : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => { const r = Math.random() * 16 | 0; return (c === "x" ? r : (r & 3 | 8)).toString(16); }));
  let userId = store.get("user_id");
  if (!userId || !UUID_RE.test(userId)) { userId = uuid(); store.set("user_id", userId); }
  let userName = store.get("user_name") || "";
  let passcode = store.get("pass") || "";             // shared passcode, typed once, checked by every server function

  // ── server ───────────────────────────────────────────────────────────────────────────────────────
  class PassError extends Error {}
  const CONFIG_MSG = "config.js is not filled in yet (SUPABASE_URL / SUPABASE_ANON_KEY / DATA_BASE_URL).";
  const configured = () => !!C && !!C.SUPABASE_URL && !!C.SUPABASE_ANON_KEY && !/YOUR-/.test(C.SUPABASE_URL + C.SUPABASE_ANON_KEY);
  async function rpc(fn, args) {
    if (!configured()) throw new Error(CONFIG_MSG);
    if (!passcode) throw new PassError("Please enter the study passcode.");
    let r;
    try {
      r = await fetch(`${C.SUPABASE_URL}/rest/v1/rpc/${fn}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: C.SUPABASE_ANON_KEY, Authorization: `Bearer ${C.SUPABASE_ANON_KEY}` },
        body: JSON.stringify({ ...args, p_pass: passcode }),
      });
    } catch {
      throw new Error("Cannot reach the voting server. If this persists, tell the organiser (the free database may be paused).");
    }
    if (!r.ok) throw new Error(`Voting server error ${r.status} on ${fn}: ${(await r.text().catch(() => "")).slice(0, 200)}`);
    const out = await r.json();
    if (out && (out.error === "bad_pass" || out.status === "bad_pass")) {
      passcode = ""; store.set("pass", "");
      throw new PassError("The passcode was not accepted. Please enter it again.");
    }
    return out;
  }

  // ── data files ───────────────────────────────────────────────────────────────────────────────────
  const dataUrl = (p) => `${C.DATA_BASE_URL}/${p}`;
  const hotelCache = new Map();
  function fetchHotel(hid) {
    if (!hotelCache.has(hid)) {
      const p = fetch(dataUrl(`h/${hid.slice(0, 2)}/${hid}.json`)).then((r) => {
        if (!r.ok) throw new Error(`Could not load hotel data (${r.status}) from ${C.DATA_BASE_URL}`);
        return r.json();
      });
      p.catch(() => hotelCache.delete(hid));
      hotelCache.set(hid, p);
    }
    return hotelCache.get(hid);
  }
  const warm = new Map();
  const imgFail = { until: 0 };
  function preload(paths) {
    for (const p of paths) {
      const im = warm.get(p) || Object.assign(new Image(), { src: dataUrl(p) });
      warm.delete(p); warm.set(p, im);
    }
    for (const p of warm.keys()) { if (warm.size <= WARM_LIMIT) break; warm.delete(p); }
  }

  // ── small dom helpers ────────────────────────────────────────────────────────────────────────────
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  function icon(id) {
    const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const u = document.createElementNS("http://www.w3.org/2000/svg", "use");
    u.setAttribute("href", `#${id}`); s.append(u); s.setAttribute("aria-hidden", "true");
    return s;
  }
  const lazyLoader = "IntersectionObserver" in window ? new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { e.target.src = e.target.dataset.src; lazyLoader.unobserve(e.target); }
  }, { rootMargin: "1000px 0px" }) : null;
  function cellEl(cell, lazy) {
    const box = el("div", "cell");
    box.style.aspectRatio = `${cell.w} / ${cell.h}`;
    const im = el("img");
    im.width = cell.w; im.height = cell.h; im.alt = ""; im.decoding = "async"; im.draggable = false;
    if (lazy && lazyLoader) { im.dataset.src = dataUrl(cell.src); lazyLoader.observe(im); } else im.src = dataUrl(cell.src);
    let tries = 0;
    im.addEventListener("error", () => {
      imgFail.until = Date.now() + 60000;
      if (tries >= 2) { box.classList.add("failed"); toast("Some photos did not load. The photo server may be busy: wait a minute, then reopen this query.", 9000); return; }
      setTimeout(() => { const u = im.src; im.removeAttribute("src"); im.src = u; }, 20000 * 3 ** tries++ + Math.random() * 3000);
    });
    box.append(im);
    return box;
  }
  function framedCell(cell, frameAr, lazy) {          // letterbox a cell into a fixed-ratio frame
    const frame = el("div", "frame");
    frame.style.aspectRatio = `${frameAr}`;
    const box = cellEl(cell, lazy);
    const ar = cell.w / cell.h;
    box.style.width = ar >= frameAr ? "100%" : `${(100 * ar / frameAr).toFixed(3)}%`;
    frame.append(box);
    return frame;
  }
  function hotelLine(hotel) {
    const h = (hotel && hotel.hotel) || {};
    const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
    const place = [h.city, h.country].map(clean).filter(Boolean).join(", ");
    return { title: clean(h.name) || "name unknown", place };
  }
  function galleryOrder(hotel, qid) {
    const info = hotel.queries[qid];
    const order = hotel.gallery.map((_, i) => i);
    if (info && info.sims) order.sort((a, b) => info.sims[b] - info.sims[a]);
    return order;
  }

  // ── state ────────────────────────────────────────────────────────────────────────────────────────
  let tab = store.get("tab");
  if (!isSplit(tab) && tab !== "mine") tab = "test_non_object";
  const live = { test_non_object: { cur: null, next: null }, test_object: { cur: null, next: null } };
  const pos = {};                                     // split -> queue position to continue from
  for (const s of Object.keys(SPLITS)) pos[s] = Math.max(0, parseInt(store.get(`pos_${s}`) || "0", 10) || 0);
  let skipVoted = store.get("skip_voted") !== "0";     // on unless this browser switched it off
  let review = null;                                  // { split, offset, total, vote, q }
  const FILTERS = ["all", "findable", "not_findable", "disagree"];
  const mine = { split: isSplit(store.get("mine_split")) ? store.get("mine_split") : "test_non_object", page: 0,
                 filter: FILTERS.includes(store.get("mine_filter")) ? store.get("mine_filter") : "all" };
  let progress = {};                                  // split -> {queries, voted, votes}
  let myCounts = {};                                  // split -> my number of votes
  let busy = false;
  let shownAt = 0;

  // ── queue ────────────────────────────────────────────────────────────────────────────────────────
  async function pull(split, fromRank, exclude, ahead, open = skipVoted) {   // open: only queries nobody has voted on
    const res = await rpc("next_query", { p_user: userId, p_split: split, p_from_rank: fromRank, p_skip_voted: open, p_exclude: exclude || null });
    if (res.error) throw new Error(`next_query: ${res.error}`);
    progress[split] = res.progress;
    if (res.mine) myCounts = { ...myCounts, ...res.mine };
    renderCounts();
    if (!res.qid) return null;
    const hotel = await fetchHotel(res.hotel_id);
    if (ahead && Date.now() > imgFail.until) preload([res.cell.src, ...galleryOrder(hotel, res.qid).slice(0, PRELOAD_IMAGES).map((i) => hotel.gallery[i].src)]);
    return { qid: res.qid, hotel_id: res.hotel_id, idx: res.idx, kind: res.kind, rank: res.queue_rank, full: !!res.full,
             votes: res.votes || { n: 0, up: 0, down: 0, voters: [] }, wrapped: !!res.wrapped, cell: res.cell, hotel,
             myVote: res.my_vote || null, skipped: !!res.skipped };
  }

  // "Go to" and the arrows beside it: show exactly the query at this position, whatever its votes and whatever the filter
  // says.  One the user already answered opens in review (so it can be changed); the queue then continues after it.
  // An arrow step is quiet (no toasts) and does not preload the next query's photos.
  async function jumpTo(split, rank, step = false) {
    busy = true; refreshButtons(); hide("error"); $("loading").hidden = false;
    const L = live[split]; L.cur = null; L.next = null; review = null;
    try {
      const res = await rpc("next_query", { p_user: userId, p_split: split, p_from_rank: rank, p_skip_voted: false, p_exclude: null, p_exact: true });
      if (res.error) throw new Error(`next_query: ${res.error}`);
      progress[split] = res.progress; if (res.mine) myCounts = { ...myCounts, ...res.mine };
      if (!res.qid) { toast(`There is no position ${fmt(rank + 1)}.`); advance(split); return; }
      const hotel = await fetchHotel(res.hotel_id);
      const tally = res.votes || { n: 0, up: 0, down: 0, voters: [] };
      const q = { qid: res.qid, hotel_id: res.hotel_id, idx: res.idx, kind: res.kind, rank: res.queue_rank, full: !!res.full,
                  votes: tally, wrapped: false, cell: res.cell, hotel };
      pos[split] = q.rank + 1; store.set(`pos_${split}`, String(q.rank));
      L.next = pull(split, q.rank + 1, q.qid, !step); L.next.catch(() => {});
      if (res.my_vote) {                                   // already answered: open it as a review of that answer
        review = { split, offset: null, total: myCounts[split] || 0, vote: { qid: q.qid, ...res.my_vote }, q };
        if (tab === split) renderQuery(q, { ...res.my_vote, split, offset: null, total: review.total });
        if (!step) toast(`You already answered position ${fmt(q.rank + 1)}; you can change it here.`);
      } else {
        L.cur = q;
        if (tab === split) renderQuery(q, null);
        if (res.skipped) toast("You skipped this one earlier.");
        else if (skipVoted && tally.n && !step) toast("Showing the exact position you asked for, even though it already has votes.");
      }
    } catch (e) {
      if (tab === split) showError(e);
    } finally {
      busy = false; refreshButtons();
    }
  }

  async function advance(split, open = false) {
    const L = live[split];
    busy = true; refreshButtons(); hide("error");
    if (tab === split) $("loading").hidden = false;
    try {
      let q = null;
      if (L.next) { q = await L.next.catch(() => null); L.next = null; }
      if (!q) q = await pull(split, pos[split], null, false, open || skipVoted);
      L.cur = q;
      if (q) {
        pos[split] = q.rank; store.set(`pos_${split}`, String(q.rank));
        L.next = pull(split, q.rank + 1, q.qid, true);  // prefetch the following one
        L.next.catch(() => {});
      }
      if (tab === split && !review) {
        if (q) { renderQuery(q, null); if (q.wrapped) toast("Reached the end of the list; continuing from the start."); }
        else showEmpty();
      }
    } catch (e) {
      if (tab === split) showError(e);
    } finally {
      busy = false; refreshButtons();
    }
  }

  async function firstOpen() {                       // the lowest position nobody has voted on, whatever the switch says
    if (busy || !isSplit(tab)) return;
    const L = live[tab];
    review = null; L.cur = null; L.next = null; pos[tab] = 0;
    await advance(tab, true);
    if (L.cur && !review) toast(`Position ${fmt(L.cur.rank + 1)} is the first query nobody has voted on yet.`);
  }

  function restart(split) {                           // settings changed (filter / position): drop prefetch, pull again
    live[split].cur = null; live[split].next = null;
    advance(split);
  }

  function renderTally(q, rev) {
    const t = $("tally");
    const v = q.votes || { n: 0, up: 0, down: 0, voters: [] };
    t.classList.toggle("full", !!q.full);
    t.replaceChildren();
    if (!v.n) {
      t.append("No votes yet. You are the first.");
    } else {
      t.append(el("b", null, `Votes so far: ${v.up} findable · ${v.down} not findable`));
      if (v.voters && v.voters.length) {
        t.append(el("span", "names", "(" + v.voters.map((x) => `${x.label === "findable" ? "findable" : "not findable"}: ${x.name || "anonymous"}`).join(", ") + ")"));
      }
      if (q.full) t.append(el("span", null, rev
        ? `This query has its ${MAX_VOTES} votes. You can still change your own answer, or send a note to the admin.`
        : `This query already has its ${MAX_VOTES} votes, so a fourth cannot be added. If you disagree, send a note to the admin.`));
    }
    t.hidden = false;
  }

  function renderModel(q, info) {
    const top = info && info.top;
    const panel = $("top-panel");
    panel.hidden = true; $("top-grid").replaceChildren();
    $("m-model-row").hidden = !(top && top.length);
    if (!top || !top.length) return;
    const rank = top.findIndex((t) => t.hotel === q.hotel_id);
    const badge = el("span", `badge mark ${rank === 0 ? "yes" : "no"}`);
    badge.title = rank === 0 ? "The model's top match is from this hotel" : "The model's top match is from another hotel";
    badge.append(icon(rank === 0 ? "i-check" : "i-close"));
    $("q-cell").querySelector(".qbox").append(badge);
    $("top-k").textContent = top.length;
    const label = (open) => `${open ? "Hide" : "Show"} its top ${top.length}`;
    const btn = el("button", "linkbtn", label(false)); btn.type = "button"; btn.setAttribute("aria-expanded", "false");
    btn.addEventListener("click", () => {
      const open = panel.hidden;
      panel.hidden = !open; btn.textContent = label(open); btn.setAttribute("aria-expanded", String(open));
      if (open && !$("top-grid").childElementCount) fillTop(q, top);
      if (open) requestAnimationFrame(() => panel.scrollIntoView({ block: "nearest", behavior: "smooth" }));
    });
    $("m-model").replaceChildren(rank === 0 ? "top match is this hotel" : rank > 0 ? `this hotel first at rank ${rank + 1}` : `this hotel is not in its top ${top.length}`, " · ", btn);
  }
  function fillTop(q, top) {
    const grid = $("top-grid");
    top.forEach((t, k) => {
      const same = t.hotel === q.hotel_id;
      const card = el("figure", "card");
      const fr = framedCell(t, 4 / 3);
      const badge = el("span", `badge ${same ? "yes" : "no"}`);
      badge.title = same ? "this hotel" : "another hotel"; badge.append(icon(same ? "i-check" : "i-close"));
      fr.append(badge);
      fr.addEventListener("click", () => lightbox(t));
      const cap = el("figcaption");
      const name = same ? "this hotel" : (q.hotel.names && q.hotel.names[t.hotel]) || `hotel ${t.hotel}`;
      const who = el("span", "view-type", `${k + 1}. ${name}`); who.title = name;
      const sim = el("span", "sim"); sim.append("sim ", el("b", null, Number(t.sim).toFixed(3)));
      const meta = el("span", "date tnum"); meta.append(el("span", null, `hotel ${t.hotel}`));
      cap.append(who, sim, meta);
      card.append(fr, cap); grid.append(card);
    });
  }
  function renderQuery(q, rev) {
    const info = q.hotel.queries[q.qid];
    const isObj = info ? info.is_object : q.qid.startsWith("test_object");
    $("q-kind").textContent = isObj ? `crop of a ${q.kind}` : `${q.kind} photo`;

    const qc = $("q-cell"); qc.replaceChildren(); qc.classList.remove("flash-yes", "flash-no");
    const box = cellEl(q.cell); box.classList.add("qbox");
    box.style.setProperty("--ar", (q.cell.w / q.cell.h).toFixed(4));    // style.css sizes the query photo from it
    box.addEventListener("click", () => lightbox(q.cell));
    qc.append(box);

    const hl = hotelLine(q.hotel);
    const mh = $("m-hotel"); mh.replaceChildren();
    mh.append(el("span", "tnum", q.hotel_id), ` · ${hl.title}`);
    if (hl.place) mh.append(el("span", "sub", hl.place));
    $("m-image").textContent = imageId(q.cell.src);
    $("m-qid").textContent = `${q.qid} · position ${fmt(q.rank + 1)}`;
    $("m-date").textContent = (info && info.date) || "unknown";
    const room = info && info.room;
    $("m-room-row").hidden = !room;
    if (room) $("m-room").textContent = room;
    renderModel(q, info);
    $("m-debug-row").hidden = !debug;
    if (debug) $("m-debug").textContent = `best sim ${info ? info.best_sim : "?"} · rank ${q.rank}`;

    const gal = q.hotel.gallery;
    const sims = info ? info.sims : null;
    const order = galleryOrder(q.hotel, q.qid);                            // most similar first
    $("g-count").textContent = fmt(gal.length);
    const grid = $("g-grid"); if (lazyLoader) lazyLoader.disconnect(); grid.replaceChildren();
    for (const [n, i] of order.entries()) {
      const g = gal[i];
      const card = el("figure", "card");
      const fr = framedCell(g, 4 / 3, n >= EAGER_IMAGES);
      fr.title = `${imageId(g.src)}${g.room ? ` · room ${g.room}` : ""}`;
      fr.addEventListener("click", () => lightbox(g));
      const cap = el("figcaption");
      const view = el("span", "view-type", g.view || "unlabelled"); view.title = view.textContent;
      cap.append(view);
      const sim = el("span", "sim"); sim.append("sim ", el("b", null, sims ? Number(sims[i]).toFixed(3) : "–"));
      const meta = el("span", "date tnum");
      [g.room ? `room ${g.room}` : null, g.date ? `taken ${g.date}` : "date unknown"].filter(Boolean).forEach((t, k) => { if (k) meta.append(" · "); meta.append(el("span", null, t)); });
      cap.append(sim, meta);
      card.append(fr, cap); grid.append(card);
    }

    renderTally(q, rev);
    const b = $("review-banner");
    if (rev) {
      b.hidden = false; b.replaceChildren();
      const when = new Date(rev.created_at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
      const fname = { findable: "findable answers", not_findable: "not-findable answers", disagree: "disagreements" }[rev.filter] || "answers";
      const which = rev.offset == null ? "Your answer for this query" : `Your ${rev.total - rev.offset} of ${rev.total} ${fname} for ${SPLITS[rev.split].label}`;
      const txt = el("span");
      txt.append(`${which}, cast ${when}${rev.updated_at ? ", changed later" : ""}: `, el("b", null, labelText(rev.label)), ". Press the other button to change it.");
      b.append(txt);
      if (rev.offset != null) {                          // opened from "My votes": walk through this user's answers
        const step = (text, ic, off, ok) => {
          const x = el("button", "ghost"); x.type = "button"; x.disabled = !ok;
          if (ic === "i-prev") x.append(icon(ic), text); else x.append(text, icon(ic));
          x.addEventListener("click", () => openReview(rev.split, off, rev.filter));
          return x;
        };
        const nav = el("span", "revnav");
        nav.append(step("Older", "i-prev", rev.offset + 1, rev.offset + 1 < rev.total), step("Newer", "i-next", rev.offset - 1, rev.offset > 0));
        b.append(nav);
      }
    } else {
      b.hidden = true;
    }
    $("btn-yes").classList.toggle("selected", !!rev && rev.label === "findable");
    $("btn-no").classList.toggle("selected", !!rev && rev.label === "not_findable");
    $("btn-skip").hidden = !!rev;
    $("btn-exit").hidden = !rev;
    $("toolbar").hidden = !progress[tab];

    showView("vote"); $("votebar").hidden = false; hide("loading"); hide("empty"); hide("error");
    renderCounts(); refreshButtons();
    shownAt = performance.now();
    window.scrollTo(0, 0);
  }

  // ── voting ───────────────────────────────────────────────────────────────────────────────────────
  async function onLabel(label) {
    if (busy) return;
    if (review) return changeVote(label);
    if (!isSplit(tab)) return;
    const L = live[tab]; const q = L.cur;
    if (!q) return;
    if (q.full) { toast(`This query already has its ${MAX_VOTES} votes. You can send a note instead.`); return; }
    busy = true; refreshButtons();
    try {
      const res = await rpc("cast_vote", { p_user: userId, p_qid: q.qid, p_label: label,
                                           p_seconds: Math.round((performance.now() - shownAt) / 100) / 10, p_name: userName || null });
      if (res.status === "ok") {
        flash(label);
        myCounts[tab] = (myCounts[tab] || 0) + 1;
        if (progress[tab]) { progress[tab].votes += 1; if (q.votes.n === 0) progress[tab].voted += 1; }
        renderCounts();
      } else if (res.status === "full") {
        toast("Someone else just cast the third vote on that one, so yours was not counted. Next.");
      } else if (res.status !== "already_voted") {
        throw new Error(`Vote rejected: ${res.status}`);
      }
      L.cur = null;
      pos[tab] = q.rank + 1;
    } catch (e) {
      busy = false; refreshButtons(); showError(e); return;
    }
    busy = false;
    await advance(tab);
  }

  async function changeVote(label) {
    const r = review;
    if (!r) return;
    if (r.vote.label === label) { toast("That is already your answer."); return; }
    busy = true; refreshButtons();
    try {
      const res = await rpc("change_vote", { p_user: userId, p_qid: r.vote.qid, p_label: label });
      if (res.status !== "ok" && res.status !== "unchanged") throw new Error(`Change rejected: ${res.status}`);
      const v = r.q.votes;
      if (res.status === "ok" && v && v.n) { if (label === "findable") { v.up += 1; v.down -= 1; } else { v.up -= 1; v.down += 1; } }
      r.vote.label = label; r.vote.updated_at = new Date().toISOString();
      toast(`Changed to ${labelText(label).toLowerCase()}.`);
      renderQuery(r.q, { ...r.vote, split: r.split, offset: r.offset, total: r.total, filter: r.filter });
    } catch (e) {
      showError(e);
    } finally {
      busy = false; refreshButtons();
    }
  }

  async function skip() {
    if (busy || review || !isSplit(tab)) return;
    const L = live[tab]; const q = L.cur;
    if (!q) return;
    busy = true; refreshButtons();
    try { await rpc("skip_query", { p_user: userId, p_qid: q.qid }); L.cur = null; pos[tab] = q.rank + 1; }
    catch (e) { busy = false; refreshButtons(); showError(e); return; }
    busy = false;
    await advance(tab);
  }

  // ── notes to the admin (on any query) ────────────────────────────────────────────────────────────
  const dlgNote = $("dlg-note");
  function currentQuery() { return review ? review.q : (isSplit(tab) ? live[tab].cur : null); }
  const notesSent = new Set();                        // qids this browser sent a note about since the page was loaded
  let noteQ = null;                                   // the query the dialog is about
  function noteMsg(text, kind) {
    const m = $("note-msg"); m.className = `note-msg ${kind || ""}`; m.replaceChildren();
    if (kind === "ok") m.append(icon("i-check"));
    m.append(text || ""); m.hidden = !text;
  }
  function noteBusy(on) { $("btn-note-send").disabled = on; $("btn-note-cancel").disabled = on; $("inp-note").disabled = on; }
  function openNote() {
    const q = currentQuery();
    if (!q || dlgNote.open || busy) return;
    const v = q.votes || { n: 0, up: 0, down: 0 };
    $("note-ctx").textContent = `About ${q.qid} (hotel ${q.hotel_id}, position ${fmt(q.rank + 1)}). Votes so far: ${v.up} findable, ${v.down} not findable. Only the admin reads these.`
      + (notesSent.has(q.qid) ? " You already sent a note about this query; a new one is added to it." : "");
    if (!noteQ || noteQ.qid !== q.qid) $("inp-note").value = "";      // a draft that failed to send is kept for its query
    noteQ = q; noteBusy(false); noteMsg("");
    dlgNote.showModal();
  }
  async function sendNote() {
    const q = noteQ; const text = $("inp-note").value.trim();
    if (!q || $("btn-note-send").disabled) return;
    if (!text) { noteMsg("Write something first.", "problem"); $("inp-note").focus(); return; }
    noteBusy(true); noteMsg("Sending…");
    try {
      const res = await rpc("add_note", { p_user: userId, p_qid: q.qid, p_note: text, p_name: userName || null });
      if (res.status === "not_full") throw new Error("the server still only accepts notes on queries with three votes. Please tell the organiser.");
      if (res.status !== "ok") throw new Error(`the server refused it (${res.status}).`);
      notesSent.add(q.qid); $("inp-note").value = ""; refreshButtons();
      if (dlgNote.open) { noteMsg("Sent to the admin. Thank you.", "ok"); setTimeout(() => { if (dlgNote.open && noteQ === q) dlgNote.close(); }, 1600); }
      else toast("Note sent to the admin. Thank you.");
    } catch (e) {
      noteBusy(false);
      if (e instanceof PassError) { dlgNote.close(); showError(e); return; }
      const why = String(e && e.message ? e.message : e).replace(/^\w/, (c) => c.toLowerCase());
      const end = /[.!?]$/.test(why) ? "" : ".";
      if (dlgNote.open) noteMsg(`Not sent: ${why}${end} Your text is still here; try again.`, "problem");
      else toast(`The note was not sent: ${why}`, 9000);
    }
  }
  dlgNote.querySelector("form").addEventListener("submit", (ev) => {
    if (ev.submitter && ev.submitter.value === "send") { ev.preventDefault(); sendNote(); }
  });
  $("inp-note").addEventListener("keydown", (ev) => { if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); sendNote(); } });

  // ── reviewing earlier votes ──────────────────────────────────────────────────────────────────────
  async function openReview(split, offset, filter = "all") {
    if (busy) return;
    busy = true; refreshButtons(); hide("error"); $("loading").hidden = false;
    try {
      const res = await rpc("my_votes", { p_user: userId, p_split: split, p_limit: 1, p_offset: offset, p_filter: filter });
      if (res.error) throw new Error(`my_votes: ${res.error}`);
      if (filter === "all") myCounts[split] = res.total;
      if (!res.votes.length) {
        hide("loading"); toast("You have no votes here yet.");
        if (tab === "mine") renderMine(); else if (review) exitReview();
        return;
      }
      const v = res.votes[0];
      const hotel = await fetchHotel(v.hotel_id);
      const tally = { ...(v.votes || { n: 1, up: 0, down: 0 }), voters: [] };
      const q = { qid: v.qid, hotel_id: v.hotel_id, idx: v.idx, kind: v.kind, rank: v.queue_rank, full: tally.n >= MAX_VOTES,
                  votes: tally, cell: v.cell, hotel };
      review = { split, offset, total: res.total, vote: v, q, filter };
      tab = split; store.set("tab", tab); renderTabs();
      renderQuery(q, { ...v, split, offset, total: res.total, filter });
    } catch (e) {
      showError(e);
    } finally {
      busy = false; refreshButtons();
    }
  }
  function exitReview() {
    review = null;
    const L = live[tab];
    if (L && L.cur) renderQuery(L.cur, null); else advance(tab);
  }

  // ── "My votes" tab ───────────────────────────────────────────────────────────────────────────────
  async function renderMine() {
    showView("mine"); $("votebar").hidden = true; $("toolbar").hidden = true; hide("empty"); hide("error"); $("loading").hidden = false;
    for (const b of $("mine-seg").querySelectorAll("button")) b.classList.toggle("active", b.dataset.split === mine.split);
    for (const b of $("mine-filter").querySelectorAll("button")) b.classList.toggle("active", b.dataset.filter === mine.filter);
    try {
      const res = await rpc("my_votes", { p_user: userId, p_split: mine.split, p_limit: PAGE, p_offset: mine.page * PAGE, p_filter: mine.filter });
      if (res.error) throw new Error(`my_votes: ${res.error}`);
      if (mine.filter === "all") myCounts[mine.split] = res.total;
      renderCounts();
      const other = mine.split === "test_non_object" ? "test_object" : "test_non_object";
      if (myCounts[other] == null) rpc("my_votes", { p_user: userId, p_split: other, p_limit: 1, p_offset: 0, p_filter: "all" }).then((r) => { myCounts[other] = r.total; renderCounts(); }).catch(() => {});
      const grid = $("mine-grid"); if (lazyLoader) lazyLoader.disconnect(); grid.replaceChildren();
      res.votes.forEach((v, i) => {
        const item = el("figure", "item"); item.tabIndex = 0; item.setAttribute("role", "button");
        const fr = framedCell(v.cell, 4 / 3, i >= 12);
        const badge = el("span", `badge ${v.label === "findable" ? "yes" : "no"}`);
        badge.title = labelText(v.label); badge.append(icon(v.label === "findable" ? "i-up" : "i-down"));
        fr.append(badge);
        const cap = el("figcaption");
        const tv = v.votes || {};
        const l1 = el("div", "tnum"); l1.append(el("b", null, `#${fmt(v.queue_rank + 1)}`), ` · hotel ${v.hotel_id}`);
        const l3 = el("div", "tnum", imageId(v.cell.src)); l3.title = v.cell.src;
        cap.append(l1, el("div", null, `${v.kind} · ${tv.up ?? "?"} findable, ${tv.down ?? "?"} not${v.updated_at ? " · changed" : ""}`), l3);
        item.append(fr, cap);
        const open = () => openReview(mine.split, mine.page * PAGE + i, mine.filter);
        item.addEventListener("click", open);
        item.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); open(); } });
        grid.append(item);
      });
      const pages = Math.max(1, Math.ceil(res.total / PAGE));
      if (mine.page >= pages && mine.page > 0) { mine.page = pages - 1; return renderMine(); }
      const noun = { all: "votes", findable: "findable votes", not_findable: "not-findable votes", disagree: "disagreements" }[mine.filter];
      $("mine-page").textContent = res.total
        ? `${fmt(mine.page * PAGE + 1)}–${fmt(Math.min((mine.page + 1) * PAGE, res.total))} of ${fmt(res.total)} ${noun}` : `no ${noun} in this category yet`;
      $("mine-newer").disabled = mine.page === 0;
      $("mine-older").disabled = mine.page + 1 >= pages;
    } catch (e) {
      showError(e);
    } finally {
      hide("loading");
    }
  }

  // ── tabs / views ─────────────────────────────────────────────────────────────────────────────────
  function showTab(t) {
    tab = t; store.set("tab", t); renderTabs(); review = null;
    if (t === "mine") { renderMine(); return; }
    const L = live[t];
    if (L.cur) renderQuery(L.cur, null); else advance(t);
  }
  function renderTabs() {
    for (const e of document.querySelectorAll(".tab")) { const on = e.dataset.tab === tab; e.classList.toggle("active", on); e.setAttribute("aria-selected", on ? "true" : "false"); }
  }
  function showView(name) { $("view-vote").hidden = name !== "vote"; $("view-mine").hidden = name !== "mine"; }
  function showEmpty() { $("view-vote").hidden = true; $("votebar").hidden = true; $("toolbar").hidden = false; hide("loading"); $("empty").hidden = false; }

  // ── ui helpers ───────────────────────────────────────────────────────────────────────────────────
  const hide = (id) => { $(id).hidden = true; };
  function refreshButtons() {
    const q = isSplit(tab) ? live[tab].cur : null;
    const can = !busy && (!!review || !!q);
    const full = !review && q && q.full;
    const shown = review ? review.q : q;
    $("btn-yes").disabled = !can || full; $("btn-no").disabled = !can || full;
    $("btn-skip").disabled = !can || !!review;
    $("btn-note").disabled = !can;
    const noted = !!shown && notesSent.has(shown.qid);
    $("btn-note").classList.toggle("sent", noted);
    $("note-icon").setAttribute("href", noted ? "#i-check" : "#i-note");
    $("btn-note").title = noted ? "You sent the admin a note about this query; click to send another" : "Send the admin a remark about this query";
    const p = isSplit(tab) ? progress[tab] : null;
    $("btn-prev-pos").disabled = busy || !shown || shown.rank <= 0;
    $("btn-next-pos").disabled = busy || !shown || !p || shown.rank + 1 >= p.queries;
    $("btn-first-open").disabled = busy || !isSplit(tab);
    $("btn-exit").disabled = busy;
    $("chk-skip-voted").checked = skipVoted;
  }
  function renderCounts() {
    let total = 0;
    for (const s of Object.keys(SPLITS)) {
      const n = myCounts[s] || 0; total += n;
      $(`cnt-${s}`).textContent = n ? fmt(n) : "";
      $(`mcnt-${s}`).textContent = fmt(n);
    }
    $("cnt-mine").textContent = total ? fmt(total) : "";
    $("mine-title").textContent = total ? `You have voted on ${fmt(total)} quer${total === 1 ? "y" : "ies"}` : "Your votes";
    if (isSplit(tab) && progress[tab]) {
      const p = progress[tab]; const q = currentQuery();
      $("status-pos").replaceChildren(q ? `Position ${fmt(q.rank + 1)} of ${fmt(p.queries)}` : `${fmt(p.queries)} ${SPLITS[tab].label}`, el("span", "hint", ", hardest first"));
      $("status-progress").textContent = `${fmt(p.voted)} have a vote · ${fmt(p.votes)} votes · you ${fmt(myCounts[tab] || 0)}`;
      $("inp-pos").max = String(p.queries);
    }
  }
  function renderName() { $("name-label").textContent = userName || "Set your name"; }
  function showError(e) {
    hide("loading");
    if (e instanceof PassError) { openPass(e.message); return; }
    $("error-msg").textContent = e && e.message ? e.message : String(e);
    $("error").hidden = false;
    console.error(e);
  }
  let toastTimer = 0;
  function toast(msg, ms = 3000) {
    const t = $("toast"); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, ms);
  }
  function flash(label) {
    const qc = $("q-cell");
    qc.classList.remove("flash-yes", "flash-no"); void qc.offsetWidth;
    qc.classList.add(label === "findable" ? "flash-yes" : "flash-no");
  }
  function lightbox(cell) {
    const wrap = $("lightbox-cell"); wrap.replaceChildren();
    const box = cellEl(cell); const ar = cell.w / cell.h;
    box.style.width = `${Math.round(Math.min(window.innerWidth * 0.94, window.innerHeight * 0.92 * ar))}px`;
    wrap.append(box); $("lightbox").hidden = false;
  }
  $("lightbox").addEventListener("click", () => { $("lightbox").hidden = true; });

  // ── passcode dialog ──────────────────────────────────────────────────────────────────────────────
  const dlgPass = $("dlg-pass");
  function openPass(msg) {
    if (dlgPass.open) return;
    $("pass-msg").textContent = msg || "";
    $("inp-pass").value = "";
    dlgPass.showModal();
    $("inp-pass").focus();
  }
  dlgPass.addEventListener("close", () => {
    const v = $("inp-pass").value.trim();
    if (!v) { openPass("The passcode is required to vote."); return; }
    passcode = v; store.set("pass", v);
    hide("error");
    if (!store.get("seen_help")) openHelp();
    if (tab === "mine") renderMine();
    else if (review) { const r = review; review = null; if (r.offset == null) jumpTo(r.split, r.q.rank); else openReview(r.split, r.offset, r.filter); }
    else { for (const s of Object.keys(SPLITS)) live[s] = { cur: null, next: null }; advance(tab); }
  });
  dlgPass.addEventListener("cancel", (ev) => ev.preventDefault());   // Esc does not dismiss it

  // ── help / name / annotator code dialog ──────────────────────────────────────────────────────────
  const dlg = $("dlg-help");
  function openHelp() { $("inp-name").value = userName; $("my-code").textContent = userId; $("inp-code").value = ""; dlg.showModal(); dlg.scrollTop = 0; }
  dlg.addEventListener("close", () => {
    const newName = $("inp-name").value.trim().slice(0, 40);
    const renamed = newName !== userName;
    userName = newName;
    store.set("user_name", userName); store.set("seen_help", "1"); renderName();
    if (renamed && passcode) {                            // earlier anonymous (or differently named) votes get the new name too
      rpc("set_name", { p_user: userId, p_name: userName || null })
        .then((r) => { if (r.status === "ok" && r.votes) toast(`Name applied to your ${fmt(r.votes)} earlier vote${r.votes === 1 ? "" : "s"}.`); })
        .catch(() => {});
    }
    const code = $("inp-code").value.trim().toLowerCase();
    if (code && UUID_RE.test(code) && code !== userId) {
      userId = code; store.set("user_id", code);
      toast("Continuing with the pasted annotator code.");
      for (const s of Object.keys(SPLITS)) live[s] = { cur: null, next: null };
      review = null; myCounts = {}; progress = {}; mine.page = 0; renderCounts();
      showTab(tab);
    } else if (code && !UUID_RE.test(code)) {
      toast("That does not look like an annotator code, so it was ignored.");
    }
  });
  $("btn-help").addEventListener("click", openHelp);
  $("btn-name").addEventListener("click", openHelp);
  $("btn-copy").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(userId); toast("Copied."); } catch { toast("Select and copy the code manually."); }
  });

  // ── wiring ───────────────────────────────────────────────────────────────────────────────────────
  for (const e of document.querySelectorAll(".tab")) e.addEventListener("click", () => { if (!busy) showTab(e.dataset.tab); });
  for (const b of $("mine-seg").querySelectorAll("button")) b.addEventListener("click", () => {
    mine.split = b.dataset.split; mine.page = 0; store.set("mine_split", mine.split); renderMine();
  });
  for (const b of $("mine-filter").querySelectorAll("button")) b.addEventListener("click", () => {
    mine.filter = b.dataset.filter; mine.page = 0; store.set("mine_filter", mine.filter); renderMine();
  });
  $("mine-newer").addEventListener("click", () => { if (mine.page > 0) { mine.page -= 1; renderMine(); } });
  $("mine-older").addEventListener("click", () => { mine.page += 1; renderMine(); });
  $("btn-yes").addEventListener("click", () => onLabel("findable"));
  $("btn-no").addEventListener("click", () => onLabel("not_findable"));
  $("btn-skip").addEventListener("click", skip);
  $("btn-note").addEventListener("click", openNote);
  function stepPos(d) {                                   // the arrows beside "Go to": exactly one position back / forward
    const q = currentQuery(); const p = isSplit(tab) ? progress[tab] : null;
    if (busy || !q || !p || q.rank + d < 0 || q.rank + d >= p.queries) return;
    jumpTo(tab, q.rank + d, true);
  }
  $("btn-prev-pos").addEventListener("click", () => stepPos(-1));
  $("btn-next-pos").addEventListener("click", () => stepPos(1));
  $("btn-first-open").addEventListener("click", firstOpen);
  $("btn-exit").addEventListener("click", () => { if (!busy && review) exitReview(); });
  $("btn-retry").addEventListener("click", () => {
    hide("error");
    if (tab === "mine") renderMine();
    else if (review) { const r = review; review = null; if (r.offset == null) jumpTo(r.split, r.q.rank); else openReview(r.split, r.offset, r.filter); }
    else { live[tab].next = null; if (live[tab].cur) renderQuery(live[tab].cur, null); else advance(tab); }
  });
  $("lightbox-close").addEventListener("click", (ev) => { ev.stopPropagation(); $("lightbox").hidden = true; });
  $("chk-skip-voted").addEventListener("change", (ev) => {
    if (busy) { ev.target.checked = skipVoted; return; }
    ev.target.blur();
    skipVoted = ev.target.checked; store.set("skip_voted", skipVoted ? "1" : "0");
    toast(skipVoted ? "Showing only queries without votes." : "Showing every query in order, including voted ones.");
    if (isSplit(tab) && !review) restart(tab);
  });
  $("jump-form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    if (busy || !isSplit(tab)) return;
    const p = progress[tab]; const n = parseInt($("inp-pos").value, 10);
    if (!p || !Number.isFinite(n)) { toast("Type a position number first."); return; }
    const clamped = Math.min(Math.max(n, 1), p.queries);
    $("inp-pos").value = ""; $("inp-pos").blur();
    jumpTo(tab, clamped - 1);
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.repeat || dlg.open || dlgNote.open || dlgPass.open || ["INPUT", "TEXTAREA"].includes(ev.target.tagName)) return;
    if (ev.key === "Escape") { $("lightbox").hidden = true; return; }
    if (!$("lightbox").hidden || !isSplit(tab)) return;
    const k = ev.key.toLowerCase();
    if (k === "1" || k === "f") onLabel("findable");
    else if (k === "2" || k === "j") onLabel("not_findable");
    else if (k === "s") skip();
    else if (k === "n") { ev.preventDefault(); openNote(); }
    else if (ev.key === "ArrowLeft") stepPos(-1);
    else if (ev.key === "ArrowRight") stepPos(1);
  });

  // gallery columns per row: the saved choice, else a default from the window width
  const galCols = () => { const n = parseInt(store.get("gal_cols"), 10); return n >= 1 && n <= 5 ? n : innerWidth > 1000 ? 4 : innerWidth > 600 ? 3 : 2; };
  function setCols(n, save) {
    $("g-grid").style.gridTemplateColumns = `repeat(${n}, minmax(0, 1fr))`;
    $("inp-cols").value = n; $("out-cols").textContent = n;
    if (save) store.set("gal_cols", String(n));
  }
  $("inp-cols").addEventListener("input", (ev) => setCols(+ev.target.value, true));
  $("inp-cols").addEventListener("pointerup", (ev) => ev.target.blur());

  // the real heights of the header, the vote bar and the query details: the sticky query column and its photo size use them
  function trackHeight(elem, name, target) {
    const set = () => target.style.setProperty(name, `${elem.offsetHeight}px`);
    set();
    if ("ResizeObserver" in window) new ResizeObserver(set).observe(elem);
  }
  trackHeight(document.querySelector(".bar"), "--head-h", document.documentElement);
  trackHeight($("votebar"), "--foot-h", document.documentElement);
  trackHeight(document.querySelector(".meta"), "--meta-h", document.querySelector(".query"));

  // ── go ───────────────────────────────────────────────────────────────────────────────────────────
  setCols(galCols(), false);
  renderName(); renderTabs(); renderCounts(); refreshButtons();
  if (!configured()) {
    showError(new Error(CONFIG_MSG));
    return;
  }
  if (!passcode) { openPass("Enter the passcode you were given for this study."); return; }
  if (!store.get("seen_help")) openHelp();
  showTab(tab);
})();
