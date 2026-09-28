// Fetches NOTAMs for every airfield in data/ops_hours.json and keeps the ones that can affect
// ATS or fuel availability. Writes data/notams.json. Run hourly by .github/workflows/update-notams.yml.
//
// Source (no key needed): the FAA's public NOTAM Search website (notams.aim.faa.gov), which holds the
// NOTAMs other countries distribute internationally, Norway included. It is not an official API, so the
// page tells users to confirm on IPPC. Like the site's own search page, the job opens the page first to get
// a session, then searches. If the FAA refuses (HTTP 403), the log shows the reply so we can see why.
// The page shows these as advisories to read; it never changes the published hours from NOTAM text.
import { readFileSync, writeFileSync } from 'node:fs';

const OUT = process.env.NOTAM_OUT || 'data/notams.json';
const OPS = process.env.OPS_FILE || 'data/ops_hours.json';
const SEARCH_URL = process.env.NOTAM_SEARCH_URL || 'https://notams.aim.faa.gov/notamSearch/search';
const PAGE_URL = process.env.NOTAM_PAGE_URL || 'https://notams.aim.faa.gov/notamSearch/nsapp.html';
const UA = 'AW169-tools NOTAM check (GitHub Actions; https://github.com/tomandreas/Airlift-AW169Calculator)';
const BATCH = 8;   // airfields per request to the search site

// ---------- ICAO NOTAM fields ----------
const t10 = s => { if(!s) return null; const m = s.match(/^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/); return m ? new Date(Date.UTC(2000 + +m[1], m[2]-1, +m[3], +m[4], +m[5])).toISOString() : null; };
export function parseIcao(txt){
  const s = String(txt || '').replace(/\r/g, '');
  const id = (s.match(/\b([A-Z]\d{4}\/\d{2})\b/) || [])[1] || '';
  const q  = (s.match(/Q\)\s*[A-Z]{4}\/(Q[A-Z]{4})\b/) || [])[1] || '';
  const a  = (s.match(/A\)\s*([A-Z]{4})/) || [])[1] || '';
  const b  = (s.match(/B\)\s*(\d{10})/) || [])[1];
  const cM = s.match(/C\)\s*(\d{10}|PERM)(\s*EST)?/);
  const d  = ((s.match(/D\)\s*([\s\S]*?)\s*E\)/) || [])[1] || '').replace(/\s+/g, ' ').trim();
  const e  = ((s.match(/E\)\s*([\s\S]*?)(?:\s+[FG]\)\s|$)/) || [])[1] || '').replace(/\s+/g, ' ').trim();
  return { id, selectionCode: q, location: a, start: t10(b), end: cM && cM[1] !== 'PERM' ? t10(cM[1]) : null,
           permanent: !!cM && cM[1] === 'PERM', estimated: !!(cM && cM[2]), schedule: d, text: e, icao: s.trim() };
}

// ---------- what counts as relevant ----------
const FUEL_TXT  = /\b(FUEL|JET\s?A-?1|REFUEL(?:L?ING)?|AVGAS|F-?34|DEFUEL(?:L?ING)?)\b/;
const ATS_TXT   = /\b(ATS|AFIS|TWR|TOWER|APP|ATC|A\/G|AD|AERODROME|AIRPORT)\b/;
const HOURS_TXT = /\b(HR|HRS|HOURS?|OPR|OPS|OPENING|OPEN|CLSD|CLOSED|NOT\s+AVBL|U\/S|EXTENDED|SER(?:VICE)?|AVBL\s+O\/R|OUTSIDE)\b/;
const NOT_ATS   = /\b(RWY|TWY|APRON|OBST|CRANE|LGT|PAPI|ILS|VOR|DME|NDB|GNSS|GPS|RNAV|RNP)\b/;
export function classify(n){
  const q = (n.selectionCode || '').toUpperCase(), t = ` ${(n.text || '').toUpperCase()} `, cats = [];
  if(q.startsWith('QFU') || FUEL_TXT.test(t)) cats.push('fuel');
  const atsQ = /^Q(ST|SF|SA|SP|SC|FA)/.test(q) && /(AH|AL|LC|LT|HX|HW|AS|AU|CH|CC|XX)$/.test(q);
  if(atsQ || (ATS_TXT.test(t) && HOURS_TXT.test(t) && !NOT_ATS.test(t)) || /\bAD\s+(CLSD|CLOSED)\b|HR\s+OF\s+(OPS|SER)\b/.test(t)) cats.push('ats');
  return cats;
}
const keep = list => list.filter(n => n.text).map(n => ({ ...n, cats: classify(n) })).filter(n => n.cats.length);

