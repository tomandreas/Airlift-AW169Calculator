// Fetches Avinor's AD 2.3 operational hours page and writes data/ops_hours.json
// (ATS and fuel only). Run by .github/workflows/update-ops-hours.yml. No dependencies (Node 20+).
import { writeFileSync, readFileSync, existsSync } from 'node:fs';

const URL = process.env.OPS_URL || 'https://aim-prod.avinor.no/no/OperationalHours/View/Index/83/ops_hrs.html';
const OUT = process.env.OPS_OUT || 'data/ops_hours.json';
const MIN_FIELDS = 40;   // sanity check: refuse to publish if a table comes back short

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

export function build(html){
  const ats = parseSection(html, 'ATS'), fuel = parseSection(html, 'Fuel');
  if(Object.keys(ats).length < MIN_FIELDS || Object.keys(fuel).length < MIN_FIELDS)
    throw new Error(`Too few airfields parsed (ATS ${Object.keys(ats).length}, fuel ${Object.keys(fuel).length}); page layout may have changed`);
  const rev = decode(html).match(/Revised per (AIRAC [0-9]{1,2} [A-Z]{3} [0-9]{4})/i);
  const fields = {};
  for(const icao of [...new Set([...Object.keys(ats), ...Object.keys(fuel)])].sort())
    fields[icao] = { name: (ats[icao] || fuel[icao]).name,
      ats: ats[icao] ? { hr: ats[icao].hr, rmk: ats[icao].rmk } : null,
      fuel: fuel[icao] ? { hr: fuel[icao].hr, rmk: fuel[icao].rmk } : null };
  return { source: URL, revised: rev ? rev[1] : '', fetched: new Date().toISOString(), fields };
}

if(import.meta.url === `file://${process.argv[1]}`){
  const res = await fetch(URL, { signal: AbortSignal.timeout(60000), headers: { 'User-Agent': 'AW169-tools opening-hours updater (GitHub Actions)' } });
  if(!res.ok) throw new Error(`HTTP ${res.status} from ${URL}`);
  const data = build(await res.text());
  // Write once per day even when nothing changed, so the page can show when the hours were last checked
  const prev = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : null;
  const same = prev && JSON.stringify(prev.fields) === JSON.stringify(data.fields) && prev.revised === data.revised;
  const sameDay = prev && !prev.snapshot && String(prev.fetched || '').slice(0, 10) === data.fetched.slice(0, 10);
  if(same && sameDay){ console.log('Already checked today, no change'); process.exit(0); }
  if(same) data.changed = prev.changed || prev.fetched;          // keep the date the hours last changed
  else data.changed = data.fetched;
  writeFileSync(OUT, JSON.stringify(data, null, 1));
  console.log(same ? `Checked ${Object.keys(data.fields).length} airfields: no change (${data.revised})` : `Hours changed: wrote ${Object.keys(data.fields).length} airfields, ${data.revised}`);
}
