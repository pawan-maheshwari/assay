#!/usr/bin/env node
// Assay release watcher.
// 1. Lists chat models from each provider and finds ones not seen before.
// 2. Reads the configured release-note pages and drafts a scenario per new model.
// 3. Runs live test packs through the same engine as index.html (loaded in jsdom).
// 4. Writes results/latest.json and renders reports/latest.pdf with Playwright.
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cfg = JSON.parse(await fs.readFile(path.join(ROOT, "watcher/config.json"), "utf8"));
const KEYS = { openai: process.env.OPENAI_API_KEY || "", anthropic: process.env.ANTHROPIC_API_KEY || "", gemini: process.env.GEMINI_API_KEY || "" };
const TODAY = new Date().toISOString().slice(0, 10);
const log = (...a) => console.log("[assay]", ...a);
const readJSON = async (f, d) => { try { return JSON.parse(await fs.readFile(path.join(ROOT, f), "utf8")); } catch { return d; } };
const writeJSON = async (f, o) => { await fs.mkdir(path.dirname(path.join(ROOT, f)), { recursive: true }); await fs.writeFile(path.join(ROOT, f), JSON.stringify(o, null, 2)); };

// Load the app itself so the watcher and the browser share one engine.
const dom = new JSDOM(await fs.readFile(path.join(ROOT, "index.html"), "utf8"), { runScripts: "dangerously", pretendToBeVisual: true, url: "https://assay.local/" });
const w = dom.window;
w.fetch = fetch; w.confirm = () => true; w.alert = m => log(m); w.scrollTo = () => {};
const A = w.Assay;

// Scenarios from the repo (the embedded set is already loaded).
const index = await readJSON("scenarios/index.json", { scenarios: [] });
const files = await Promise.all(index.scenarios.map(f => readJSON("scenarios/" + f, null)));
A.addScenarios(files.filter(Boolean));

// 1. Detect new models.
const known = await readJSON("watch/known-models.json", { models: [] });
const firstRun = !known.models.length;
const knownSet = new Set(known.models.map(m => m.provider + ":" + m.id));
const found = [];
for (const p of Object.keys(KEYS)) {
  if (!KEYS[p]) { log(`no ${p} key, skipping catalogue`); continue; }
  try {
    const list = (await A.listModels(p, KEYS[p])).filter(m => A.isChatModel(p, m.id));
    list.forEach(m => found.push(m));
    log(`${p}: ${list.length} chat models`);
  } catch (e) { log(`${p} catalogue failed: ${e.message}`); }
}
const fresh = firstRun ? [] : found.filter(m => !knownSet.has(m.provider + ":" + m.id));
log(firstRun ? "first run: recording the current catalogue as the baseline" : `${fresh.length} new models`);
const merged = new Map(known.models.map(m => [m.provider + ":" + m.id, m]));
found.forEach(m => { const k = m.provider + ":" + m.id; if (!merged.has(k)) merged.set(k, { provider: m.provider, id: m.id, firstSeen: TODAY }); });
await writeJSON("watch/known-models.json", { updated: TODAY, models: [...merged.values()] });

// 2. Draft scenarios from release notes.
const stripHtml = h => h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const noteCache = {};
async function releaseText(p) {
  if (noteCache[p] !== undefined) return noteCache[p];
  let txt = "";
  for (const url of (cfg.releaseNotes[p] || [])) {
    try { const r = await fetch(url, { headers: { "user-agent": "assay-watch" } }); if (r.ok) txt += `\nSOURCE ${url}\n` + stripHtml(await r.text()).slice(0, 40000); } catch (e) { log(`could not read ${url}: ${e.message}`); }
  }
  return (noteCache[p] = txt);
}
const drafts = [];
for (const m of fresh.slice(0, 6)) {
  const pool = found.concat(known.models);
  const baseId = cfg.predecessors[m.id] || A.guessPredecessor(m.provider, m.id, pool);
  let claims = [], summary = "", sourceUrl = (cfg.releaseNotes[m.provider] || [])[0] || "";
  const txt = await releaseText(m.provider);
  if (txt && KEYS.anthropic) {
    try {
      const focus = txt.includes(m.id) ? txt.slice(Math.max(0, txt.indexOf(m.id) - 4000), txt.indexOf(m.id) + 12000) : txt.slice(0, 16000);
      const out = await A.extractClaims({ text: `New model: ${m.id}\n${focus}`, vendor: m.provider, key: KEYS.anthropic, model: cfg.extractionModel });
      claims = out.claims; summary = out.summary || "";
    } catch (e) { log(`extraction failed for ${m.id}: ${e.message}`); }
  }
  const pr = id => cfg.prices[id] || [0, 0];
  const sc = A.buildDraftScenario({ provider: m.provider, candId: m.id, baseId, baseIn: pr(baseId)[0], baseOut: pr(baseId)[1], candIn: pr(m.id)[0], candOut: pr(m.id)[1], claims, summary: summary ? summary + " Draft: claims extracted automatically and not yet reviewed." : "", sourceUrl, released: m.created || TODAY });
  await writeJSON("scenarios/" + sc.id + ".json", sc);
  if (!index.scenarios.includes(sc.id + ".json")) index.scenarios.push(sc.id + ".json");
  A.addScenarios([sc]); drafts.push(sc.id);
  log(`drafted ${sc.id} with ${claims.length} claims (baseline ${baseId || "unknown"})`);
}
await writeJSON("scenarios/index.json", index);

