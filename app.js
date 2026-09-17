// Findability voting page.  Plain browser JS, no build step, no dependencies.
// Talks to Supabase through six RPC functions (../supabase/schema.sql) and fetches the per-hotel JSON + WebP
// thumbnails produced by ../build_study.py from DATA_BASE_URL.  A "cell" is {src, w, h}: thumbnail path and size.
(() => {
  const C = window.STUDY_CONFIG;
  const $ = (id) => document.getElementById(id);
  const debug = new URLSearchParams(location.search).has("debug");   // ?debug=1 shows qid, hotel id, similarities
  const SPLITS = {
    test_non_object: { label: "room photos" },
    test_object: { label: "object crops" },
  };
  const isSplit = (s) => Object.prototype.hasOwnProperty.call(SPLITS, s);
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const PAGE = 60;                                   // items per page in "My votes"
  const MAX_VOTES = 3;
  const labelText = (l) => (l === "findable" ? "👍 Findable" : "👎 Not findable");

  // ── identity: a random code kept in this browser ─────────────────────────────────────────────────
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode etc. */ } },
  };
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
    : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => { const r = Math.random() * 16 | 0; return (c === "x" ? r : (r & 3 | 8)).toString(16); }));
  let userId = store.get("fs_user_id");
  if (!userId || !UUID_RE.test(userId)) { userId = uuid(); store.set("fs_user_id", userId); }
  let userName = store.get("fs_user_name") || "";
  let passcode = store.get("fs_pass") || "";          // shared passcode, typed once, checked by every server function

  // ── server ───────────────────────────────────────────────────────────────────────────────────────
  class PassError extends Error {}
  async function rpc(fn, args) {
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
      passcode = ""; store.set("fs_pass", "");
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
  const preloaded = new Set();
  function preload(paths) {
    for (const p of paths) if (!preloaded.has(p)) { preloaded.add(p); const im = new Image(); im.src = dataUrl(p); }
  }

  // ── cells ────────────────────────────────────────────────────────────────────────────────────────
  function cellEl(cell) {
    const box = document.createElement("div");
    box.className = "cell";
    box.style.aspectRatio = `${cell.w} / ${cell.h}`;
    const im = document.createElement("img");
    im.src = dataUrl(cell.src); im.width = cell.w; im.height = cell.h; im.alt = ""; im.decoding = "async"; im.draggable = false;
    box.append(im);
    return box;
  }
  function framedCell(cell, frameAr) {                // letterbox a cell into a fixed-ratio frame
    const frame = document.createElement("div");
    frame.className = "frame";
    frame.style.aspectRatio = `${frameAr}`;
    const box = cellEl(cell);
    const ar = cell.w / cell.h;
    box.style.width = ar >= frameAr ? "100%" : `${(100 * ar / frameAr).toFixed(3)}%`;
    frame.append(box);
    return frame;
  }

  // ── state ────────────────────────────────────────────────────────────────────────────────────────
  let tab = store.get("fs_tab");
  if (!isSplit(tab) && tab !== "mine") tab = "test_non_object";
  const live = { test_non_object: { cur: null, next: null }, test_object: { cur: null, next: null } };
  const pos = {};                                     // split -> queue position to continue from
  for (const s of Object.keys(SPLITS)) pos[s] = Math.max(0, parseInt(store.get(`fs_pos_${s}`) || "0", 10) || 0);
  let skipVoted = store.get("fs_skip_voted") === "1";
  let review = null;                                  // { split, offset, total, vote, q }
  const mine = { split: isSplit(store.get("fs_mine_split")) ? store.get("fs_mine_split") : "test_non_object", page: 0 };
  let progress = {};                                  // split -> {queries, voted, votes}
  let myCounts = {};                                  // split -> my number of votes
  let busy = false;
  let shownAt = 0;

  // ── queue ────────────────────────────────────────────────────────────────────────────────────────
  async function pull(split, fromRank, exclude) {
    const res = await rpc("next_query", { p_user: userId, p_split: split, p_from_rank: fromRank, p_skip_voted: skipVoted, p_exclude: exclude || null });
    if (res.error) throw new Error(`next_query: ${res.error}`);
    progress[split] = res.progress;
    if (res.mine) myCounts = { ...myCounts, ...res.mine };
    renderCounts();
    if (!res.qid) return null;
    const hotel = await fetchHotel(res.hotel_id);
    preload([res.cell.src, ...hotel.gallery.map((g) => g.src)]);
    return { qid: res.qid, hotel_id: res.hotel_id, idx: res.idx, kind: res.kind, rank: res.queue_rank, full: !!res.full,
             votes: res.votes || { n: 0, up: 0, down: 0, voters: [] }, wrapped: !!res.wrapped, cell: res.cell, hotel };
  }

  async function advance(split) {
    const L = live[split];
    busy = true; refreshButtons(); hide("error");
    if (tab === split) $("loading").hidden = false;
    try {
      let q = null;
      if (L.next) { q = await L.next.catch(() => null); L.next = null; }
      if (!q) q = await pull(split, pos[split], null);
      L.cur = q;
      if (q) {
        pos[split] = q.rank; store.set(`fs_pos_${split}`, String(q.rank));
        L.next = pull(split, q.rank + 1, q.qid);        // prefetch the following one
        L.next.catch(() => {});
      }
      if (tab === split && !review) {
        if (q) { renderQuery(q, null); if (q.wrapped) toast("Reached the end of the list, continuing from the start."); }
        else showEmpty();
      }
    } catch (e) {
      if (tab === split) showError(e);
    } finally {
      busy = false; refreshButtons();
    }
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
      t.textContent = "No votes yet: you are the first.";
    } else {
      const strong = document.createElement("b");
      strong.textContent = `Votes so far: 👍 ${v.up} · 👎 ${v.down}`;
      t.append(strong);
      if (v.voters && v.voters.length) {
        const names = document.createElement("span"); names.className = "names";
        names.textContent = "  (" + v.voters.map((x) => `${x.label === "findable" ? "👍" : "👎"} ${x.name || "anonymous"}`).join(", ") + ")";
        t.append(names);
      }
      if (q.full) t.append(rev
        ? ` · This query has its ${MAX_VOTES} votes. You can still change your own answer, or send a note to the admin.`
        : ` · This query already has its ${MAX_VOTES} votes, so a fourth cannot be added. If you disagree, send a note to the admin.`);
    }
    t.hidden = false;
  }

  function renderQuery(q, rev) {
    const info = q.hotel.queries[q.qid];
    const isObj = info ? info.is_object : q.qid.startsWith("test_object");
    $("q-kind").textContent = isObj ? `crop of a ${q.kind}` : `${q.kind} photo`;
    $("q-meta").textContent = debug ? `${q.qid} · hotel ${q.hotel_id}${info ? ` · best sim ${info.best_sim}` : ""} · rank ${q.rank}` : "";

    const qc = $("q-cell"); qc.replaceChildren();
    const box = cellEl(q.cell); box.classList.add("qbox");
    const ar = q.cell.w / q.cell.h;
    if (ar < 1) box.style.width = `${Math.round(ar * 90)}%`;              // keep portrait queries from getting too tall
    box.addEventListener("click", () => lightbox(q.cell));
    qc.append(box);

    const gal = q.hotel.gallery;
    const sims = info ? info.sims : null;
    const order = gal.map((_, i) => i);
    if (sims) order.sort((a, b) => sims[b] - sims[a]);                     // most similar first (scores stay hidden)
    $("g-meta").textContent = `${gal.length} photo${gal.length === 1 ? "" : "s"}`;
    const grid = $("g-grid"); grid.replaceChildren();
    for (const i of order) {
      const g = gal[i];
      const card = document.createElement("figure"); card.className = "card";
      const fr = framedCell(g, 4 / 3);
      fr.addEventListener("click", () => lightbox(g));
      const cap = document.createElement("figcaption");
      cap.textContent = (g.view || "—") + (debug ? ` · room ${g.room} · sim ${sims ? sims[i] : "?"}` : "");
      card.append(fr, cap); grid.append(card);
    }

    renderTally(q, rev);
    const b = $("review-banner");
    if (rev) {
      b.hidden = false;
      b.replaceChildren();
      const when = new Date(rev.created_at).toLocaleString();
      b.append(`Reviewing your answer ${rev.total - rev.offset} of ${rev.total} for ${SPLITS[rev.split].label} (cast ${when}${rev.updated_at ? ", changed later" : ""}): `);
      const strong = document.createElement("b"); strong.textContent = labelText(rev.label); b.append(strong);
      b.append(". Click the other button to change it.");
    } else {
      b.hidden = true;
    }
    $("btn-yes").classList.toggle("selected", !!rev && rev.label === "findable");
    $("btn-no").classList.toggle("selected", !!rev && rev.label === "not_findable");
    $("btn-skip").hidden = !!rev;
    $("btn-fwd").hidden = !rev;
    $("btn-back").textContent = rev ? "← Older" : "← Previous";
    $("btn-fwd").textContent = rev && rev.offset > 0 ? "Newer →" : "Back to voting ↩";
    $("controls").hidden = !!rev;

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
        toast("Someone else just cast the third vote on that one, so yours was not counted. Next!");
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
      toast(`Changed to ${labelText(label)}.`);
      renderQuery(r.q, { ...r.vote, split: r.split, offset: r.offset, total: r.total });
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

  // ── notes to the admin ───────────────────────────────────────────────────────────────────────────
  const dlgNote = $("dlg-note");
  function currentQuery() { return review ? review.q : (isSplit(tab) ? live[tab].cur : null); }
  function openNote() {
    const q = currentQuery();
    if (!q || dlgNote.open || busy) return;
    if (!q.full) { toast(`Notes can only be sent for queries that already have their ${MAX_VOTES} votes.`); return; }
    const v = q.votes || { n: 0, up: 0, down: 0 };
    $("note-ctx").textContent = `About this ${q.kind} query (position ${q.rank + 1}, hotel ${q.hotel_id}). Votes so far: 👍 ${v.up} · 👎 ${v.down}. The admin reads these; other annotators do not see them.`;
    $("inp-note").value = "";
    dlgNote.showModal();
  }
  dlgNote.addEventListener("close", async () => {
    const q = currentQuery();
    const text = $("inp-note").value.trim();
    if (dlgNote.returnValue !== "send" || !q) return;
    if (!text) { toast("Empty note, nothing sent."); return; }
    try {
      const res = await rpc("add_note", { p_user: userId, p_qid: q.qid, p_note: text, p_name: userName || null });
      if (res.status === "not_full") { toast("This query does not have its three votes yet, so no note was stored."); return; }
      if (res.status !== "ok") throw new Error(`Note rejected: ${res.status}`);
      toast("Note sent to the admin. Thank you!");
    } catch (e) { showError(e); }
  });

  // ── reviewing earlier votes ──────────────────────────────────────────────────────────────────────
  async function openReview(split, offset) {
    if (busy) return;
    busy = true; refreshButtons(); hide("error"); $("loading").hidden = false;
    try {
      const res = await rpc("my_votes", { p_user: userId, p_split: split, p_limit: 1, p_offset: offset });
      myCounts[split] = res.total;
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
      review = { split, offset, total: res.total, vote: v, q };
      tab = split; store.set("fs_tab", tab); renderTabs();
      renderQuery(q, { ...v, split, offset, total: res.total });
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
    showView("mine"); $("votebar").hidden = true; hide("empty"); hide("error"); $("loading").hidden = false;
    for (const b of $("mine-seg").querySelectorAll("button")) b.classList.toggle("active", b.dataset.split === mine.split);
    try {
      const res = await rpc("my_votes", { p_user: userId, p_split: mine.split, p_limit: PAGE, p_offset: mine.page * PAGE });
      myCounts[mine.split] = res.total; renderCounts();
      const grid = $("mine-grid"); grid.replaceChildren();
      res.votes.forEach((v, i) => {
        const item = document.createElement("figure"); item.className = "item";
        const fr = framedCell(v.cell, 4 / 3);
        const badge = document.createElement("span");
        badge.className = `badge ${v.label === "findable" ? "yes" : "no"}`; badge.textContent = v.label === "findable" ? "👍" : "👎";
        fr.append(badge);
        const cap = document.createElement("figcaption");
        const tv = v.votes || {};
        cap.textContent = `${v.kind} · all: 👍${tv.up ?? "?"} 👎${tv.down ?? "?"}${v.updated_at ? " · changed" : ""}`;
        item.append(fr, cap);
        item.addEventListener("click", () => openReview(mine.split, mine.page * PAGE + i));
        grid.append(item);
      });
      preload(res.votes.map((v) => v.cell.src));
      const pages = Math.max(1, Math.ceil(res.total / PAGE));
      if (mine.page >= pages && mine.page > 0) { mine.page = pages - 1; return renderMine(); }
      $("mine-page").textContent = res.total
        ? `${mine.page * PAGE + 1}–${Math.min((mine.page + 1) * PAGE, res.total)} of ${res.total}` : "no votes yet in this category";
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
    tab = t; store.set("fs_tab", t); renderTabs(); review = null;
    if (t === "mine") { renderMine(); return; }
    const L = live[t];
    if (L.cur) renderQuery(L.cur, null); else advance(t);
  }
  function renderTabs() { for (const el of document.querySelectorAll(".tab")) el.classList.toggle("active", el.dataset.tab === tab); }
  function showView(name) { $("view-vote").hidden = name !== "vote"; $("view-mine").hidden = name !== "mine"; }
  function showEmpty() { $("view-vote").hidden = true; $("votebar").hidden = true; hide("loading"); $("empty").hidden = false; }

  // ── small ui helpers ─────────────────────────────────────────────────────────────────────────────
  const hide = (id) => { $(id).hidden = true; };
  function refreshButtons() {
    const q = isSplit(tab) ? live[tab].cur : null;
    const can = !busy && (!!review || !!q);
    const full = !review && q && q.full;
    const shown = review ? review.q : q;
    $("btn-yes").disabled = !can || full; $("btn-no").disabled = !can || full;
    $("btn-skip").disabled = !can || !!review;
    $("btn-note").hidden = !(shown && shown.full);       // notes only for queries that already have their 3 votes
    $("btn-note").disabled = !can;
    $("btn-back").disabled = busy || (review ? review.offset + 1 >= review.total : !(isSplit(tab) && myCounts[tab] > 0));
    $("btn-fwd").disabled = busy;
    $("chk-skip-voted").checked = skipVoted;
  }
  function renderCounts() {
    let total = 0;
    for (const s of Object.keys(SPLITS)) {
      const n = myCounts[s] || 0; total += n;
      $(`cnt-${s}`).textContent = n ? n.toLocaleString() : "";
      $(`mcnt-${s}`).textContent = `(${n.toLocaleString()})`;
    }
    $("cnt-mine").textContent = total ? total.toLocaleString() : "";
    $("mine-title").textContent = total ? `You have voted on ${total.toLocaleString()} quer${total === 1 ? "y" : "ies"}` : "Your votes";
    if (isSplit(tab) && progress[tab]) {
      const p = progress[tab]; const q = live[tab].cur;
      $("status").textContent = `${SPLITS[tab].label}: ` + (q ? `position ${(q.rank + 1).toLocaleString()} of ${p.queries.toLocaleString()} (hardest first) · ` : "") +
        `${p.voted.toLocaleString()} of ${p.queries.toLocaleString()} have a vote · ${p.votes.toLocaleString()} votes in total · you have voted on ${(myCounts[tab] || 0).toLocaleString()} here`;
      $("inp-pos").max = String(p.queries);
    }
  }
  function renderName() { $("btn-name").textContent = userName ? `👤 ${userName}` : "👤 set your name"; }
  function showError(e) {
    hide("loading");
    if (e instanceof PassError) { openPass(e.message); return; }
    $("error-msg").textContent = e && e.message ? e.message : String(e);
    $("error").hidden = false;
    console.error(e);
  }
  let toastTimer = 0;
  function toast(msg) {
    const t = $("toast"); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 3000);
  }
  function flash(label) {
    const el = $("q-cell").firstElementChild; if (!el) return;
    const cls = label === "findable" ? "flash-yes" : "flash-no";
    el.classList.remove("flash-yes", "flash-no"); void el.offsetWidth; el.classList.add(cls);
  }
  function lightbox(cell) {
    const wrap = $("lightbox-cell"); wrap.replaceChildren();
    const box = cellEl(cell); const ar = cell.w / cell.h;
    box.style.width = `${Math.round(Math.min(window.innerWidth * 0.96, window.innerHeight * 0.94 * ar))}px`;
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
    passcode = v; store.set("fs_pass", v);
    hide("error");
    if (!store.get("fs_seen_help")) openHelp();
    if (tab === "mine") renderMine();
    else if (review) { const r = review; review = null; openReview(r.split, r.offset); }
    else { for (const s of Object.keys(SPLITS)) live[s] = { cur: null, next: null }; advance(tab); }
  });
  dlgPass.addEventListener("cancel", (ev) => ev.preventDefault());   // Esc does not dismiss it

  // ── help / name / annotator code dialog ──────────────────────────────────────────────────────────
  const dlg = $("dlg-help");
  function openHelp() { $("inp-name").value = userName; $("my-code").textContent = userId; $("inp-code").value = ""; dlg.showModal(); }
  dlg.addEventListener("close", () => {
    userName = $("inp-name").value.trim().slice(0, 40);
    store.set("fs_user_name", userName); store.set("fs_seen_help", "1"); renderName();
    const code = $("inp-code").value.trim().toLowerCase();
    if (code && UUID_RE.test(code) && code !== userId) {
      userId = code; store.set("fs_user_id", code);
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
  for (const el of document.querySelectorAll(".tab")) el.addEventListener("click", () => { if (!busy) showTab(el.dataset.tab); });
  for (const b of $("mine-seg").querySelectorAll("button")) b.addEventListener("click", () => {
    mine.split = b.dataset.split; mine.page = 0; store.set("fs_mine_split", mine.split); renderMine();
  });
  $("mine-newer").addEventListener("click", () => { if (mine.page > 0) { mine.page -= 1; renderMine(); } });
  $("mine-older").addEventListener("click", () => { mine.page += 1; renderMine(); });
  $("btn-yes").addEventListener("click", () => onLabel("findable"));
  $("btn-no").addEventListener("click", () => onLabel("not_findable"));
  $("btn-skip").addEventListener("click", skip);
  $("btn-note").addEventListener("click", openNote);
  $("btn-back").addEventListener("click", () => {
    if (busy) return;
    if (review) { if (review.offset + 1 < review.total) openReview(review.split, review.offset + 1); }
    else if (isSplit(tab)) openReview(tab, 0);
  });
  $("btn-fwd").addEventListener("click", () => {
    if (busy || !review) return;
    if (review.offset > 0) openReview(review.split, review.offset - 1); else exitReview();
  });
  $("btn-retry").addEventListener("click", () => {
    hide("error");
    if (tab === "mine") renderMine();
    else if (review) { const r = review; review = null; openReview(r.split, r.offset); }
    else { live[tab].next = null; if (live[tab].cur) renderQuery(live[tab].cur, null); else advance(tab); }
  });
  $("chk-skip-voted").addEventListener("change", (ev) => {
    if (busy) { ev.target.checked = skipVoted; return; }
    skipVoted = ev.target.checked; store.set("fs_skip_voted", skipVoted ? "1" : "0");
    if (isSplit(tab) && !review) restart(tab);
  });
  $("jump-form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    if (busy || !isSplit(tab) || review) return;
    const p = progress[tab]; const n = parseInt($("inp-pos").value, 10);
    if (!p || !Number.isFinite(n)) { toast("Type a position number first."); return; }
    const clamped = Math.min(Math.max(n, 1), p.queries);
    pos[tab] = clamped - 1; store.set(`fs_pos_${tab}`, String(pos[tab]));
    $("inp-pos").value = ""; $("inp-pos").blur();
    restart(tab);
  });
  document.addEventListener("keydown", (ev) => {
    if (dlg.open || dlgNote.open || dlgPass.open || ["INPUT", "TEXTAREA"].includes(ev.target.tagName)) return;
    if (ev.key === "Escape") { $("lightbox").hidden = true; return; }
    if (!$("lightbox").hidden || !isSplit(tab)) return;
    const k = ev.key.toLowerCase();
    if (k === "1" || k === "f") onLabel("findable");
    else if (k === "2" || k === "j") onLabel("not_findable");
    else if (k === "s") skip();
    else if (k === "n") openNote();
    else if (ev.key === "ArrowLeft") $("btn-back").click();
    else if (ev.key === "ArrowRight" && review) $("btn-fwd").click();
  });

  // ── go ───────────────────────────────────────────────────────────────────────────────────────────
  renderName(); renderTabs(); renderCounts(); refreshButtons();
  if (!C || !C.SUPABASE_URL || C.SUPABASE_URL.includes("YOUR-PROJECT")) {
    showError(new Error("config.js is not filled in yet (SUPABASE_URL / SUPABASE_ANON_KEY / DATA_BASE_URL)."));
    return;
  }
  if (!passcode) { openPass("Enter the passcode you were given for this study."); return; }
  if (!store.get("fs_seen_help")) openHelp();
  showTab(tab);
})();
