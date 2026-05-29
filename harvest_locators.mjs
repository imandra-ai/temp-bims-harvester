// harvest_locators.mjs
//
// READ-ONLY locator harvester for BIMS NextGen, run ON the AWS Workspace.
//
// ZERO DEPENDENCIES.  Talks to Chrome's DevTools Protocol directly using
// only Node.js built-ins (fetch + the built-in WebSocket).  No `npm
// install`, no Playwright, no browser download — so it works on a
// network-restricted box (e.g. where registry.npmjs.org is blocked).
// It's also a single file: if `git clone` is blocked too, just copy this
// one file onto the Workspace.
//
//   ===> Requires Node.js 22+ (for the built-in global WebSocket). <===
//
// It attaches to a Chrome you already logged into (over the debug port),
// so there is NO credential handling and NO SSO scripting here.  You
// navigate by hand; this reads whatever page is open and dumps a
// structured snapshot of every interactive control (data-testid / id /
// name / aria-label / role / associated label / candidate selectors) to a
// JSON file.  It never clicks, types, submits, or mutates anything.
//
// ---------------------------------------------------------------------------
// Usage (PowerShell / cmd on the Workspace):
//
//   1. Launch Chrome with the debug port + a dedicated profile (once):
//        "C:\Program Files\Google\Chrome\Application\chrome.exe" ^
//          --remote-debugging-port=9222 ^
//          --user-data-dir="%USERPROFILE%\bims-automation-profile"
//
//   2. In THAT Chrome window, log into NextGen and navigate to the algo's
//      New Order form -> open the Controls/Advanced panels so every field
//      is in the DOM.
//
//   3. Run the harvester, naming the strategy you're looking at:
//        node harvest_locators.mjs --strategy QMOC_AMRS --out qmoc_amrs.dom.json
//
//   4. Send back the produced <out>.json (and the printed summary).
//
// Flags:
//   --strategy <NAME>   label stamped into the snapshot (free text)
//   --out <FILE>        output path (default: <strategy>.dom.json)
//   --cdp <URL>         CDP endpoint (default: http://localhost:9222)
//   --url-contains <S>  if multiple tabs are open, pick the one whose URL
//                       contains S (default: "broadridge")
// ---------------------------------------------------------------------------

import { writeFileSync } from "node:fs";

function arg(flag, dflt) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : dflt;
}

const STRATEGY = arg("--strategy", "UNKNOWN");
const OUT = arg("--out", `${STRATEGY}.dom.json`);
const CDP = arg("--cdp", "http://localhost:9222");
const URL_CONTAINS = arg("--url-contains", "broadridge");

// This function runs INSIDE the page (serialized and sent over CDP).  It
// collects, for every plausible form control, the attributes + context a
// test-locator author needs.
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
      const parts = lb.split(/\s+/)
        .map((id) => document.getElementById(id))
        .filter(Boolean)
        .map((n) => trim(n.textContent));
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

  const out = [];
  const seen = new Set();
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
  return {
    pageUrl: location.href,
    pageTitle: document.title,
    controlCount: out.length,
    withTestid: out.filter((c) => c.dataTestid).length,
    controls: out,
  };
}

// ---- CDP transport (built-ins only) ---------------------------------------

async function listTargets(cdp) {
  // Chrome exposes the open tabs as JSON at /json/list on the debug port.
  const res = await fetch(new URL("/json/list", cdp));
  if (!res.ok) throw new Error(`GET ${cdp}/json/list -> HTTP ${res.status}`);
  return res.json();
}

function evalInPage(wsUrl, expression) {
  // Open a WebSocket to the page's CDP endpoint, run Runtime.evaluate, and
  // return the by-value result.
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error("timed out waiting for CDP response (15s)"));
    }, 15000);

    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({
        id: 1,
        method: "Runtime.evaluate",
        params: { expression, returnByValue: true, awaitPromise: true },
      }));
    });
    ws.addEventListener("message", (ev) => {
      let msg;
      try {
        msg = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString());
      } catch { return; }
      if (msg.id !== 1) return;            // ignore unsolicited CDP events
      clearTimeout(timer);
      try { ws.close(); } catch {}
      if (msg.error) return reject(new Error("CDP error: " + JSON.stringify(msg.error)));
      const r = msg.result && msg.result.result;
      if (r && r.subtype === "error") return reject(new Error(r.description || "in-page error"));
      resolve(r ? r.value : null);
    });
    ws.addEventListener("error", (e) => {
      clearTimeout(timer);
      reject(new Error("WebSocket error: " + (e && e.message ? e.message : String(e))));
    });
  });
}

async function main() {
  if (typeof WebSocket === "undefined") {
    console.error(
      "\nERROR: this Node has no built-in WebSocket.\n" +
      "The zero-dependency harvester needs Node.js 22+.  Check with:\n" +
      "  node --version\n");
    process.exit(2);
  }

  let targets;
  try {
    targets = await listTargets(CDP);
  } catch (e) {
    console.error(
      `\nERROR: could not reach Chrome's debug endpoint at ${CDP}.\n` +
      `Make sure Chrome was started with --remote-debugging-port=9222\n` +
      `(see the header of this file for the exact command).\n\n${e.message}\n`);
    process.exit(3);
  }

  const pages = targets.filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
  if (!pages.length) {
    console.error("ERROR: reached Chrome, but found no open page tabs.");
    process.exit(4);
  }
  let target = pages.find((t) => (t.url || "").includes(URL_CONTAINS));
  if (!target) {
    console.error(
      `WARNING: no tab URL contains "${URL_CONTAINS}". Tabs open:\n` +
      pages.map((t) => "  - " + t.url).join("\n") +
      `\nFalling back to the first tab.\n`);
    target = pages[0];
  }

  const expression = "(" + collectInPage.toString() + ")()";
  const dom = await evalInPage(target.webSocketDebuggerUrl, expression);
  if (!dom) {
    console.error("ERROR: CDP returned no result (page may have navigated).");
    process.exit(5);
  }

  const snapshot = {
    strategy: STRATEGY,
    capturedFromUrl: dom.pageUrl,
    pageTitle: dom.pageTitle,
    controlCount: dom.controlCount,
    controlsWithTestid: dom.withTestid,
    controls: dom.controls,
  };
  writeFileSync(OUT, JSON.stringify(snapshot, null, 2));

  console.log(`\nHarvested ${dom.controlCount} controls from:`);
  console.log(`  ${dom.pageUrl}`);
  console.log(`  (${dom.withTestid} expose a data-testid)\n`);
  const named = dom.controls.filter((c) => c.label || c.dataTestid);
  for (const c of named.slice(0, 40)) {
    const key = c.dataTestid ? `testid=${c.dataTestid}`
              : c.id ? `id=${c.id}`
              : c.name ? `name=${c.name}`
              : c.cssSuggest || c.xpathSuggest || "(no stable handle)";
    console.log(`  [${c.tag}${c.type ? ":" + c.type : ""}] ${c.label || "(no label)"}  ->  ${key}`);
  }
  if (named.length > 40) console.log(`  ... and ${named.length - 40} more (see ${OUT})`);
  console.log(`\nWrote ${OUT} — send me this file.\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