// 3. Run live packs within budget.
const results = { generatedAt: new Date().toISOString(), newModels: fresh.map(m => ({ provider: m.provider, id: m.id })), scenarios: {} };
const prev = await readJSON("results/latest.json", { scenarios: {} });
const toRun = cfg.autoRun.concat(cfg.autoRunDrafts ? drafts : []);
for (const id of toRun) {
  const sc = A.scenarios().find(s => s.id === id);
  if (!sc) { log(`scenario ${id} not found`); continue; }
  const tasks = 15 + ((sc.livePack && sc.livePack.extraTasks) || []).length;
  let repeats = cfg.runSettings.repeats;
  while (repeats > 1 && sc.models.length * tasks * repeats > cfg.maxCallsPerScenario) repeats--;
  if (sc.models.length * tasks * repeats > cfg.maxCallsPerScenario) { log(`${id} exceeds the call budget even at 1 repeat; skipped`); continue; }
  try {
    log(`running ${id}: ${sc.models.length} models × ${tasks} tasks × ${repeats} repeats`);
    const r = await A.runScenarioHeadless(id, KEYS, Object.assign({}, cfg.runSettings, { repeats }));
    if (r) { results.scenarios[id] = r; log(`${id}: ${r.runs.length} calls, ${r.runs.filter(x => x.error).length} errors`); }
    else log(`${id}: no keys for its providers; skipped`);
  } catch (e) { log(`${id} failed: ${e.message}`); }
}
// Keep earlier results for scenarios not re-run this week.
for (const [id, v] of Object.entries(prev.scenarios || {})) if (!results.scenarios[id]) results.scenarios[id] = v;
await writeJSON("results/latest.json", results);
await writeJSON(`results/${TODAY}.json`, results);

// 4. Render the PDF report from the deployed page itself.
const types = { ".html": "text/html", ".json": "application/json", ".js": "text/javascript", ".css": "text/css", ".pdf": "application/pdf" };
const server = http.createServer(async (req, res) => {
  const u = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const f = path.join(ROOT, u === "/" ? "index.html" : u);
  if (!f.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  try { const b = await fs.readFile(f); res.writeHead(200, { "content-type": types[path.extname(f)] || "application/octet-stream" }).end(b); } catch { res.writeHead(404).end(); }
}).listen(0);
const port = server.address().port;
try {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/index.html?pdf=1#report`);
  await page.waitForFunction("window.__reportReady === true", null, { timeout: 120000 });
  await page.waitForTimeout(1500);
  await fs.mkdir(path.join(ROOT, "reports"), { recursive: true });
  const footer = `<div style="font-size:7px;width:100%;padding:0 14mm;display:flex;justify-content:space-between;color:#565C7D;font-family:sans-serif"><span>Assay | ${cfg.reportTitle}</span><span>${cfg.footerCredit || ""}</span><span class="pageNumber"></span></div>`;
  const opts = { preferCSSPageSize: true, printBackground: true, displayHeaderFooter: true, headerTemplate: "<div></div>", footerTemplate: footer };
  await page.pdf(Object.assign({ path: path.join(ROOT, `reports/assay-report-${TODAY}.pdf`) }, opts));
  await fs.copyFile(path.join(ROOT, `reports/assay-report-${TODAY}.pdf`), path.join(ROOT, "reports/latest.pdf"));
  await browser.close();
  log(`report written to reports/assay-report-${TODAY}.pdf`);
} finally { server.close(); }
