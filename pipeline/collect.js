'use strict';
/* ═══════════════════════════════════════════════════════════════════
   실거래 자동 수집기 — 국토교통부 실거래가 공개 API → data/live/*.json
   (네이버·아실 등 상용 서비스의 원천과 같은 공공 데이터를 직접 수집한다)

   사용:
     node pipeline/collect.js                     # 기본: 최근 2개월, enabled 지역 전체 (증분 병합)
     node pipeline/collect.js --months=6          # 최근 6개월 백필
     node pipeline/collect.js --regions=11680,11710
     node pipeline/collect.js --fixture           # API 없이 내장 픽스처로 샤드 생성 (테스트용)

   인증키(공공데이터포털 data.go.kr — "아파트 매매 실거래자료" + "아파트 전월세 자료" 활용신청):
     우선순위: --key=... → env DATA_GO_KR_KEY → env MOLIT_API_KEY → .molit-key 파일(gitignored)

   출력:
     data/live/index.json    검색 인덱스 (전 단지)
     data/live/{code}.json   시군구 샤드 (단지·평형별 최근 거래 + 전세 대표값)
   ═══════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'data', 'live');
const REGIONS = JSON.parse(fs.readFileSync(path.join(__dirname, 'regions.json'), 'utf8'));

const BASES = ['https://apis.data.go.kr/1613000', 'https://apis.data.go.kr/1611000'];
const EP_TRADE = 'RTMSDataSvcAptTrade/getRTMSDataSvcAptTrade';
const EP_RENT = 'RTMSDataSvcAptRent/getRTMSDataSvcAptRent';
const ROWS = 1000;
const MAX_TRADES_KEPT = 20;      // 단지·평형별 보관 최근 매매 건수
const JEONSE_WINDOW_MO = 6;      // 전세 대표값 기본 관찰기간(개월) — 부족 시 12→24로 확장
const OUTLIER_BAND = 0.28;       // 12개월 중앙값 대비 ±28% 초과 → 이상거래 플래그(삭제 아님)

/* ── 유틸 ── */
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
function recentMonths(n, now) {
  const d = now ? new Date(now + '-01T00:00:00Z') : new Date();
  const out = [];
  for (let i = 0; i < n; i++) {
    const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1 - i;
    const yy = y + Math.floor((m - 1) / 12), mm = ((m - 1) % 12 + 12) % 12 + 1;
    out.push(`${yy}${String(mm).padStart(2, '0')}`);
  }
  return out;
}
const num = s => { const n = parseFloat(String(s ?? '').replace(/[, ]/g, '')); return isFinite(n) ? n : null; };
const tag = (xml, name) => { const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`)); return m ? m[1].trim() : ''; };

/* XML <item> 파싱 */
function parseItems(xml) {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml))) {
    const x = m[1];
    items.push({
      aptNm: tag(x, 'aptNm') || tag(x, '아파트'),
      aptSeq: tag(x, 'aptSeq') || null,
      umdNm: tag(x, 'umdNm') || tag(x, '법정동'),
      jibun: tag(x, 'jibun'),
      buildYear: num(tag(x, 'buildYear') || tag(x, '건축년도')),
      m2: num(tag(x, 'excluUseAr') || tag(x, '전용면적')),
      floor: num(tag(x, 'floor') || tag(x, '층')),
      y: num(tag(x, 'dealYear')), mo: num(tag(x, 'dealMonth')), d: num(tag(x, 'dealDay')),
      price: num(tag(x, 'dealAmount') || tag(x, '거래금액')),          // 만원
      deposit: num(tag(x, 'deposit') || tag(x, '보증금액')),           // 만원
      monthlyRent: num(tag(x, 'monthlyRent') || tag(x, '월세금액')),   // 만원
      cancel: (tag(x, 'cdealType') || '').trim() === 'O',
      contractType: tag(x, 'contractType')
    });
  }
  return items;
}
function checkResult(xml) {
  // 표준 응답: <resultCode> / 인증·한도 오류 봉투: <returnReasonCode>+<errMsg>
  const code = tag(xml, 'resultCode') || tag(xml, 'returnReasonCode');
  const msg = tag(xml, 'resultMsg') || [tag(xml, 'errMsg'), tag(xml, 'returnAuthMsg')].filter(Boolean).join(' ');
  if (code && !/^0+$/.test(code)) {
    const fatal = /SERVICE|KEY|REQUESTS|REGISTERED|USE/i.test(msg + code) || ['22', '30', '31', '32', '33'].includes(code);
    return { ok: false, fatal, msg: `${code} ${msg}` };
  }
  return { ok: true };
}

/* API 호출 (페이징) */
async function fetchAll(base, ep, key, lawd, ymd, log) {
  const enc = /%[0-9A-Fa-f]{2}/.test(key) ? key : encodeURIComponent(key);
  const out = [];
  let page = 1, total = Infinity, calls = 0;
  while ((page - 1) * ROWS < total && page <= 10) {
    const url = `${base}/${ep}?serviceKey=${enc}&LAWD_CD=${lawd}&DEAL_YMD=${ymd}&numOfRows=${ROWS}&pageNo=${page}`;
    let xml = null;
    for (let att = 1; att <= 3; att++) {   // 일시적 네트워크 오류 재시도
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
      log(`  ! ${lawd} ${ymd} ${ep.split('/')[0]}: ${chk.msg} — 건너뜀`);
      return { items: [], calls };
    }
    total = num(tag(xml, 'totalCount')) ?? 0;
    out.push(...parseItems(xml));
    page++;
  }
  return { items: out, calls };
}

/* ── 집계 ── */
const cxKey = it => `${it.umdNm}|${it.aptNm}`;
const areaKey = m2 => String(Math.floor(m2));         // 84.97 → "84" (관행과 일치)
const ymOf = it => `${it.y}-${String(it.mo).padStart(2, '0')}`;

function emptyShard(region) {
  return { meta: { code: region.code, name: region.name, sido: region.sido, updatedAt: null, months: [] }, complexes: {} };
}

/* 매매·전월세 원시 레코드를 샤드에 병합
   ★ Monthly Full Replace: 해당 월을 다시 수집하면 그 월의 기존 거래를 전부 지우고
   국토부 최신 원본으로 교체한다 — 수집 후 취소·정정된 거래가 DB에 남는 문제 차단 */
function mergeMonth(shard, ymd, trades, rents, opts) {
  const replaceTrades = !opts || opts.replaceTrades !== false;
  const replaceRents = !opts || opts.replaceRents !== false;
  const ym = `${ymd.slice(0, 4)}-${ymd.slice(4)}`;
  if (!shard.meta.months.includes(ym)) shard.meta.months.push(ym);
  for (const cx of Object.values(shard.complexes)) {
    for (const ar of Object.values(cx.areas)) {
      if (replaceTrades) ar.trades = (ar.trades || []).filter(t => t.ym !== ym);
      if (replaceRents) ar.jeonseRaw = (ar.jeonseRaw || []).filter(r => r.ym !== ym);
    }
  }
  const touch = it => {
    const k = cxKey(it);
    if (!shard.complexes[k]) shard.complexes[k] = { name: it.aptNm, dong: it.umdNm, jibun: it.jibun || '', builtYear: it.buildYear || null, areas: {} };
    const cx = shard.complexes[k];
    if (!cx.builtYear && it.buildYear) cx.builtYear = it.buildYear;
    if (!cx.aptSeq && it.aptSeq) cx.aptSeq = it.aptSeq;     // 단지 고유 식별값 보존(전월세 응답 제공)
    const ak = areaKey(it.m2);
    if (!cx.areas[ak]) cx.areas[ak] = { m2: it.m2, trades: [], jeonseRaw: [] };
    const ar = cx.areas[ak];
    ar.m2 = Math.round(((ar.m2 + it.m2) / 2) * 100) / 100;
    return ar;
  };
  for (const it of trades) {
    if (!it.aptNm || !it.m2 || !it.price || it.cancel) continue;
    const ar = touch(it);
    const rec = { ym: ymOf(it), d: it.d || 1, price: Math.round(it.price / 100) / 100, floor: it.floor || 0 }; // 억, 계약일 보존
    if (!ar.trades.some(t => t.ym === rec.ym && t.d === rec.d && t.price === rec.price && t.floor === rec.floor)) ar.trades.push(rec);
  }
  for (const it of rents) {
    if (!it.aptNm || !it.m2 || !it.deposit) continue;
    if (it.monthlyRent) continue;                                  // 순수 전세만 대표값에 사용
    if (it.contractType && it.contractType.includes('갱신')) continue; // 갱신계약(5% 상한) 제외 — 시세 왜곡 방지
    const ar = touch(it);
    const rec = { ym: ymOf(it), v: Math.round(it.deposit / 100) / 100 };
    ar.jeonseRaw.push(rec);
  }
}

/* 보관 한도·전세 대표값 계산 등 후처리 */
function finalizeShard(shard, nowYM) {
  const ymNum = ym => { const [a, b] = ym.split('-').map(Number); return a * 12 + b; };
  const nowN = ymNum(nowYM);
  for (const k of Object.keys(shard.complexes)) {
    const cx = shard.complexes[k];
    let total = 0;
    for (const ak of Object.keys(cx.areas)) {
      const ar = cx.areas[ak];
      ar.trades.sort((a, b) => (b.ym + String(b.d).padStart(2, '0')).localeCompare(a.ym + String(a.d).padStart(2, '0')));
      // 중복 제거 후 최근 N건 + 24개월 내만 보관
      ar.trades = ar.trades.filter(t => nowN - ymNum(t.ym) <= 24).slice(0, MAX_TRADES_KEPT);
      // 이상거래 플래그: 12개월 중앙값 대비 큰 이탈 — 삭제하지 않고 표시만 (시장기준가 계산에서 저가중)
      const w12 = ar.trades.filter(t => nowN - ymNum(t.ym) <= 12).map(t => t.price).sort((a, b) => a - b);
      if (w12.length >= 3) {
        const med = w12[Math.floor(w12.length / 2)];
        for (const t of ar.trades) {
          if (Math.abs(t.price / med - 1) > OUTLIER_BAND) t.o = 1; else delete t.o;
        }
      }
      total += ar.trades.length;
      // 전세 대표값: 최근 6→12→24개월 중앙값
      const raw = (ar.jeonseRaw || []).filter(r => nowN - ymNum(r.ym) <= 24);
      let win = null, used = null;
      for (const mo of [JEONSE_WINDOW_MO, 12, 24]) {
        const w = raw.filter(r => nowN - ymNum(r.ym) <= mo);
        if (w.length >= 2 || (mo === 24 && w.length >= 1)) { win = w; used = mo; break; }
      }
      if (win && win.length) {
        const vs = win.map(r => r.v).sort((a, b) => a - b);
        ar.jeonse = { v: vs[Math.floor((vs.length - 1) / 2)], n: win.length, windowMo: used };
      } else ar.jeonse = null;
      ar.jeonseRaw = raw.slice(-60);   // 재계산용 원시값 일부 보관
      if (!ar.trades.length && !ar.jeonseRaw.length) delete cx.areas[ak];
    }
    cx.tradeCount = total;
    if (!Object.keys(cx.areas).length) delete shard.complexes[k];
  }
  shard.meta.months.sort();
  shard.meta.months = shard.meta.months.slice(-26);
  return shard;
}

function buildIndex(shards) {
  const idx = [];
  for (const sh of shards) {
    for (const [k, cx] of Object.entries(sh.complexes)) {
      idx.push({
        id: `${sh.meta.code}|${k}`, n: cx.name, d: cx.dong, g: sh.meta.code,
        gn: `${sh.meta.sido} ${sh.meta.name}`, y: cx.builtYear, t: cx.tradeCount,
        a: Object.keys(cx.areas)
      });
    }
  }
  idx.sort((a, b) => (b.t - a.t) || a.n.localeCompare(b.n, 'ko'));
  return idx;
}

/* ── 픽스처 (키 없이 파이프라인·앱 검증용) ── */
function fixtureXml() {
  const t = (apt, dong, by, m2, fl, y, mo, d, amt, cancel) => `<item><aptNm>${apt}</aptNm><umdNm>${dong}</umdNm><jibun>100</jibun><buildYear>${by}</buildYear><excluUseAr>${m2}</excluUseAr><floor>${fl}</floor><dealYear>${y}</dealYear><dealMonth>${mo}</dealMonth><dealDay>${d}</dealDay><dealAmount>${amt}</dealAmount>${cancel ? '<cdealType>O</cdealType>' : ''}</item>`;
  const r = (apt, dong, by, m2, fl, y, mo, dep, rent, ct) => `<item><aptNm>${apt}</aptNm><umdNm>${dong}</umdNm><buildYear>${by}</buildYear><excluUseAr>${m2}</excluUseAr><floor>${fl}</floor><dealYear>${y}</dealYear><dealMonth>${mo}</dealMonth><dealDay>15</dealDay><deposit>${dep}</deposit><monthlyRent>${rent}</monthlyRent><contractType>${ct}</contractType></item>`;
  const wrap = body => `<response><header><resultCode>000</resultCode><resultMsg>OK</resultMsg></header><body><totalCount>${(body.match(/<item>/g) || []).length}</totalCount><items>${body}</items></body></response>`;
  return {
    trade: wrap(
      t('공덕삼성래미안', '공덕동', 1999, 84.94, 12, 2026, 7, 3, '152,000') +
      t('공덕삼성래미안', '공덕동', 1999, 84.94, 5, 2026, 6, 21, '148,500') +
      t('공덕삼성래미안', '공덕동', 1999, 84.94, 17, 2026, 5, 2, '146,000') +
      t('공덕삼성래미안', '공덕동', 1999, 59.76, 9, 2026, 6, 11, '118,000') +
      t('공덕삼성래미안', '공덕동', 1999, 84.97, 3, 2026, 4, 8, '141,000') +
      t('신공덕타워', '신공덕동', 2004, 114.9, 21, 2026, 7, 19, '175,000') +
      t('신공덕타워', '신공덕동', 2004, 114.9, 8, 2026, 3, 27, '168,000') +
      t('취소테스트', '아현동', 2010, 84.9, 10, 2026, 7, 1, '999,999', true)
    ),
    rent: wrap(
      r('공덕삼성래미안', '공덕동', 1999, 84.94, 7, 2026, 7, '78,000', '0', '신규') +
      r('공덕삼성래미안', '공덕동', 1999, 84.94, 14, 2026, 6, '80,000', '0', '신규') +
      r('공덕삼성래미안', '공덕동', 1999, 84.94, 2, 2026, 5, '52,000', '0', '갱신') +
      r('공덕삼성래미안', '공덕동', 1999, 84.94, 11, 2026, 6, '30,000', '120', '신규') +
      r('신공덕타워', '신공덕동', 2004, 114.9, 5, 2026, 6, '95,000', '0', '신규')
    )
  };
}

/* ── 메인 ── */
async function main() {
  const a = args();
  const log = s => console.log(s);
  const nowYM = a.now || new Date().toISOString().slice(0, 7);
  fs.mkdirSync(OUT_DIR, { recursive: true });

  if (a.fixture) {
    const region = REGIONS.regions.find(r => r.code === '11440');
    const shard = emptyShard(region);
    const fx = fixtureXml();
    mergeMonth(shard, nowYM.replace('-', ''), parseItems(fx.trade), parseItems(fx.rent));
    shard.meta.updatedAt = nowYM;
    shard.meta.kind = 'fixture';
    finalizeShard(shard, nowYM);
    fs.writeFileSync(path.join(OUT_DIR, `${region.code}.json`), JSON.stringify(shard));
    fs.writeFileSync(path.join(OUT_DIR, 'index.json'), JSON.stringify({ meta: { updatedAt: nowYM, kind: 'fixture', regions: 1 }, complexes: buildIndex([shard]) }));
    log(`FIXTURE OK → data/live/${region.code}.json + index.json (검증용 — 커밋 금지)`);
    return;
  }

  const key = resolveKey(a);
  if (!key) {
    console.error('키 없음: data.go.kr에서 "아파트 매매 실거래자료"·"아파트 전월세 자료" 활용신청 후');
    console.error('  .molit-key 파일에 저장하거나 DATA_GO_KR_KEY 환경변수로 전달하세요.');
    console.error('  (GitHub Actions에서는 저장소 Secrets의 DATA_GO_KR_KEY 사용)');
    process.exit(a['ok-if-no-key'] ? 0 : 1);
  }

  const months = recentMonths(parseInt(a.months || '2', 10), a.now);
  const wanted = a.regions ? String(a.regions).split(',') : null;
  const regions = REGIONS.regions.filter(r => r.enabled && (!wanted || wanted.includes(r.code)));
  log(`수집 시작: ${regions.length}개 지역 × ${months.length}개월 (기준 ${nowYM})`);

  // --apis=trade,rent 로 수집 대상 제한 가능 (예: 전월세 활용신청 후 rent만 백필)
  const apis = String(a.apis || 'trade,rent').split(',');
  let useTrade = apis.includes('trade'), useRent = apis.includes('rent');
  let base = BASES[0], totalCalls = 0;
  const shards = [];
  for (const region of regions) {
    const file = path.join(OUT_DIR, `${region.code}.json`);
    let shard = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : emptyShard(region);
    if (shard.meta.kind === 'fixture') shard = emptyShard(region);   // 픽스처는 실데이터로 교체
    for (const ymd of months) {
      let tr = { items: [], calls: 0 }, rn = { items: [], calls: 0 };
      if (useTrade) {
        try { tr = await fetchAll(base, EP_TRADE, key, region.code, ymd, log); }
        catch (e) {
          if (/REGISTERED|SERVICE|KEY|REQUESTS/i.test(e.message)) throw e;   // 키·한도 문제는 중단
          log(`  ! ${region.name} ${ymd} 매매 수집 실패(일시 오류) — 이 월 건너뜀: ${e.message}`);
          totalCalls += tr.calls; continue;   // 기존 데이터 보존
        }
      }
      if (useRent) {
        try { rn = await fetchAll(base, EP_RENT, key, region.code, ymd, log); }
        catch (e) {
          if (/REGISTERED|SERVICE|KEY/i.test(e.message)) {
            useRent = false; rn = { items: [], calls: 1 };
            log(`  ! 전월세 API 미승인 — 이후 매매만 수집합니다. (${e.message})`);
            log(`    → data.go.kr에서 "아파트 전월세 자료" 활용신청 후 다시 실행하면 전세가 채워집니다.`);
          } else {
            rn = { items: [], calls: 1, failed: true };
            log(`  ! ${region.name} ${ymd} 전월세 수집 실패(일시 오류) — 이 월만 건너뜀: ${e.message}`);
          }
        }
      }
      totalCalls += tr.calls + rn.calls;
      // Full Replace는 실제 수집한 API에만 적용 — rent만 수집할 때 매매를 지우지 않는다
      mergeMonth(shard, ymd, tr.items, rn.items, { replaceTrades: useTrade, replaceRents: rn.calls > 0 && !rn.failed });
      log(`  ${region.name} ${ymd}: 매매 ${tr.items.length}건 · 전월세 ${rn.items.length}건 (월 전체교체)`);
    }
    shard.meta.updatedAt = nowYM;
    delete shard.meta.kind;
    finalizeShard(shard, nowYM);
    fs.writeFileSync(file, JSON.stringify(shard));
    shards.push(shard);
  }
  // 인덱스는 디스크의 모든 샤드 기준으로 재생성 (이번에 안 돈 지역 포함)
  const all = fs.readdirSync(OUT_DIR).filter(f => /^\d{5}\.json$/.test(f))
    .map(f => JSON.parse(fs.readFileSync(path.join(OUT_DIR, f), 'utf8')))
    .filter(s => s.meta.kind !== 'fixture');
  fs.writeFileSync(path.join(OUT_DIR, 'index.json'),
    JSON.stringify({ meta: { updatedAt: nowYM, regions: all.length }, complexes: buildIndex(all) }));
  const nCx = all.reduce((s, x) => s + Object.keys(x.complexes).length, 0);
  log(`완료: 단지 ${nCx.toLocaleString()}개 · API 호출 ${totalCalls}회 · index.json 갱신`);
}

if (require.main === module) main().catch(e => { console.error('실패:', e.message); process.exit(1); });
module.exports = { parseItems, mergeMonth, finalizeShard, buildIndex, emptyShard, areaKey, recentMonths, checkResult, fixtureXml };
