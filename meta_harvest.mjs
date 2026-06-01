// meta_harvest.mjs
//
// AUTONOMOUS multi-strategy locator harvester for BIMS NextGen.
//
// Given a New Order form where you've already logged in, picked a security,
// and routed to the BofA broker (so the Strategy picker is populated), this
// walks EVERY strategy in the picker: selects it, expands its Controls /
// Advanced panels, and snapshots the DOM to <strategy>.dom.json — so you get
// all strategies in one unattended pass instead of harvesting one at a time.
//
// SAFETY: read-and-navigate only.  It interacts with EXACTLY three things —
// the Strategy combobox, a named strategy option, and the panel toggle
// buttons (Controls/Advanced).  It never clicks Save / Send / Submit; there
// is no code path that does.  No order is ever placed.
//
//   ===> Requires Node.js 22+ (built-in WebSocket).  Zero dependencies. <===
//
// ---------------------------------------------------------------------------
// Usage (on the Workspace, after logging in + setting up a New Order):
//
//   1. Chrome already running with --remote-debugging-port=9222 (see README).
//   2. In NextGen: open New Order, pick a BofA-routable security, route to the
//      BofA broker so the Strategy dropdown lists the algos.  Leave it there.
//   3. node meta_harvest.mjs --only AMRS --out-dir harvest
//
//   --only <substr>     only harvest strategies whose picker name contains
//                       this (case-insensitive); omit for ALL.
//   --panels "A,B"      panel toggle labels to expand (default "Controls,Advanced")
//   --out-dir <dir>     where to write <strategy>.dom.json (default ".")
//   --cdp <url>         CDP endpoint (default http://localhost:9222)
//   --url-contains <s>  pick the tab whose URL contains this (default "broadridge")
//   --settle <ms>       wait after each select/expand (default 800)
//
// Sends back: the per-strategy *.dom.json files + meta-harvest-summary.json.
// ---------------------------------------------------------------------------

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

function arg(flag, dflt) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : dflt;
}
const ONLY     = (arg("--only", "") || "").toLowerCase();
const PANELS   = arg("--panels", "Controls,Advanced").split(",").map(s => s.trim()).filter(Boolean);
const OUT_DIR  = arg("--out-dir", ".");
const CDP      = arg("--cdp", "http://localhost:9222");
const URL_CONT = arg("--url-contains", "broadridge");
const SETTLE   = parseInt(arg("--settle", "800"), 10);

// ---- in-page routines (serialized + run via Runtime.evaluate) -------------

// XPath for the Strategy picker combobox (matches QmocPage.strategyBtn).
const STRAT_XPATH =
  "//div[text()='Strategy']/..//button[@role='combobox'] | " +
  "//div[contains(text(),'Algo')]//following-sibling::*//button[@role='combobox']";

function listStrategiesInPage(stratXpath) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const xp = (x) => document.evaluate(x, document, null,
    XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
  return (async () => {
    const btn = xp(stratXpath);
    if (!btn) return { error: "Strategy combobox not found" };
    btn.click();
    await sleep(500);
    const names = [...document.querySelectorAll("div[role='option'] [title]")]
      .map((e) => e.getAttribute("title"))
      .filter(Boolean);
    document.body.click();              // close the dropdown
    await sleep(150);
    return { strategies: [...new Set(names)] };
  })();
}

function selectStrategyInPage(stratXpath, name, settle) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const xp = (x) => document.evaluate(x, document, null,
    XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
  return (async () => {
    const btn = xp(stratXpath);
    if (!btn) return { error: "Strategy combobox not found" };
    btn.click();
    await sleep(settle);
    const opt = [...document.querySelectorAll("div[role='option']")].find((o) => {
      const t = o.querySelector("[title]");
      return t && t.getAttribute("title") === name;
    });
    if (!opt) { document.body.click(); return { error: "option not found: " + name }; }
    opt.click();
    await sleep(settle);
    return { ok: true };
  })();
}

