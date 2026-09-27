// Fetches NOTAMs for every airfield in data/ops_hours.json and keeps the ones that can affect
// ATS or fuel availability. Writes data/notams.json. Run hourly by .github/workflows/update-notams.yml.
//
// Source (no key needed): the FAA's public NOTAM Search website (notams.aim.faa.gov), which holds the
// NOTAMs other countries distribute internationally, Norway included. It is not an official API, so the
// page tells users to confirm on IPPC. If repository secrets FAA_CLIENT_ID / FAA_CLIENT_SECRET exist,
// the official FAA NOTAM API is used instead.
// The page shows these as advisories to read; it never changes the published hours from NOTAM text.
import { readFileSync, writeFileSync } from 'node:fs';

const OUT = process.env.NOTAM_OUT || 'data/notams.json';
const OPS = process.env.OPS_FILE || 'data/ops_hours.json';
const SEARCH_URL = process.env.NOTAM_SEARCH_URL || 'https://notams.aim.faa.gov/notamSearch/search';
const API_URL = process.env.FAA_NOTAM_URL || 'https://external-api.faa.gov/notamapi/v1/notams';
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
async function searchBatch(icaos){
  const all = []; let offset = 0;
  for(let page = 0; page < 20; page++){
    const body = new URLSearchParams({ searchType: '0', designatorsForLocation: icaos.join(','), offset: String(offset),
      notamsOnly: 'false', radius: '10', sortColumns: '5 false', sortDirection: 'true', designatorForAccountable: '',
      latDegrees: '', latMinutes: '0', latSeconds: '0', longDegrees: '', longMinutes: '0', longSeconds: '0', latitudeDirection: 'N', longitudeDirection: 'W' });
    const res = await fetch(SEARCH_URL, { method: 'POST', body, signal: AbortSignal.timeout(30000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0 (AW169 tools NOTAM check; GitHub Actions)' } });
    if(!res.ok) throw new Error(`HTTP ${res.status}`);
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

// ---------- source 2: official FAA NOTAM API (only if secrets are set) ----------
async function apiOne(icao, id, secret){
  const res = await fetch(`${API_URL}?icaoLocation=${icao}&responseFormat=geoJson&pageSize=1000`, { signal: AbortSignal.timeout(30000), headers: { client_id: id, client_secret: secret } });
  if(!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  return (json.items || []).map(f => {
    const core = f.properties?.coreNOTAMData || {}, x = core.notam || {};
    const icaoTxt = (core.notamTranslation || []).find(t => /ICAO/i.test(t.type))?.formattedText;
    const n = icaoTxt ? parseIcao(icaoTxt) : { id: x.number, selectionCode: x.selectionCode, start: x.effectiveStart, end: /PERM/i.test(x.effectiveEnd) ? null : x.effectiveEnd, text: x.text, icao: x.text };
    n.location = n.location || x.icaoLocation || icao; return n;
  });
}

if(import.meta.url === `file://${process.argv[1]}`){
  const icaos = Object.keys(JSON.parse(readFileSync(OPS, 'utf8')).fields).concat((process.env.EXTRA_ICAO || '').split(',').filter(Boolean));
  const useApi = process.env.FAA_CLIENT_ID && process.env.FAA_CLIENT_SECRET;
  const fields = Object.fromEntries(icaos.map(i => [i, []])), errors = [];
  let ok = 0;
  if(useApi){
    for(const icao of icaos){
      try{ fields[icao] = keep(await apiOne(icao, process.env.FAA_CLIENT_ID, process.env.FAA_CLIENT_SECRET)); ok++; }
      catch(e){ errors.push(`${icao}: ${e.message}`); delete fields[icao]; }
      await new Promise(r => setTimeout(r, 250));
    }
  } else {
    for(let i = 0; i < icaos.length; i += BATCH){
      const batch = icaos.slice(i, i + BATCH);
      try{
        const list = keep(await searchBatch(batch));
        for(const n of list){ const k = batch.includes(n.location) ? n.location : null; if(k) fields[k].push(n); }
        ok += batch.length;
      } catch(e){ batch.forEach(k => { errors.push(`${k}: ${e.message}`); delete fields[k]; }); }
      await new Promise(r => setTimeout(r, 600));
    }
  }
  if(!ok){ console.error('Every request failed:', errors[0]); process.exit(1); }   // keep the last good file
  const source = useApi ? 'FAA NOTAM API' : 'FAA NOTAM Search (internationally distributed NOTAMs)';
  writeFileSync(OUT, JSON.stringify({ source, fetched: new Date().toISOString(), errors, fields }, null, 1));
  console.log(`${source}: ${ok}/${icaos.length} airfields, ${Object.values(fields).flat().length} relevant NOTAMs, ${errors.length} errors`);
}
