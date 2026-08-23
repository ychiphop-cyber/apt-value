'use strict';
/* ═══════════════════════════════════════════════════════════════════
   임대료 과거 실적 수집기 — 10년 전 같은 분기의 전월세 실거래를 수집해
   단지·평형별 과거 전세 보증금과 구 단위 ㎡당 보증금 지수를 만든다.
   결과화면 §C "지난 10년 실적" (g_hist)의 원천 데이터.

   사용:  node pipeline/rent_history.js                # enabled 지역 전체
          node pipeline/rent_history.js --regions=11740
   출력:  data/rent_history/{code}.json
          { meta:{oldQ, oldMonths, asOf},
            gu: { depM2Old, nOld, depM2Now, nNow, gHist },     // ㎡당 보증금(억) 중앙값 · 연 성장률
            cx: { "동|단지명": { "84": { old: 5.2, n: 3 } } } } // 과거 전세 보증금 중앙값(억)
   원칙: 과거·현재 모두 순수 전세(월세 0)만, 같은 방식(보증금 기준)으로 비교한다.
   전환율 변화는 반영하지 않는다 — 접힘 영역에 명시. 취소(cdealType)는 전월세에 없음.
   ═══════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'data', 'rent_history');
const LIVE_DIR = path.join(ROOT, 'data', 'live');
const REGIONS = JSON.parse(fs.readFileSync(path.join(__dirname, 'regions.json'), 'utf8'));

const BASE = 'https://apis.data.go.kr/1613000';
const EP_RENT = 'RTMSDataSvcAptRent/getRTMSDataSvcAptRent';
const ROWS = 1000;
const YEARS_BACK = 10;

function args() {
  const a = {};
  for (const s of process.argv.slice(2)) {
    const m = s.match(/^--([^=]+)(?:=(.*))?$/);
    if (m) a[m[1]] = m[2] === undefined ? true : m[2];
  }
  return a;
}
function resolveKey(a) {
  if (a.key) return a.key;
  if (process.env.DATA_GO_KR_KEY) return process.env.DATA_GO_KR_KEY;
  if (process.env.MOLIT_API_KEY) return process.env.MOLIT_API_KEY;
  const f = path.join(ROOT, '.molit-key');
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  return '';
}
const num = s => { const n = parseFloat(String(s ?? '').replace(/[, ]/g, '')); return isFinite(n) ? n : null; };
const tag = (xml, name) => { const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`)); return m ? m[1].trim() : ''; };
const median = arr => {
  const s = arr.slice().sort((a, b) => a - b);
  if (!s.length) return null;
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

function parseRentItems(xml) {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml))) {
    const x = m[1];
    items.push({
      aptNm: tag(x, 'aptNm') || tag(x, '아파트'),
      umdNm: tag(x, 'umdNm') || tag(x, '법정동'),
      m2: num(tag(x, 'excluUseAr') || tag(x, '전용면적')),
      deposit: num(tag(x, 'deposit') || tag(x, '보증금액')),
      monthlyRent: num(tag(x, 'monthlyRent') || tag(x, '월세금액')),
      contractType: tag(x, 'contractType')
    });
  }
  return items;
}
function checkResult(xml) {
  const code = tag(xml, 'resultCode') || tag(xml, 'returnReasonCode');
  const msg = tag(xml, 'resultMsg') || [tag(xml, 'errMsg'), tag(xml, 'returnAuthMsg')].filter(Boolean).join(' ');
  if (code && !/^0+$/.test(code)) return { ok: false, fatal: /SERVICE|KEY|REQUESTS|REGISTERED|USE/i.test(msg + code), msg: `${code} ${msg}` };
  return { ok: true };
}

async function fetchMonth(key, lawd, ymd, log) {
  const enc = /%[0-9A-Fa-f]{2}/.test(key) ? key : encodeURIComponent(key);
  const out = [];
  let page = 1, total = Infinity, calls = 0;
  while ((page - 1) * ROWS < total && page <= 8) {
    const url = `${BASE}/${EP_RENT}?serviceKey=${enc}&LAWD_CD=${lawd}&DEAL_YMD=${ymd}&numOfRows=${ROWS}&pageNo=${page}`;
    let xml = null;
    for (let att = 1; att <= 3; att++) {
      try {
        const res = await fetch(url, { headers: { accept: 'application/xml' }, signal: AbortSignal.timeout(15000) });
        calls++;
        xml = await res.text();
        break;
      } catch (e) {
        if (att === 3) throw new Error(`네트워크 오류(${lawd} ${ymd}): ${e.message}`);
        await new Promise(r => setTimeout(r, 1500 * att));
      }
    }
    const chk = checkResult(xml);
    if (!chk.ok) {
      if (chk.fatal) throw new Error(`API 오류(${lawd} ${ymd}): ${chk.msg}`);
      log(`  ! ${lawd} ${ymd}: ${chk.msg} — 건너뜀`);
      return { items: [], calls };
    }
    total = num(tag(xml, 'totalCount')) ?? 0;
    out.push(...parseRentItems(xml));
    page++;
  }
  return { items: out, calls };
}

const areaKey = m2 => String(Math.floor(m2));

/* 현재 구 지수: live 샤드 jeonseRaw(최근 6개월)로 ㎡당 보증금 중앙값 */
function nowGuIndex(shard, nowYM) {
  const ymNum = ym => { const [a, b] = ym.split('-').map(Number); return a * 12 + b; };
  const nowN = ymNum(nowYM);
  const perM2 = [];
  for (const cx of Object.values(shard.complexes)) {
    for (const ar of Object.values(cx.areas)) {
      const m2 = ar.m2 > 0 ? ar.m2 : null;
      if (!m2) continue;
      for (const r of (ar.jeonseRaw || [])) {
        if (nowN - ymNum(r.ym) <= 6 && r.v > 0) perM2.push(r.v / m2);
      }
    }
  }
  return { depM2Now: median(perM2), nNow: perM2.length };
}

