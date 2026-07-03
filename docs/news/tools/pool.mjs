#!/usr/bin/env node
// 뉴스 풀 사람용 뷰어/변환 도구 — 의존성 없음(순수 Node).
//   node tools/pool.mjs list            콘솔 표
//   node tools/pool.mjs csv [out.csv]   pool.jsonl → CSV (엑셀, UTF-8 BOM)
//   node tools/pool.mjs import <in.csv> CSV → pool.jsonl (역파싱·덮어씀)
//   node tools/pool.mjs html [out.html] pool.jsonl → 자체 HTML 웹뷰(필터/검색)
// 실행 위치 무관 — pool.jsonl 은 이 스크립트 기준 ../pool.jsonl.
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const HERE = dirname(fileURLToPath(import.meta.url));
const POOL = resolve(HERE, '..', 'pool.jsonl');
// CSV/HTML 열 순서(스키마). id 는 매칭 키라 반드시 유지.
const COLS = ['id', 'scenario', 'scope', 'target', 'pct', 'polarity', 'status', 'text', 'notes'];
const NUM = new Set(['pct']);

function readPool() {
  const raw = readFileSync(POOL, 'utf8');
  return raw.split('\n').map((l) => l.trim()).filter(Boolean).map((l, i) => {
    try { return JSON.parse(l); } catch (e) { throw new Error(`pool.jsonl ${i + 1}행 JSON 파싱 실패: ${e.message}`); }
  });
}
function writePool(rows) {
  const body = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
  writeFileSync(POOL, body, 'utf8');
}

// ── CSV (RFC4180): 필드에 , " 개행 있으면 "..."로 감싸고 " 는 "" 로 이스케이프 ──
function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replaceAll('"', '""') + '"' : s;
}
function toCsv(rows) {
  const lines = [COLS.join(',')];
  for (const r of rows) lines.push(COLS.map((c) => csvCell(r[c])).join(','));
  return '﻿' + lines.join('\r\n') + '\r\n'; // BOM: 엑셀 한글 안 깨짐
}
function parseCsv(text) {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1); // BOM 제거
  const rows = []; let row = []; let cell = ''; let q = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i += 1; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell); cell = ''; rows.push(row); row = [];
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.length && !(r.length === 1 && r[0] === ''));
}
function fromCsv(text) {
  const grid = parseCsv(text);
  if (!grid.length) return [];
  const header = grid[0];
  return grid.slice(1).map((cells) => {
    const o = {};
    header.forEach((h, i) => {
      const key = h.trim(); let val = cells[i] ?? '';
      if (NUM.has(key)) o[key] = Number(val) || 0;
      else if (key === 'target') o[key] = val === '' ? null : val;
      else o[key] = val;
    });
    return o;
  });
}

// ── 콘솔 표 ──
function list(rows) {
  const w = { id: 10, scenario: 16, scope: 6, target: 8, pct: 4, polarity: 6, status: 9 };
  const head = ['id', 'scenario', 'scope', 'target', 'pct', 'polarity', 'status', 'text'];
  const pad = (v, n) => String(v == null ? '' : v).padEnd(n).slice(0, n);
  console.log(head.map((h) => pad(h, w[h] || 0)).join(' ') || '', 'text');
  const by = {};
  for (const r of rows) (by[r.status] ||= []).push(r);
  for (const st of ['draft', 'scheduled', 'published', 'archived']) {
    for (const r of (by[st] || [])) {
      console.log([
        pad(r.id, w.id), pad(r.scenario, w.scenario), pad(r.scope, w.scope),
        pad(r.target, w.target), pad(r.pct, w.pct), pad(r.polarity, w.polarity),
        pad(r.status, w.status),
      ].join(' '), r.text);
    }
  }
  const counts = rows.reduce((a, r) => { a[r.status] = (a[r.status] || 0) + 1; return a; }, {});
  console.log('\n총', rows.length, '건 —', JSON.stringify(counts));
}

