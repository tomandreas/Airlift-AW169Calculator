// Fetches Avinor's AD 2.3 operational hours page and writes data/ops_hours.json
// (ATS and fuel only). Run by .github/workflows/update-ops-hours.yml. No dependencies (Node 20+).
//
// Avinor publishes every revision under a new edition number in the URL (.../Index/83/ops_hrs.html).
// An old edition does NOT return an error: it answers 200 with a "new OPR HRS available" notice page.
// So this script
//   1. starts from the last URL that worked (stored in the data file), not a hard-coded edition,
//   2. follows the "newer edition" link if it lands on that notice page,
//   3. falls back to trying the next edition numbers if the notice has no usable link,
//   4. retries temporary network / server errors,
//   5. otherwise stops with a clear error and leaves the last good data file untouched.
import { writeFileSync, readFileSync, existsSync } from 'node:fs';

const DEFAULT_URL = 'https://aim-prod.avinor.no/no/OperationalHours/View/Index/83/ops_hrs.html';  // only used on the very first run
const OUT = process.env.OPS_OUT || 'data/ops_hours.json';
const MIN_FIELDS = 40;     // sanity check: refuse to publish if a table comes back short
const MAX_HOPS = 5;        // "newer edition" notices followed in a row
const PROBE_AHEAD = 12;    // edition numbers tried beyond the starting one if no link is found
const RETRIES = 3;         // attempts per page for network errors, HTTP 5xx and 429
const RETRY_MS = +process.env.OPS_RETRY_MS || 3000;
const HEADERS = { 'User-Agent': 'AW169-tools opening-hours updater (GitHub Actions)' };
const EDITION = /\/Index\/(\d+)\/ops_hrs\.html/;

const decode = s => s
  .replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&(oslash|Oslash|aring|Aring|aelig|AElig);/g, (_, e) => ({ oslash:'ø', Oslash:'Ø', aring:'å', Aring:'Å', aelig:'æ', AElig:'Æ' })[e])
  .replace(/\s+/g, ' ').trim();

export function parseSection(html, title){
  // the section runs from its heading to the next "Operational hours:" heading
  const start = html.search(new RegExp(`Operational\\s+hours:\\s*${title}\\b`, 'i'));
  if(start < 0) throw new Error(`Section "${title}" not found`);
  const rest = html.slice(start + 10), next = rest.search(/Operational\s+hours:/i);
  const sec = next >= 0 ? rest.slice(0, next) : rest;
  const out = {}; let last = null;
  for(const row of sec.match(/<tr[\s\S]*?<\/tr>/gi) || []){
    const cells = (row.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi) || []).map(decode);
    const k = cells.findIndex(c => /^EN[A-Z]{2}$/.test(c));
    if(k >= 0 && cells[k+1] !== undefined){ last = cells[k]; out[last] = { name: cells[k-1] || '', hr: cells[k+1], rmk: '' }; continue; }
    const r = cells.findIndex(c => /^RMK:?$/i.test(c));
    if(r >= 0 && last){ const txt = cells.slice(r+1).filter(Boolean).join(' '); out[last].rmk = /^NIL$/i.test(txt) ? '' : txt; }
  }
  return out;
}

export function build(html, source = DEFAULT_URL){
  const ats = parseSection(html, 'ATS'), fuel = parseSection(html, 'Fuel');
  if(Object.keys(ats).length < MIN_FIELDS || Object.keys(fuel).length < MIN_FIELDS)
    throw new Error(`Too few airfields parsed (ATS ${Object.keys(ats).length}, fuel ${Object.keys(fuel).length}); page layout may have changed`);
  const rev = decode(html).match(/Revised per (AIRAC [0-9]{1,2} [A-Z]{3} [0-9]{4})/i);
  const fields = {};
  for(const icao of [...new Set([...Object.keys(ats), ...Object.keys(fuel)])].sort())
    fields[icao] = { name: (ats[icao] || fuel[icao]).name,
      ats: ats[icao] ? { hr: ats[icao].hr, rmk: ats[icao].rmk } : null,
      fuel: fuel[icao] ? { hr: fuel[icao].hr, rmk: fuel[icao].rmk } : null };
  return { source, revised: rev ? rev[1] : '', fetched: new Date().toISOString(), fields };
}

// ---- fetching: find the current edition ----------------------------------------------------
const sleep = ms => new Promise(r => setTimeout(r, ms));
const isHoursPage = html => /Operational\s+hours:\s*ATS\b/i.test(html) && /Operational\s+hours:\s*Fuel\b/i.test(html);
const editionOf = url => +((url.match(EDITION) || [])[1]) || 0;