// Identical DOM collector to harvest_locators.mjs (kept in sync by hand).
function collectInPage() {
  const SELECTOR = [
    "input", "select", "textarea", "button",
    "[role='combobox']", "[role='checkbox']", "[role='radio']",
    "[role='switch']", "[role='spinbutton']", "[role='textbox']",
    "[contenteditable='true']", "[data-testid]",
  ].join(",");
  const trim = (s) => (s || "").replace(/\s+/g, " ").trim().slice(0, 120);
  function labelFor(el) {
    if (el.id) {
      const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (l) return trim(l.textContent);
    }
    const lb = el.getAttribute("aria-labelledby");
    if (lb) {
      const parts = lb.split(/\s+/).map((id) => document.getElementById(id))
        .filter(Boolean).map((n) => trim(n.textContent));
      if (parts.length) return parts.join(" ");
    }
    const al = el.getAttribute("aria-label");
    if (al) return trim(al);
    const wrap = el.closest("label");
    if (wrap) return trim(wrap.textContent);
    let p = el.parentElement, hops = 0;
    while (p && hops < 4) {
      const lbl = p.querySelector("label, .label, [class*='label'], legend");
      if (lbl && lbl.contains(el) === false) return trim(lbl.textContent);
      p = p.parentElement; hops++;
    }
    return "";
  }
  function cssSuggest(el) {
    const tid = el.getAttribute("data-testid");
    if (tid) return `[data-testid="${tid}"]`;
    if (el.id && !/^[0-9]/.test(el.id)) return `#${CSS.escape(el.id)}`;
    const name = el.getAttribute("name");
    if (name) return `${el.tagName.toLowerCase()}[name="${name}"]`;
    return null;
  }
  function xpathSuggest(el, label) {
    if (label) return `//*[normalize-space(text())='${label}']`;
    const txt = trim(el.textContent);
    if (txt) return `//${el.tagName.toLowerCase()}[normalize-space(text())='${txt}']`;
    return null;
  }
  const out = [], seen = new Set();
  for (const el of document.querySelectorAll(SELECTOR)) {
    if (seen.has(el)) continue;
    seen.add(el);
    const rect = el.getBoundingClientRect();
    const attrs = {};
    for (const a of el.attributes) attrs[a.name] = a.value;
    const label = labelFor(el);
    out.push({
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute("type") || null,
      role: el.getAttribute("role") || null,
      dataTestid: el.getAttribute("data-testid") || null,
      id: el.id || null,
      name: el.getAttribute("name") || null,
      ariaLabel: el.getAttribute("aria-label") || null,
      placeholder: el.getAttribute("placeholder") || null,
      label,
      text: trim(el.textContent),
      checked: el.matches("[role='checkbox'],[role='switch']")
        ? el.getAttribute("aria-checked")
        : (typeof el.checked === "boolean" ? el.checked : null),
      visible: rect.width > 0 && rect.height > 0
        && getComputedStyle(el).visibility !== "hidden"
        && getComputedStyle(el).display !== "none",
      cssSuggest: cssSuggest(el),
      xpathSuggest: xpathSuggest(el, label),
      attrs,
    });
  }
  return { pageUrl: location.href, pageTitle: document.title,
    controlCount: out.length, withTestid: out.filter((c) => c.dataTestid).length,
    controls: out };
}

// ---- CDP transport (built-ins only) ---------------------------------------

async function listTargets(cdp) {
  const res = await fetch(new URL("/json/list", cdp));
  if (!res.ok) throw new Error(`GET ${cdp}/json/list -> HTTP ${res.status}`);
  return res.json();
}

function makeEval(wsUrl) {
  // Returns evalExpr(expression) -> Promise(result); reuses one socket.
  let ws, nextId = 1, pending = new Map(), ready;
  function connect() {
    ready = new Promise((resolve, reject) => {
      ws = new WebSocket(wsUrl);
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", (e) => reject(new Error("WS error: " + (e.message || e))));
      ws.addEventListener("message", (ev) => {
        let m; try { m = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString()); } catch { return; }
        if (m.id && pending.has(m.id)) {
          const { resolve, reject } = pending.get(m.id); pending.delete(m.id);
          if (m.error) return reject(new Error("CDP: " + JSON.stringify(m.error)));
          const r = m.result && m.result.result;
          if (r && r.subtype === "error") return reject(new Error(r.description || "in-page error"));
          resolve(r ? r.value : null);
        }
      });
    });
  }
  connect();
  async function evalExpr(expression) {
    await ready;
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      const t = setTimeout(() => { pending.delete(id); reject(new Error("CDP timeout (120s)")); }, 120000);
      const wrap = (v) => { clearTimeout(t); resolve(v); };
      pending.set(id, { resolve: wrap, reject });
      ws.send(JSON.stringify({ id, method: "Runtime.evaluate",
        params: { expression, returnByValue: true, awaitPromise: true } }));
    });
  }
  return { evalExpr, close: () => { try { ws.close(); } catch {} } };
}

const call = (fn, ...args) => `(${fn.toString()})(${args.map((a) => JSON.stringify(a)).join(",")})`;