// ── 자체 HTML 웹뷰(데이터 인라인, 무외부의존, 필터/검색) ──
function toHtml(rows) {
  const data = JSON.stringify(rows).replaceAll('<', '\\u003c');
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>HK_Stock 뉴스 풀</title>
<style>
:root{color-scheme:light dark}
body{font:14px/1.5 system-ui,'Malgun Gothic',sans-serif;margin:0;padding:16px;background:Canvas;color:CanvasText}
h1{font-size:18px;margin:0 0 12px}
.bar{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;align-items:center}
select,input{font:inherit;padding:4px 6px;border:1px solid gray;border-radius:6px;background:Canvas;color:CanvasText}
.wrap{overflow-x:auto}
table{border-collapse:collapse;width:100%;min-width:760px}
th,td{border:1px solid #8884;padding:6px 8px;text-align:left;vertical-align:top}
th{position:sticky;top:0;background:Canvas;cursor:pointer}
td.text{min-width:280px}
.pill{padding:1px 8px;border-radius:10px;font-size:12px;white-space:nowrap}
.good{background:#e0402022;color:#e04020}.bad{background:#1060e022;color:#1060e0}.flat{background:#8884}
.st-draft{opacity:.55}.num{text-align:right;font-variant-numeric:tabular-nums}
.count{color:GrayText;margin-left:auto}
</style></head><body>
<h1>HK_Stock 뉴스 풀 <span class="count" id="cnt"></span></h1>
<div class="bar">
 <input id="q" placeholder="검색(text·notes·id)" size="24">
 <select id="fScenario"><option value="">시나리오 전체</option></select>
 <select id="fScope"><option value="">scope 전체</option></select>
 <select id="fStatus"><option value="">status 전체</option></select>
 <select id="fPol"><option value="">극성 전체</option><option>good</option><option>bad</option><option>flat</option></select>
</div>
<div class="wrap"><table><thead><tr id="hr"></tr></thead><tbody id="tb"></tbody></table></div>
<script>
const DATA=${data};
const COLS=${JSON.stringify(COLS)};
const $=(id)=>document.getElementById(id);
let sortKey='id',sortDir=1;
function uniq(k){return [...new Set(DATA.map(r=>r[k]).filter(v=>v!=null&&v!==''))].sort()}
for(const s of uniq('scenario')) $('fScenario').add(new Option(s,s));
for(const s of uniq('scope')) $('fScope').add(new Option(s,s));
for(const s of uniq('status')) $('fStatus').add(new Option(s,s));
$('hr').innerHTML=COLS.map(c=>'<th data-k="'+c+'">'+c+'</th>').join('');
$('hr').querySelectorAll('th').forEach(th=>th.onclick=()=>{const k=th.dataset.k;sortDir=sortKey===k?-sortDir:1;sortKey=k;render()});
['q','fScenario','fScope','fStatus','fPol'].forEach(id=>$(id).oninput=render);
function render(){
 const q=$('q').value.toLowerCase();
 const fSc=$('fScenario').value,fSp=$('fScope').value,fSt=$('fStatus').value,fP=$('fPol').value;
 let rows=DATA.filter(r=>
   (!fSc||r.scenario===fSc)&&(!fSp||r.scope===fSp)&&(!fSt||r.status===fSt)&&(!fP||r.polarity===fP)&&
   (!q||[r.text,r.notes,r.id].some(v=>String(v||'').toLowerCase().includes(q))));
 rows=rows.slice().sort((a,b)=>{const x=a[sortKey],y=b[sortKey];return (x>y?1:x<y?-1:0)*sortDir});
 $('tb').innerHTML=rows.map(r=>'<tr class="st-'+r.status+'">'+COLS.map(c=>{
   if(c==='polarity')return '<td><span class="pill '+r.polarity+'">'+r.polarity+'</span></td>';
   if(c==='pct')return '<td class="num">'+(r.pct>0?'+':'')+r.pct+'</td>';
   if(c==='text')return '<td class="text">'+esc(r.text)+'</td>';
   return '<td>'+esc(r[c]==null?'':r[c])+'</td>';
 }).join('')+'</tr>').join('');
 $('cnt').textContent=rows.length+' / '+DATA.length+'건';
}
function esc(s){return String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}
render();
</script></body></html>`;
}

// ── 진입 ──
const [cmd, arg] = process.argv.slice(2);
try {
  if (cmd === 'list') { list(readPool()); }
  else if (cmd === 'csv') {
    const out = resolve(HERE, '..', arg || 'pool.csv');
    writeFileSync(out, toCsv(readPool()), 'utf8');
    console.log('CSV 작성:', out, '(엑셀에서 열어 편집 후 import 로 되돌리기)');
  } else if (cmd === 'import') {
    if (!arg) throw new Error('import 할 CSV 경로가 필요합니다.');
    const rows = fromCsv(readFileSync(resolve(process.cwd(), arg), 'utf8'));
    if (!rows.length) throw new Error('CSV에서 읽은 행이 없습니다.');
    writePool(rows);
    console.log('pool.jsonl 갱신:', rows.length, '건 (역파싱 완료)');
  } else if (cmd === 'html') {
    const out = resolve(HERE, '..', arg || 'pool.html');
    writeFileSync(out, toHtml(readPool()), 'utf8');
    console.log('HTML 웹뷰 작성:', out, '(브라우저로 열기 — 필터/검색/정렬)');
  } else {
    console.log('사용법: node tools/pool.mjs <list|csv|import <file>|html> [out]');
    process.exit(cmd ? 1 : 0);
  }
} catch (e) { console.error('[오류]', e.message || e); process.exit(1); }
