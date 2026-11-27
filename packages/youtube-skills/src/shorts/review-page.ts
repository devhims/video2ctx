/**
 * The review page: one HTML document with inline CSS and JS, no build step and no network beyond
 * this server. Client code avoids template literals so it can live inside this one.
 * Everything taken from project files is inserted as text, never as HTML.
 */
export function reviewPage(nonce: string): string {
  return String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Shorts review</title>
<style nonce="${nonce}">
:root {
  color-scheme: dark;
  --bg: #0e0f11; --panel: #17181b; --panel-2: #1f2125; --line: #2a2d33; --text: #e9eaec; --muted: #9a9fa8;
  --accent: #ff4d3d; --ok: #3ccf7a; --warn: #f3b33d; --bad: #ff6b6b; --radius: 10px;
  font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); }
button { font: inherit; color: var(--text); background: var(--panel-2); border: 1px solid var(--line); border-radius: 7px; padding: 5px 11px; cursor: pointer; }
button:hover { border-color: #444851; }
button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
button.small { padding: 2px 8px; font-size: 12px; }
button:focus-visible, input:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.top { position: sticky; top: 0; z-index: 5; display: flex; align-items: center; gap: 18px; padding: 10px 20px; background: rgba(14,15,17,.92); backdrop-filter: blur(8px); border-bottom: 1px solid var(--line); }
.brand { font-weight: 650; white-space: nowrap; }
.brand small { display: block; color: var(--muted); font-weight: 400; max-width: 340px; overflow: hidden; text-overflow: ellipsis; }
.tabs { display: flex; gap: 4px; }
.tabs a { color: var(--muted); text-decoration: none; padding: 6px 12px; border-radius: 7px; }
.tabs a.active { color: var(--text); background: var(--panel-2); }
.tabs a .count { color: var(--muted); font-size: 12px; margin-left: 4px; }
.live { margin-left: auto; color: var(--muted); font-size: 12px; display: flex; align-items: center; gap: 7px; white-space: nowrap; }
.live::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--ok); box-shadow: 0 0 0 3px rgba(60,207,122,.15); }
.live.off::before { background: var(--bad); box-shadow: none; }
main.view { padding: 20px; }
.empty { color: var(--muted); padding: 60px 20px; text-align: center; }
.moments { display: grid; grid-template-columns: repeat(auto-fill, minmax(330px, 1fr)); gap: 14px; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 14px; display: flex; flex-direction: column; gap: 9px; }
.card.selected { border-color: var(--ok); box-shadow: inset 0 0 0 1px var(--ok); }
.card header { display: flex; align-items: baseline; gap: 9px; }
.card h3 { margin: 0; font-size: 15px; flex: 1; }
.rank { color: var(--accent); font-weight: 700; font-variant-numeric: tabular-nums; }
.hook { margin: 0; font-size: 16px; font-weight: 600; }
.hook::before { content: "Hook  "; color: var(--muted); font-size: 11px; font-weight: 500; text-transform: uppercase; letter-spacing: .06em; }
.meta { color: var(--muted); font-size: 12px; }
blockquote { margin: 0; padding: 7px 10px; background: var(--panel-2); border-radius: 7px; color: #c9ccd1; display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; cursor: pointer; }
blockquote.open { -webkit-line-clamp: unset; }
blockquote time { color: var(--muted); font-size: 12px; margin-right: 6px; font-variant-numeric: tabular-nums; }
.sheet { width: 100%; border-radius: 6px; border: 1px solid var(--line); display: block; }
.card footer { margin-top: auto; display: flex; align-items: center; gap: 8px; }
.keep { display: flex; align-items: center; gap: 6px; cursor: pointer; font-weight: 600; }
.keep input { width: 16px; height: 16px; accent-color: var(--ok); }
.pill { font-size: 11px; padding: 1px 7px; border-radius: 99px; border: 1px solid var(--line); color: var(--muted); white-space: nowrap; }
.pill.approved { color: var(--ok); border-color: rgba(60,207,122,.4); }
.pill.changes { color: var(--warn); border-color: rgba(243,179,61,.4); }
.pill.rejected { color: var(--bad); border-color: rgba(255,107,107,.4); }
.group { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 14px; margin-bottom: 16px; }
.group > header { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
.group h3 { margin: 0; font-size: 15px; flex: 1; }
.variants { display: flex; gap: 14px; flex-wrap: wrap; }
.variant { width: 230px; display: flex; flex-direction: column; gap: 8px; padding: 8px; border-radius: 9px; border: 1px solid transparent; }
.variant.chosen { border-color: var(--accent); background: rgba(255,77,61,.06); }
.vlabel { font-weight: 650; }
.vlabel span { color: var(--muted); font-weight: 400; }
.frame { aspect-ratio: 9 / 16; background: #000; border-radius: 8px; overflow: hidden; display: grid; place-items: center; color: var(--muted); font-size: 12px; }
.frame video, .frame img { width: 100%; height: 100%; object-fit: contain; display: block; }
.variant .hook { font-size: 14px; min-height: 3em; }
.player { display: grid; grid-template-columns: 220px auto minmax(280px, 460px); gap: 24px; align-items: start; }
.list { display: flex; flex-direction: column; gap: 3px; position: sticky; top: 74px; }
.list button { text-align: left; background: transparent; border-color: transparent; display: flex; gap: 8px; align-items: center; }
.list button.active { background: var(--panel-2); border-color: var(--line); }
.list button .t { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.dot.approved { background: var(--ok); } .dot.changes { background: var(--warn); } .dot.rejected { background: var(--bad); }
.list .variant-of { padding-left: 22px; }
.stage { position: sticky; top: 74px; display: flex; flex-direction: column; gap: 10px; width: min(100%, calc((100vh - 250px) * 9 / 16)); min-width: 300px; }
.stage .frame { width: 100%; }
.sources, .statuses { display: flex; gap: 6px; flex-wrap: wrap; }
.sources button.active, .statuses button.active { background: var(--text); color: var(--bg); border-color: var(--text); }
.statuses button.active.approved { background: var(--ok); border-color: var(--ok); }
.statuses button.active.changes { background: var(--warn); border-color: var(--warn); }
.statuses button.active.rejected { background: var(--bad); border-color: var(--bad); }
form.comment { display: flex; gap: 6px; align-items: center; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 5px 5px 5px 9px; }
form.comment input { flex: 1; min-width: 0; background: transparent; border: 0; color: var(--text); font: inherit; outline: none; }
.at { font-variant-numeric: tabular-nums; color: var(--accent); font-weight: 650; font-size: 12px; }
.side h4 { margin: 0 0 8px; font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
.side h2 { margin: 0 0 4px; font-size: 17px; }
.side .hook { margin-bottom: 14px; }
ol.comments { list-style: none; padding: 0; margin: 0 0 20px; display: flex; flex-direction: column; gap: 6px; }
ol.comments li { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 7px 9px; display: flex; gap: 8px; align-items: baseline; }
ol.comments li.resolved { opacity: .55; }
ol.comments li.previous { border-style: dashed; opacity: .7; }
.error { display: flex; gap: 10px; align-items: center; color: var(--bad); font-size: 13px; background: rgba(255,107,107,.08); border: 1px solid rgba(255,107,107,.35); border-radius: 8px; padding: 6px 9px; }
.error[hidden] { display: none; }
#error { margin: 12px 20px 0; }
ol.comments li.resolved .text { text-decoration: line-through; }
ol.comments .text { flex: 1; white-space: pre-wrap; }
ol.comments .where { color: var(--muted); font-size: 11px; display: block; }
ol.comments button.at { background: none; border: 0; padding: 0; }
.stills { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
.stills a { display: block; }
.stills img { width: 100%; border-radius: 6px; border: 1px solid var(--line); display: block; }
.stills a.wide { grid-column: 1 / -1; }
.grow { flex: 1; }
.hint { color: var(--muted); font-size: 12px; }
kbd { font: 11px ui-monospace, monospace; border: 1px solid var(--line); border-radius: 4px; padding: 0 4px; }
@media (max-width: 1000px) { .player { grid-template-columns: 1fr; } .stage, .list { position: static; flex-direction: row; flex-wrap: wrap; } }
</style>
</head>
<body>
<div class="top">
  <div class="brand">Shorts review<small id="title"></small></div>
  <nav class="tabs">
    <a href="#moments" data-view="moments">Moments<span class="count" id="count-moments"></span></a>
    <a href="#hooks" data-view="hooks">Hooks<span class="count" id="count-hooks"></span></a>
    <a href="#player" data-view="player">Player<span class="count" id="count-player"></span></a>
  </nav>
  <div class="live" id="live">Watching project files</div>
</div>
<div class="error" id="error" hidden role="alert"></div>
<main class="view" id="view"></main>
<script nonce="${nonce}">
"use strict";
var state = null;
var view = "moments";
var current = null;
var chosenSource = {};
// The moment a comment was started: short, time, and the exact render (path and revision) on screen.
var pinned = null;
var videos = new Map();
var playerShell = null;
var PILL_LABELS = { approved: "Approved", changes: "Needs changes", rejected: "Rejected" };
var STATUS_LABELS = { pending: "Pending", approved: "Approve", changes: "Needs changes", rejected: "Reject" };

function el(tag, props) {
  var node = document.createElement(tag);
  props = props || {};
  Object.keys(props).forEach(function (key) {
    var value = props[key];
    if (value === undefined || value === null || value === false) return;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.slice(0, 2) === "on") node.addEventListener(key.slice(2), value);
    else if (key === "checked") node.checked = true;
    else node.setAttribute(key, value === true ? "" : value);
  });
  for (var i = 2; i < arguments.length; i++) append(node, arguments[i]);
  return node;
}
function append(node, child) {
  if (child === undefined || child === null || child === false) return;
  if (Array.isArray(child)) { child.forEach(function (c) { append(node, c); }); return; }
  node.append(child instanceof Node ? child : document.createTextNode(String(child)));
}
function clock(seconds) {
  if (seconds === undefined || seconds === null || isNaN(seconds)) return "";
  var m = Math.floor(seconds / 60);
  var s = seconds - m * 60;
  return m + ":" + (s < 10 ? "0" : "") + s.toFixed(1);
}
function wholeClock(seconds) {
  var m = Math.floor(seconds / 60), s = Math.floor(seconds % 60);
  return m + ":" + (s < 10 ? "0" : "") + s;
}
function byId(id) { return state.shorts.find(function (s) { return s.id === id; }); }
function rev(id) { return (state.review.shorts[id]) || { comments: [], current: "pending", statusStale: false }; }
function pill(status) { return status && status !== "pending" ? el("span", { class: "pill " + status, text: PILL_LABELS[status] }) : null; }
function bestVideo(short) { return short && short.videos[0]; }
function sourceFor(short) {
  var label = chosenSource[short.id];
  return short.videos.find(function (v) { return v.label === label; }) || bestVideo(short);
}
function video(src) {
  var node = videos.get(src);
  if (!node) {
    node = el("video", { src: src, preload: "metadata", playsinline: true, controls: true });
    node.addEventListener("timeupdate", function () {
      var limit = Number(node.dataset.limit || 0);
      if (limit && node.currentTime >= limit) { node.pause(); node.currentTime = 0; }
      if (node === activeVideo()) showTime();
    });
    videos.set(src, node);
  }
  return node;
}

// Saves one action. On failure, shows a retryable error in slot (the banner by default) and resolves false.
async function send(action, slot, retry) {
  slot = slot || document.getElementById("error");
  var message, saved = null;
  try {
    var response = await fetch("/api/review", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(action) });
    var body = await response.json().catch(function () { return {}; });
    if (response.ok) saved = body;
    else message = "Not saved: " + (body.error ? body.error.message : "the server answered " + response.status + ".");
  } catch (error) {
    message = "Not saved: the review server can't be reached. Ask the agent to start review again, then retry.";
  }
  if (saved) { slot.replaceChildren(); slot.hidden = true; apply(saved); return true; }
  slot.replaceChildren(el("span", { text: message }), el("button", { class: "small", type: "button", onclick: retry || function () { send(action, slot); } }, "Retry"));
  slot.hidden = false;
  return false;
}

function apply(next) {
  state = next;
  document.getElementById("title").textContent = state.title || state.videoId || "";
  var bases = state.shorts.filter(function (s) { return !s.variantOf; });
  var kept = bases.filter(function (s) { return rev(s.id).selected; }).length;
  document.getElementById("count-moments").textContent = bases.length ? kept + "/" + bases.length : "";
  var groups = bases.filter(function (s) { return s.variants.length; });
  var picked = groups.filter(function (s) { return rev(s.id).variant; }).length;
  document.getElementById("count-hooks").textContent = groups.length ? picked + "/" + groups.length : "";
  var rendered = state.shorts.filter(function (s) { return s.videos.length; }).length;
  document.getElementById("count-player").textContent = rendered ? String(rendered) : "";
  render();
}

function route() {
  var hash = location.hash.slice(1).split("/");
  view = ["moments", "hooks", "player"].indexOf(hash[0]) >= 0 ? hash[0] : "moments";
  if (view === "player" && hash[1]) current = decodeURIComponent(hash[1]);
  document.querySelectorAll(".tabs a").forEach(function (a) { a.classList.toggle("active", a.dataset.view === view); });
  if (state) render(true);
}

function render(switched) {
  var root = document.getElementById("view");
  if (state.edlError && !state.shorts.length) { root.replaceChildren(el("div", { class: "empty", text: state.edlError + " The page updates when it appears." })); playerShell = null; return; }
  if (view === "player") { renderPlayer(root, switched); return; }
  playerShell = null;
  root.replaceChildren(view === "hooks" ? renderHooks() : renderMoments());
}

function renderMoments() {
  var bases = state.shorts.filter(function (s) { return !s.variantOf; });
  return el("div", { class: "moments" }, bases.map(function (s) {
    var r = rev(s.id);
    var meta = [s.id, s.durationSec ? s.durationSec.toFixed(1) + " s" : null, s.variants.length ? (s.variants.length + 1) + " hook variants" : null, s.videos.length ? "rendered" : null].filter(Boolean).join(" · ");
    return el("article", { class: "card" + (r.selected ? " selected" : "") },
      el("header", {}, el("span", { class: "rank", text: "#" + s.rank }), el("h3", { text: s.title || s.id }), pill(r.current)),
      s.hook ? el("p", { class: "hook", text: s.hook }) : null,
      el("div", { class: "meta", text: meta }),
      s.cuts.map(function (c) {
        return el("blockquote", { title: "Click to expand", onclick: function (e) { e.currentTarget.classList.toggle("open"); } },
          c.atMs !== undefined ? el("time", { text: wholeClock(c.atMs / 1000) }) : null, c.excerpt);
      }),
      s.notes ? el("div", { class: "meta", text: s.notes }) : null,
      s.sheet ? el("img", { class: "sheet", src: s.sheet, alt: "Contact sheet for " + s.id, loading: "lazy" }) : null,
      el("footer", {},
        el("label", { class: "keep" }, el("input", { type: "checkbox", checked: r.selected === true, onchange: function (e) { var box = e.target; send({ type: "select", short: s.id, selected: box.checked }).then(function (ok) { if (!ok) box.checked = !box.checked; }); } }), "Keep"),
        r.comments.length ? el("span", { class: "meta", text: r.comments.length + " comment" + (r.comments.length > 1 ? "s" : "") }) : null,
        el("span", { class: "grow" }),
        el("button", { class: "small", onclick: function () { location.hash = "player/" + encodeURIComponent(s.id); } }, "Open"))
    );
  }));
}

function renderHooks() {
  var groups = state.shorts.filter(function (s) { return s.variants.length; });
  if (!groups.length) return el("div", { class: "empty", text: "No hook variants yet. Variants are shorts named <id>-b and <id>-c in edl.json." });
  return el("div", {}, el("p", { class: "hint", text: "Each player stops at 6 s. Compare the openings and pick one per short." }), groups.map(function (base) {
    var ids = [base.id].concat(base.variants);
    var chosen = rev(base.id).variant;
    var players = [];
    var cols = ids.map(function (id, index) {
      var s = byId(id);
      var source = bestVideo(s);
      var player = source ? video(source.src) : null;
      if (player) { player.dataset.limit = "6"; players.push(player); }
      var isChosen = chosen === id;
      return el("div", { class: "variant" + (isChosen ? " chosen" : "") },
        el("div", { class: "vlabel" }, "ABCDEFGHIJ".charAt(index) + " ", el("span", { text: id + (source ? " · " + source.label : "") })),
        el("div", { class: "frame" }, player || "Not rendered yet"),
        el("p", { class: "hook", text: s.hook || "" }),
        el("button", { class: isChosen ? "primary" : "", onclick: function () { send({ type: "variant", short: base.id, choice: id }); } }, isChosen ? "Chosen" : "Pick " + "ABCDEFGHIJ".charAt(index)));
    });
    return el("section", { class: "group" },
      el("header", {}, el("h3", {}, el("span", { class: "rank", text: "#" + base.rank + " " }), base.title || base.id), pill(rev(base.id).current),
        players.length > 1 ? el("button", { onclick: function () { players.forEach(function (p) { p.muted = true; p.currentTime = 0; p.play(); }); } }, "Play openings together (muted)") : null),
      el("div", { class: "variants" }, cols));
  }));
}

function activeVideo() { return playerShell && playerShell.stage.querySelector("video"); }
function showTime() {
  if (!playerShell) return;
  var v = activeVideo();
  playerShell.at.textContent = clock(pinned ? pinned.atSec : v ? v.currentTime : 0);
}

function pin() {
  var short = byId(current);
  if (!short) return null;
  var v = activeVideo();
  var source = sourceFor(short);
  if (v) v.pause();
  pinned = { short: short.id, atSec: v ? v.currentTime : 0, file: source ? source.path : undefined, revision: source ? source.revision : undefined };
  return pinned;
}

function buildPlayerShell(root) {
  var at = el("span", { class: "at", text: "0:00.0" });
  var input = el("input", { placeholder: "Comment at this moment… (press c)", maxlength: "2000", "aria-label": "Comment" });
  // Pin on focus, so a poll that swaps in a newer render mid-comment can't move the note onto it.
  input.addEventListener("focus", function () { if (!pinned) pin(); showTime(); });
  input.addEventListener("blur", function () { if (!input.value) { pinned = null; showTime(); } });
  input.addEventListener("keydown", function (e) { if (e.key === "Escape") { input.value = ""; input.blur(); } });
  var form = el("form", { class: "comment" }, at, input, el("button", { class: "small primary", type: "submit" }, "Add"));
  var error = el("div", { class: "error", hidden: true, role: "alert" });
  var saving = false;
  async function submit() {
    var text = input.value.trim();
    if (!text || saving) return;
    var note = pinned || pin();
    if (!note) return;
    saving = true;
    var ok = await send({ type: "comment", short: note.short, atSec: note.atSec, text: text, file: note.file, revision: note.revision }, error, submit);
    saving = false;
    // Keep the draft and its pinned moment until the server has it.
    if (ok && input.value.trim() === text) { input.value = ""; pinned = null; showTime(); }
  }
  form.addEventListener("submit", function (e) { e.preventDefault(); submit(); });
  var shell = {
    list: el("nav", { class: "list" }),
    sources: el("div", { class: "sources" }),
    stage: el("div", { class: "frame" }),
    statuses: el("div", { class: "statuses" }),
    statusNote: el("div", { class: "hint" }),
    side: el("div", { class: "side" }),
    at: at, input: input, key: ""
  };
  shell.node = el("div", { class: "player" }, shell.list,
    el("div", { class: "stage" }, shell.sources, shell.stage, form, error, shell.statuses, shell.statusNote,
      el("div", { class: "hint" }, "Comments pin to the paused time. ", el("kbd", { text: "c" }), " comment · ", el("kbd", { text: "k" }), " play/pause · ", el("kbd", { text: "←" }), el("kbd", { text: "→" }), " 1 s")),
    shell.side);
  root.replaceChildren(shell.node);
  return shell;
}

function renderPlayer(root, switched) {
  if (!playerShell || !root.contains(playerShell.node)) playerShell = buildPlayerShell(root);
  var shell = playerShell;
  if (!current || !byId(current)) current = (state.shorts.find(function (s) { return s.videos.length; }) || state.shorts[0]).id;
  var short = byId(current);
  var r = rev(short.id);

  shell.list.replaceChildren.apply(shell.list, state.shorts.map(function (s) {
    var sr = rev(s.id);
    return el("button", { class: (s.id === current ? "active " : "") + (s.variantOf ? "variant-of" : ""), title: s.title || s.id, onclick: function () { location.hash = "player/" + encodeURIComponent(s.id); } },
      el("span", { class: "rank", text: s.variantOf ? s.id.slice(s.variantOf.length + 1).toUpperCase() : "#" + s.rank }),
      el("span", { class: "t", text: (s.variantOf ? s.hook : s.title) || s.id }),
      sr.comments.length ? el("span", { class: "meta", text: String(sr.comments.length) }) : null,
      sr.current !== "pending" ? el("span", { class: "dot " + sr.current, title: PILL_LABELS[sr.current] }) : null);
  }));

  var source = sourceFor(short);
  var key = short.id + "|" + (source ? source.src : "");
  shell.sources.replaceChildren.apply(shell.sources, short.videos.map(function (v) {
    return el("button", { class: "small" + (source && v.src === source.src ? " active" : ""), onclick: function () { chosenSource[short.id] = v.label; render(); } }, v.label);
  }));
  if (shell.key !== key) {
    var old = activeVideo();
    var sameShort = shell.key.split("|")[0] === short.id;
    var keepTime = old && source && sameShort ? old.currentTime : 0;
    if (old) old.pause();
    if (source) {
      var player = video(source.src);
      player.dataset.limit = "";
      player.muted = false;
      if (keepTime) player.currentTime = keepTime;
      shell.stage.replaceChildren(player);
    } else {
      shell.stage.replaceChildren(el("div", { text: "Not rendered yet" }));
    }
    shell.key = key;
    if (!sameShort) pinned = null;
    showTime();
  }

  shell.statuses.replaceChildren.apply(shell.statuses, ["approved", "changes", "rejected", "pending"].map(function (status) {
    var active = r.current === status;
    return el("button", { class: "small " + status + (active ? " active" : ""), onclick: function () {
      send({ type: "status", short: short.id, status: status, file: source ? source.path : undefined, revision: source ? source.revision : undefined });
    } }, STATUS_LABELS[status]);
  }));
  shell.statusNote.textContent = r.statusStale ? "Marked " + (PILL_LABELS[r.status] || r.status).toLowerCase() + " on an earlier render of " + r.reviewed.file.replace(/^render\//, "") + "; this one is pending." : "";

  var comments = r.comments.map(function (c) {
    var where = c.file && (!source || c.file !== source.path) ? c.file.replace(/^render\//, "") : null;
    return el("li", { class: (c.resolved ? "resolved " : "") + (c.stale ? "previous" : "") },
      el("button", { class: "at", title: "Seek here", onclick: function () {
        var target = short.videos.find(function (v) { return v.path === c.file; });
        if (target && (!source || target.src !== source.src)) { chosenSource[short.id] = target.label; render(); }
        var v = activeVideo(); if (v) { v.currentTime = c.atSec; v.pause(); }
      } }, clock(c.atSec)),
      el("span", { class: "text" }, c.text, c.stale ? el("span", { class: "where", text: "on a previous render" + (where ? " of " + where : "") }) : where ? el("span", { class: "where", text: "on " + where }) : null, c.resolved ? el("span", { class: "where", text: "resolved by the agent" }) : null),
      el("button", { class: "small", title: "Delete comment", onclick: function () { send({ type: "uncomment", short: short.id, id: c.id }); } }, "×"));
  });
  var stills = [];
  if (short.preview) stills.push(el("a", { class: "wide", href: short.preview, target: "_blank", rel: "noopener" }, el("img", { src: short.preview, alt: "Preview frames" })));
  short.snapshots.forEach(function (src) { stills.push(el("a", { href: src, target: "_blank", rel: "noopener" }, el("img", { src: src, alt: "Overlay snapshot", loading: "lazy" }))); });
  if (short.sheet) stills.push(el("a", { class: "wide", href: short.sheet, target: "_blank", rel: "noopener" }, el("img", { src: short.sheet, alt: "Contact sheet", loading: "lazy" })));
  shell.side.replaceChildren.apply(shell.side, [
    el("h2", {}, el("span", { class: "rank", text: (short.variantOf ? "#" + short.rank + short.id.slice(short.variantOf.length + 1).toUpperCase() : "#" + short.rank) + " " }), short.title || short.id),
    short.hook ? el("p", { class: "hook", text: short.hook }) : null,
    el("h4", { text: "Comments" + (r.comments.length ? " (" + r.comments.length + ")" : "") }),
    r.comments.length ? el("ol", { class: "comments" }, comments) : el("p", { class: "hint", text: "No comments yet. Pause where something is off and type what to change." }),
    stills.length ? el("h4", { text: "Stills" }) : null,
    el("div", { class: "stills" }, stills)].filter(Boolean));
  if (switched && document.activeElement !== shell.input) window.scrollTo(0, 0);
}

document.addEventListener("keydown", function (e) {
  if (view !== "player" || !playerShell || e.target.tagName === "INPUT" || e.metaKey || e.ctrlKey || e.altKey) return;
  var v = activeVideo();
  if (e.key === "c") { e.preventDefault(); playerShell.input.focus(); }
  else if (e.key === "k" && v) { e.preventDefault(); if (v.paused) v.play(); else v.pause(); }
  else if (e.key === "ArrowLeft" && v) { v.currentTime = Math.max(0, v.currentTime - 1); }
  else if (e.key === "ArrowRight" && v) { v.currentTime = v.currentTime + 1; }
});

async function poll() {
  var live = document.getElementById("live");
  try {
    var response = await fetch("/api/state?since=" + encodeURIComponent(state ? state.version : ""), { cache: "no-store" });
    if (response.status === 200) apply(await response.json());
    live.classList.remove("off");
    live.textContent = "Watching project files";
  } catch (error) {
    live.classList.add("off");
    live.textContent = "Review server stopped";
  }
  setTimeout(poll, 1500);
}

window.addEventListener("hashchange", route);
route();
poll();
</script>
</body>
</html>
`;
}