// Build the in-page "capture everything" expression for the currently-selected
// strategy.  It (1) clicks named panel toggles, (2) recursively expands every
// collapsible section (aria-expanded=false) except the Strategy combobox, then
// (3) toggles each algo gate checkbox (data-testid$=_checkbox) to reveal the
// fields it gates — snapshotting in each state and MERGING by testid — and
// restores each checkbox afterwards so the next strategy starts clean.  This
// is what makes the capture complete: gated clocks/fields no longer hide.
function captureExpr(stratXpath, panels, settle) {
  return `(async () => {
    ${collectInPage.toString()}
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const xp = (x) => document.evaluate(x, document, null, 9, null).singleNodeValue;
    const stratBtn = xp(${JSON.stringify(stratXpath)});
    const panels = ${JSON.stringify(panels)};
    // (1) named panel toggles, if collapsed
    for (const lbl of panels) {
      const pb = xp("//button[normalize-space(text())='" + lbl + "']");
      if (pb && pb.getAttribute("aria-expanded") !== "true") { try { pb.click(); } catch (e) {} await sleep(${settle} / 2); }
    }
    // (2) recursively expand all collapsed accordions (not the strategy picker)
    const expandPass = () => {
      const t = [...document.querySelectorAll('[aria-expanded="false"]')].filter((e) => e !== stratBtn);
      t.forEach((e) => { try { e.click(); } catch (x) {} });
      return t.length;
    };
    for (let i = 0; i < 12; i++) { if (expandPass() === 0) break; await sleep(${settle} / 2); }
    // (3) capture + merge across gate-checkbox states
    const byKey = new Map();
    const absorb = () => { const r = collectInPage(); for (const c of r.controls) {
      const k = c.dataTestid || c.cssSuggest || c.xpathSuggest || (c.tag + "|" + c.label);
      if (!byKey.has(k)) byKey.set(k, c); } };
    absorb();
    const boxes = [...document.querySelectorAll('[data-testid$="_checkbox"]')].slice(0, 16);
    let toggled = 0;
    for (const b of boxes) {
      try { b.click(); } catch (e) { continue; }
      toggled++; await sleep(${settle} / 2);
      for (let i = 0; i < 6; i++) { if (expandPass() === 0) break; await sleep(${settle} / 3); }
      absorb();
      try { b.click(); } catch (e) {}     // restore prior state
      await sleep(${settle} / 3);
    }
    const controls = [...byKey.values()];
    return { pageUrl: location.href, pageTitle: document.title,
      controlCount: controls.length, withTestid: controls.filter((c) => c.dataTestid).length,
      gateCheckboxesToggled: toggled, controls };
  })()`;
}

async function main() {
  if (typeof WebSocket === "undefined") {
    console.error("\nERROR: Node 22+ required (built-in WebSocket). node --version\n"); process.exit(2);
  }
  let targets;
  try { targets = await listTargets(CDP); }
  catch (e) {
    console.error(`\nERROR: cannot reach Chrome at ${CDP} (start it with --remote-debugging-port=9222).\n${e.message}\n`);
    process.exit(3);
  }
  const pages = targets.filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
  const target = pages.find((t) => (t.url || "").includes(URL_CONT)) || pages[0];
  if (!target) { console.error("ERROR: no open page tab found."); process.exit(4); }

  mkdirSync(OUT_DIR, { recursive: true });
  const { evalExpr, close } = makeEval(target.webSocketDebuggerUrl);

  // 1. Enumerate strategies in the picker.
  const listed = await evalExpr(call(listStrategiesInPage, STRAT_XPATH));
  if (!listed || listed.error || !listed.strategies) {
    console.error("ERROR listing strategies: " + (listed && listed.error || "unknown") +
      "\nMake sure a New Order is open, a BofA-routable security is selected, and the Strategy dropdown is populated.");
    close(); process.exit(5);
  }
  let names = listed.strategies;
  if (ONLY) names = names.filter((n) => n.toLowerCase().includes(ONLY));
  console.log(`\nStrategy picker lists ${listed.strategies.length} strategies` +
    (ONLY ? ` (${names.length} match "--only ${ONLY}")` : "") + ":");
  console.log("  " + names.join(", ") + "\n");

  // 2. Walk each: select -> fully expand (incl. gate-checkbox states) -> snapshot.
  const summary = [];
  for (const name of names) {
    process.stdout.write(`  • ${name} … `);
    let nav, dom = null, err = null;
    try {
      nav = await evalExpr(call(selectStrategyInPage, STRAT_XPATH, name, SETTLE));
      if (nav && nav.error) throw new Error(nav.error);
      dom = await evalExpr(captureExpr(STRAT_XPATH, PANELS, SETTLE));
    } catch (e) { err = e.message; }
    if (dom) {
      const file = join(OUT_DIR, name.replace(/[^A-Za-z0-9_]+/g, "_").toLowerCase() + ".dom.json");
      writeFileSync(file, JSON.stringify({
        strategy: name, capturedFromUrl: dom.pageUrl, pageTitle: dom.pageTitle,
        controlCount: dom.controlCount, controlsWithTestid: dom.withTestid,
        gateCheckboxesToggled: dom.gateCheckboxesToggled, controls: dom.controls,
      }, null, 2));
      console.log(`${dom.controlCount} controls, ${dom.withTestid} testids ` +
        `(${dom.gateCheckboxesToggled} gate-toggles) -> ${file}`);
      summary.push({ strategy: name, file, controls: dom.controlCount, testids: dom.withTestid });
    } else {
      console.log(`SKIPPED (${err})`);
      summary.push({ strategy: name, error: err });
    }
  }

  writeFileSync(join(OUT_DIR, "meta-harvest-summary.json"),
    JSON.stringify({ listed: listed.strategies, harvested: summary }, null, 2));
  const ok = summary.filter((s) => !s.error).length;
  console.log(`\nDone: ${ok}/${names.length} strategies harvested into ${OUT_DIR}/`);
  console.log(`Send back ${OUT_DIR}/*.dom.json + meta-harvest-summary.json\n`);
  close();
}

main().catch((e) => { console.error(e); process.exit(1); });
