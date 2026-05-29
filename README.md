# BIMS locator harvester

A small **read-only** tool that captures the live DOM of the Broadridge BIMS
NextGen order form so the Imandra ATDL test generator can build accurate
Playwright locators (real `data-testid`s and element structure instead of
guessed XPath).

It **attaches to a Chrome you already logged into** over Chrome's debug
port — so there's no credential handling and no SSO scripting here. You
navigate by hand; the tool only reads whatever page is open. **It never
clicks, types, submits, or mutates anything.**

> Runs on the AWS Workspace (the Windows desktop with NextGen access).
> Produces a JSON snapshot you send back; nothing is transmitted from this
> tool itself.

## Prerequisites

- **Node.js 18+** (22 LTS recommended) — includes npm.
- **Google Chrome** (or Microsoft Edge) — already present on the Workspace.

## One-time setup

```
git clone <this-repo-url>
cd bims-locator-harvester
npm install
```

`npm install` pulls the Playwright npm package (needs access to the npm
registry or an internal mirror). It does **not** download browser binaries
— we attach to your existing Chrome.

## Each harvest run

1. **Launch Chrome with the debug port + a dedicated profile.** Close other
   Chrome windows first, then run (one line):

   ```
   "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="%USERPROFILE%\bims-automation-profile"
   ```

   Adjust the path if Chrome is elsewhere; for Edge swap in `msedge.exe`.
   The separate `--user-data-dir` isolates this from your normal profile and
   lets the NextGen session persist between runs.

2. **In that Chrome window:** log into NextGen, open a New Order, select the
   algo (e.g. QMOC), and **expand the Controls + Advanced panels** so every
   field is rendered. The tool can only see what's in the DOM.

3. **Run the harvester**, naming the strategy you're on:

   ```
   node harvest_locators.mjs --strategy QMOC_AMRS --out qmoc_amrs.dom.json
   ```

   It prints a summary (control count, how many expose a `data-testid`) and
   writes `qmoc_amrs.dom.json`.

4. **Send back the produced `*.dom.json`.** Repeat per algo — a handful of
   varied strategies (e.g. QMOC, BLOCKSEEKER, a CUSTOM\*, a VWAP) covers most
   locator patterns; you don't need all 47.

## Flags

| Flag | Default | Meaning |
|------|---------|---------|
| `--strategy <NAME>` | `UNKNOWN` | Label stamped into the snapshot |
| `--out <FILE>` | `<strategy>.dom.json` | Output path |
| `--cdp <URL>` | `http://localhost:9222` | Chrome DevTools endpoint |
| `--url-contains <S>` | `broadridge` | If several tabs are open, pick the one whose URL contains this |

## What the JSON contains

Per control: `data-testid`, `id`, `name`, `aria-label`, `role`, associated
visible label, trimmed text, visibility, a suggested CSS selector
(testid > id > name) and an XPath fallback, plus the full attribute map —
and the page's accessibility tree. Everything needed to choose the most
stable locator for each field.