// Where to start: an explicit OPS_URL, else the URL that worked last time, else the built-in default.
export function pickSeed(env, prev){
  if(env) return env;
  const s = prev && !prev.snapshot && typeof prev.source === 'string' ? prev.source : '';
  return s.startsWith(new URL(DEFAULT_URL).origin + '/') && EDITION.test(s) ? s : DEFAULT_URL;
}

// The notice page links to the current edition; take the highest edition newer than the one we asked for.
export function newerEditionLink(html, from){
  let best = null;
  for(const m of html.matchAll(/\/(?:no|en)\/OperationalHours\/View\/Index\/(\d+)\/ops_hrs\.html/gi)){
    const n = +m[1];
    if(n > editionOf(from) && (!best || n > best.n)) best = { n, path: m[0] };
  }
  return best ? new URL(best.path, from).href : null;
}

// One page, with retries for temporary problems. A 4xx answer is final (error.permanent).
async function fetchPage(url, tries = RETRIES, timeout = 60000){
  let err;
  for(let i = 1; i <= tries; i++){
    try{
      const res = await fetch(url, { signal: AbortSignal.timeout(timeout), headers: HEADERS });
      if(res.ok) return await res.text();
      err = new Error(`HTTP ${res.status} from ${url}`);
      if(res.status < 500 && res.status !== 429) throw Object.assign(err, { permanent: true });
    }catch(e){
      if(e.permanent) throw e;
      err = new Error(`${e.message}${e.cause ? ` (${e.cause.code || e.cause.message})` : ''} for ${url}`);
    }
    if(i < tries){ console.log(`Attempt ${i} failed: ${err.message}; retrying`); await sleep(RETRY_MS * i); }
  }
  throw err;
}

async function locate(seed){
  const tried = new Set(); let url = seed, why = '';
  for(let hop = 0; hop <= MAX_HOPS; hop++){
    tried.add(url);
    let html;
    try{ html = await fetchPage(url); }
    catch(e){ if(!e.permanent) throw e; why = e.message; break; }   // 4xx: the edition may be gone, try the next ones
    if(isHoursPage(html)) return { url, html };
    const next = newerEditionLink(html, url);
    if(!next || tried.has(next)){ why = `${url} is not the hours page and links to no newer edition`; break; }
    console.log(`Edition outdated: ${url} -> ${next}`);
    url = next;
  }
  const base = editionOf(seed);                                      // fallback: probe the following editions
  for(let n = base + 1; base && n <= base + PROBE_AHEAD; n++){
    const u = seed.replace(EDITION, `/Index/${n}/ops_hrs.html`);
    if(tried.has(u)) continue;
    try{
      const html = await fetchPage(u, 1, 20000);
      if(isHoursPage(html)){ console.log(`Found edition ${n} by probing`); return { url: u, html }; }
    }catch{}
  }
  throw new Error(`No current operational-hours page found (started at ${seed}; ${why || 'gave up'}). Avinor may have changed the page or its URL scheme.`);
}

async function main(){
  const prev = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : null;
  const { url, html } = await locate(pickSeed(process.env.OPS_URL, prev));
  console.log(`Using ${url}`);
  const data = build(html, url);
  // Write once per day even when nothing changed, so the page can show when the hours were last checked
  const same = prev && JSON.stringify(prev.fields) === JSON.stringify(data.fields) && prev.revised === data.revised;
  const sameDay = prev && !prev.snapshot && String(prev.fetched || '').slice(0, 10) === data.fetched.slice(0, 10);
  if(same && sameDay){ console.log('Already checked today, no change'); return; }
  if(same) data.changed = prev.changed || prev.fetched;          // keep the date the hours last changed
  else data.changed = data.fetched;
  writeFileSync(OUT, JSON.stringify(data, null, 1));
  console.log(same ? `Checked ${Object.keys(data.fields).length} airfields: no change (${data.revised})` : `Hours changed: wrote ${Object.keys(data.fields).length} airfields, ${data.revised}`);
}

if(import.meta.url === `file://${process.argv[1]}`){
  main().catch(e => {
    // the ::error line shows up in the run's Annotations, so the reason is visible without opening the log
    console.error(`::error title=Avinor opening hours update failed::${String(e.message).replace(/\s+/g, ' ')}`);
    console.error('The existing data file was left unchanged.');
    process.exit(1);
  });
}
