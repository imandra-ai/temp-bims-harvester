// harvest_locators.mjs
//
// READ-ONLY locator harvester for BIMS NextGen, run ON the AWS Workspace.
//
// It attaches (over Chrome's DevTools Protocol) to a Chrome you already
// logged into — so there is NO credential handling and NO SSO scripting
// here.  You navigate by hand to an algo's order/control panel; this
// script reads whatever page is open and dumps a structured snapshot of
// every interactive control (data-testid / id / name / aria-label / role
// / associated label text / candidate selectors) to a JSON file.
//
// You then send that JSON back; the generator rewrites each strategy's
// page-object locators against the *real* DOM instead of guessed XPath.
//
// It never clicks, types, submits, or mutates anything — it only reads
// the DOM and the accessibility tree of the page that is already open.
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
//   4. Send me the produced <out>.json (and the printed summary).
//
// Flags:
//   --strategy <NAME>   label stamped into the snapshot (free text)
//   --out <FILE>        output path (default: <strategy>.dom.json)
//   --cdp <URL>         CDP endpoint (default: http://localhost:9222)
//   --url-contains <S>  if multiple tabs are open, pick the one whose URL
//                       contains S (default: "broadridge")
// ---------------------------------------------------------------------------

import { chromium } from "playwright";
import { writeFileSync } from "node:fs";

function arg(flag, dflt) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : dflt;
}

const STRATEGY = arg("--strategy", "UNKNOWN");
const OUT = arg("--out", `${STRATEGY}.dom.json`);
const CDP = arg("--cdp", "http://localhost:9222");
const URL_CONTAINS = arg("--url-contains", "broadridge");

// This function runs INSIDE the page.  It collects, for every plausible
// form control, the attributes + context a test-locator author needs.
function collectInPage() {
  const SELECTOR = [
    "input", "select", "textarea", "button",
    "[role='combobox']", "[role='checkbox']", "[role='radio']",
    "[role='switch']", "[role='spinbutton']", "[role='textbox']",
    "[contenteditable='true']", "[data-testid]",
  ].join(",");

  const trim = (s) => (s || "").replace(/\s+/g, " ").trim().slice(0, 120);

  // Best-effort visible-label association for a control.
  function labelFor(el) {
    // 1. <label for="id">
    if (el.id) {
      const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (l) return trim(l.textContent);
    }
    // 2. aria-labelledby
    const lb = el.getAttribute("aria-labelledby");
    if (lb) {
      const parts = lb.split(/\s+/)
        .map((id) => document.getElementById(id))
        .filter(Boolean)
        .map((n) => trim(n.textContent));
      if (parts.length) return parts.join(" ");
    }
    // 3. aria-label
    const al = el.getAttribute("aria-label");
    if (al) return trim(al);
    // 4. wrapping <label>
    const wrap = el.closest("label");
    if (wrap) return trim(wrap.textContent);
    // 5. nearest preceding label-ish sibling/ancestor text
    let p = el.parentElement, hops = 0;
    while (p && hops < 4) {
      const lbl = p.querySelector("label, .label, [class*='label'], legend");
      if (lbl && lbl.contains(el) === false) return trim(lbl.textContent);
      p = p.parentElement; hops++;
    }
    return "";
  }

  // A reasonably stable CSS suggestion, preferring testid > id > name.
  function cssSuggest(el) {
    const tid = el.getAttribute("data-testid");
    if (tid) return `[data-testid="${tid}"]`;
    if (el.id && !/^[0-9]/.test(el.id)) return `#${CSS.escape(el.id)}`;
    const name = el.getAttribute("name");
    if (name) return `${el.tagName.toLowerCase()}[name="${name}"]`;
    return null;
  }

  // An XPath fallback (text-based, mirrors what the generator emits today).
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
    // count how many controls actually expose a data-testid -- the single
    // most useful number for deciding whether G8 can go green.
    withTestid: out.filter((c) => c.dataTestid).length,
    controls: out,
  };
}

async function main() {
  let browser;
  try {
    browser = await chromium.connectOverCDP(CDP);
  } catch (e) {
    console.error(
      `\nERROR: could not attach to Chrome at ${CDP}.\n` +
      `Make sure Chrome was started with --remote-debugging-port=9222\n` +
      `(see the header of this file for the exact command).\n\n${e.message}\n`);
    process.exit(2);
  }

  // Gather every open page across contexts; pick the NextGen one.
  const contexts = browser.contexts();
  const pages = contexts.flatMap((c) => c.pages());
  if (!pages.length) {
    console.error("ERROR: attached, but no open tabs found.");
    process.exit(3);
  }
  let page = pages.find((p) => (p.url() || "").includes(URL_CONTAINS));
  if (!page) {
    console.error(
      `WARNING: no tab URL contains "${URL_CONTAINS}". Tabs open:\n` +
      pages.map((p) => "  - " + p.url()).join("\n") +
      `\nFalling back to the first tab.\n`);
    page = pages[0];
  }

  const dom = await page.evaluate(collectInPage);
  // Accessibility tree is a useful complement for role/name-based locators.
  let ax = null;
  try { ax = await page.accessibility.snapshot(); } catch { /* optional */ }

  const snapshot = {
    strategy: STRATEGY,
    capturedFromUrl: dom.pageUrl,
    pageTitle: dom.pageTitle,
    controlCount: dom.controlCount,
    controlsWithTestid: dom.withTestid,
    controls: dom.controls,
    accessibilityTree: ax,
  };
  writeFileSync(OUT, JSON.stringify(snapshot, null, 2));

  // Human-readable summary so you can eyeball it before sending.
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

  await browser.close(); // detaches; does NOT close your Chrome windows
}

main().catch((e) => { console.error(e); process.exit(1); });