// ---------- source 1: FAA NOTAM Search website (no key) ----------
export function fromSearch(json){
  return (json.notamList || []).map(x => {
    const n = parseIcao(x.icaoMessage || '');
    if(!n.text) n.text = x.traditionalMessageFrom4thWord || x.traditionalMessage || '';
    n.location = n.location || x.icaoId || x.facilityDesignator || '';
    n.id = n.id || x.notamNumber || '';
    return n;
  });
}
let COOKIE = '';
async function openSession(){
  const res = await fetch(PAGE_URL, { signal: AbortSignal.timeout(30000), headers: { 'User-Agent': UA, 'Accept': 'text/html' } });
  const set = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean);
  COOKIE = set.map(c => c.split(';')[0]).join('; ');
  console.log(`Session: HTTP ${res.status}, ${set.length} cookie(s)`);
  if(res.status === 403) throw new Error(`HTTP 403 on the search page itself: ${(await res.text()).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160)}`);
}
async function searchBatch(icaos){
  const all = []; let offset = 0;
  for(let page = 0; page < 20; page++){
    const body = new URLSearchParams({ searchType: '0', designatorsForLocation: icaos.join(','), offset: String(offset),
      notamsOnly: 'false', radius: '10', sortColumns: '5 false', sortDirection: 'true', designatorForAccountable: '',
      latDegrees: '', latMinutes: '0', latSeconds: '0', longDegrees: '', longMinutes: '0', longSeconds: '0', latitudeDirection: 'N', longitudeDirection: 'W' });
    const res = await fetch(SEARCH_URL, { method: 'POST', body, signal: AbortSignal.timeout(30000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'Accept': 'application/json, text/javascript, */*; q=0.01',
                 'X-Requested-With': 'XMLHttpRequest', 'Origin': new URL(SEARCH_URL).origin, 'Referer': PAGE_URL, 'User-Agent': UA,
                 ...(COOKIE ? { Cookie: COOKIE } : {}) } });
    if(!res.ok){
      const why = (await res.text()).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
      throw new Error(`HTTP ${res.status}${why ? ` (${why})` : ''}`);
    }
    const json = await res.json();
    if(json.error) throw new Error(String(json.error).slice(0, 120));
    const got = fromSearch(json); all.push(...got);
    const total = +json.totalNotamCount || got.length, end = +json.endRecordCount || offset + got.length;
    if(!got.length || end >= total) break;
    offset = end;
    await new Promise(r => setTimeout(r, 400));
  }
  return all;
}

if(import.meta.url === `file://${process.argv[1]}`){
  const icaos = Object.keys(JSON.parse(readFileSync(OPS, 'utf8')).fields).concat((process.env.EXTRA_ICAO || '').split(',').filter(Boolean));
  const fields = Object.fromEntries(icaos.map(i => [i, []])), errors = [];
  let ok = 0;
  try{ await openSession(); }
  catch(e){ console.error(`FAA NOTAM Search refused the request: ${e.message}`); process.exit(1); }   // keeps the last good file
  for(let i = 0; i < icaos.length; i += BATCH){
    const batch = icaos.slice(i, i + BATCH);
    try{
      const list = keep(await searchBatch(batch));
      for(const n of list){ if(batch.includes(n.location)) fields[n.location].push(n); }
      ok += batch.length;
    } catch(e){ batch.forEach(k => { errors.push(`${k}: ${e.message}`); delete fields[k]; }); if(!ok && /403/.test(e.message)) break; }   // refused outright: stop asking
    await new Promise(r => setTimeout(r, 600));
  }
  if(!ok){ console.error('Every request failed:', errors[0]); process.exit(1); }   // keep the last good file
  const source = 'FAA NOTAM Search (internationally distributed NOTAMs)';
  writeFileSync(OUT, JSON.stringify({ source, fetched: new Date().toISOString(), errors, fields }, null, 1));
  console.log(`${source}: ${ok}/${icaos.length} airfields, ${Object.values(fields).flat().length} relevant NOTAMs, ${errors.length} errors`);
}