async function main() {
  const a = args();
  const log = s => console.log(s);
  const key = resolveKey(a);
  if (!key) { console.error('키 없음 (.molit-key)'); process.exit(1); }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const now = new Date();
  const nowYM = a.now || now.toISOString().slice(0, 7);
  const oldYear = Number(nowYM.slice(0, 4)) - YEARS_BACK;
  // 10년 전 같은 분기 (3개월) — 기준월 포함 직전 분기
  const baseMo = Number(nowYM.slice(5, 7));
  const q0 = Math.floor((baseMo - 1) / 3) * 3 + 1;   // 분기 시작월
  const oldMonths = [0, 1, 2].map(i => `${oldYear}${String(q0 + i).padStart(2, '0')}`);

  const wanted = a.regions ? String(a.regions).split(',') : null;
  const regions = REGIONS.regions.filter(r => r.enabled && (!wanted || wanted.includes(r.code)));
  log(`과거 임대료 수집: ${regions.length}개 지역 × ${oldMonths.join(',')} (기준 ${nowYM})`);

  let totalCalls = 0;
  for (const region of regions) {
    const byCx = {};             // "동|단지" → { areaKey: [deposits억] }
    const perM2 = [];
    for (const ymd of oldMonths) {
      let r;
      try { r = await fetchMonth(key, region.code, ymd, log); }
      catch (e) {
        if (/REGISTERED|SERVICE|KEY|REQUESTS/i.test(e.message)) throw e;
        log(`  ! ${region.name} ${ymd} 실패 — 건너뜀: ${e.message}`);
        continue;
      }
      totalCalls += r.calls;
      for (const it of r.items) {
        if (!it.aptNm || !it.m2 || !it.deposit) continue;
        if (it.monthlyRent) continue;   // 순수 전세만 (현재 지수와 같은 방식)
        const dep = Math.round(it.deposit / 100) / 100;
        perM2.push(dep / it.m2);
        const k = `${it.umdNm}|${it.aptNm}`;
        const ak = areaKey(it.m2);
        if (!byCx[k]) byCx[k] = {};
        if (!byCx[k][ak]) byCx[k][ak] = [];
        byCx[k][ak].push(dep);
      }
    }
    const depM2Old = median(perM2);
    // 현재 지수 (live 샤드)
    let nowIdx = { depM2Now: null, nNow: 0 };
    const liveFile = path.join(LIVE_DIR, `${region.code}.json`);
    if (fs.existsSync(liveFile)) {
      try { nowIdx = nowGuIndex(JSON.parse(fs.readFileSync(liveFile, 'utf8')), nowYM); } catch (e) {}
    }
    const gHist = depM2Old > 0 && nowIdx.depM2Now > 0
      ? Math.round((Math.pow(nowIdx.depM2Now / depM2Old, 1 / YEARS_BACK) - 1) * 10000) / 10000
      : null;
    const cx = {};
    for (const [k, areas] of Object.entries(byCx)) {
      const rec = {};
      for (const [ak, deps] of Object.entries(areas)) {
        if (deps.length) rec[ak] = { old: Math.round(median(deps) * 100) / 100, n: deps.length };
      }
      if (Object.keys(rec).length) cx[k] = rec;
    }
    const out = {
      meta: { code: region.code, name: region.name, oldQ: `${oldYear}-Q${Math.floor((q0 - 1) / 3) + 1}`, oldMonths, asOf: nowYM, yearsBack: YEARS_BACK },
      gu: { depM2Old: depM2Old != null ? Math.round(depM2Old * 10000) / 10000 : null, nOld: perM2.length, depM2Now: nowIdx.depM2Now != null ? Math.round(nowIdx.depM2Now * 10000) / 10000 : null, nNow: nowIdx.nNow, gHist },
      cx
    };
    fs.writeFileSync(path.join(OUT_DIR, `${region.code}.json`), JSON.stringify(out));
    log(`  ${region.name}: 과거 전세 ${perM2.length}건 · 단지 ${Object.keys(cx).length}개 · 구 g_hist ${gHist != null ? (gHist * 100).toFixed(2) + '%' : '—'}`);
  }
  fs.writeFileSync(path.join(OUT_DIR, 'status.json'), JSON.stringify({ enabled: true, asOf: nowYM, yearsBack: YEARS_BACK }));
  log(`완료: API 호출 ${totalCalls}회 → data/rent_history/`);
}

if (require.main === module) main().catch(e => { console.error('실패:', e.message); process.exit(1); });
module.exports = { parseRentItems, areaKey, nowGuIndex };
