'use strict';
/* ═══════════════════════════════════════════════════════════════════
   단지 기본정보 자동수집 (K-apt 공동주택 공공데이터) — FR-02
   세대수·동수·사용승인·주차·시공사 → data/complex_info/{sigungu}.json + status.json

   서비스 (2026-08 기준, JSON):
     ① 목록:  1613000/AptListService3/getSigunguAptList3
     ② 기본:  1613000/AptBasisInfoServiceV4/getAphusBassInfoV4   (세대수·동수·사용승인)
     ③ 상세:  1613000/AptBasisInfoServiceV4/getAphusDtlInfoV4    (주차·지하철 — --detail=0로 생략 가능)
   미승인(returnReasonCode 30) 시: 안내 후 종료 — 앱은 UNKNOWN 유지(임의 기본값 금지).
   쿼터 초과(22) 시: 수집분까지 저장하고 정상 종료 — 다음 날 이어서 실행.

   사용: node pipeline/complex_info.js [--regions=11740,...] [--detail=0|1] [--conc=8]
   ═══════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const REGIONS = JSON.parse(fs.readFileSync(path.join(__dirname, 'regions.json'), 'utf8')).regions;
const OUT = path.join(ROOT, 'data', 'complex_info');

const EP_LIST = '1613000/AptListService3/getSigunguAptList3';
const EP_BASS = '1613000/AptBasisInfoServiceV4/getAphusBassInfoV4';
const EP_DTL = '1613000/AptBasisInfoServiceV4/getAphusDtlInfoV4';

const num = s => { const n = parseFloat(String(s ?? '').replace(/[, ]/g, '')); return isFinite(n) ? n : null; };
/* 정규화: 공백·괄호 제거, 영문 소문자화+대표 브랜드 한글화, 아파트·맨션 접미어 제거
   — src/engine.js normNameK와 반드시 동일해야 앱 매칭이 성립한다 */
const normName = s => String(s || '').toLowerCase()
  .replace(/\s|\(.*?\)/g, '')
  .replace(/i-?park/g, '아이파크').replace(/e-?편한세상/g, '이편한세상')
  .replace(/(아파트|맨션)$/g, '');

function keyOf(a) {
  const k = a.key || (process.env.DATA_GO_KR_KEY || process.env.MOLIT_API_KEY ||
    (fs.existsSync(path.join(ROOT, '.molit-key')) ? fs.readFileSync(path.join(ROOT, '.molit-key'), 'utf8').trim() : ''));
  return /%[0-9A-Fa-f]{2}/.test(k) ? k : encodeURIComponent(k);
}

let QUOTA_HIT = false;
const FAILS = {};   // 실패 사유 집계
/* 전역 스로틀 — 초당 요청제한(LIMITED_..._PER_SECOND) 회피: 호출 간 최소 간격 보장 */
let THROTTLE_MS = 130, nextSlot = 0;
async function throttle() {
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  nextSlot = at + THROTTLE_MS;
  if (at > now) await new Promise(r => setTimeout(r, at - now));
}
async function call(ep, params, enc, retry = 3) {
  if (QUOTA_HIT) return { ok: false, code: '22', msg: 'quota (cached)' };
  await throttle();
  const q = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const url = `https://apis.data.go.kr/${ep}?serviceKey=${enc}&${q}`;
  try {
    const res = await fetch(url, { headers: { accept: '*/*' }, signal: AbortSignal.timeout(15000) });
    const text = await res.text();
    // 에러 봉투 (XML 또는 JSON — 미승인·쿼터·초당제한 등)
    if (text.includes('OpenAPI_ServiceResponse') && (text.includes('returnReasonCode') || text.includes('returnAuthMsg'))) {
      const code = (text.match(/returnReasonCode>?["\s:]*(\d+)/) || [])[1] || '?';
      const rps = text.includes('PER_SECOND');
      if (code === '22' && !rps) { QUOTA_HIT = true; FAILS['22'] = (FAILS['22'] || 0) + 1; return { ok: false, code, msg: '일일 쿼터 초과' }; }
      // 초당 제한·일시 오류 → 점증 백오프 후 재시도
      if (retry > 0) { await new Promise(r => setTimeout(r, (4 - retry) * 1500 + Math.random() * 800)); return call(ep, params, enc, retry - 1); }
      const key = rps ? 'rps' : code;
      FAILS[key] = (FAILS[key] || 0) + 1;
      if (!FAILS._sample) FAILS._sample = text.slice(0, 160).replace(/\s+/g, ' ');
      return { ok: false, code, msg: '' };
    }
    const j = JSON.parse(text);
    const hdr = (j.response && j.response.header) || {};
    if (hdr.resultCode && !/^0+$/.test(String(hdr.resultCode))) {
      FAILS['api' + hdr.resultCode] = (FAILS['api' + hdr.resultCode] || 0) + 1;
      return { ok: false, code: hdr.resultCode, msg: hdr.resultMsg };
    }
    return { ok: true, body: (j.response && j.response.body) || {} };
  } catch (e) {
    if (retry > 0) { await new Promise(r => setTimeout(r, 800)); return call(ep, params, enc, retry - 1); }
    FAILS.network = (FAILS.network || 0) + 1;
    return { ok: false, code: 'ERR', msg: e.message };
  }
}

/* 소규모 동시 실행 풀 */
async function pool(items, worker, conc) {
  const results = new Array(items.length);
  let i = 0;
  const run = async () => { for (;;) { const idx = i++; if (idx >= items.length) return; results[idx] = await worker(items[idx], idx); } };
  await Promise.all(Array.from({ length: Math.min(conc, items.length) }, run));
  return results;
}

async function main() {
  const a = {}; for (const s of process.argv.slice(2)) { const m = s.match(/^--([^=]+)=(.*)$/); if (m) a[m[1]] = m[2]; }
  const enc = keyOf(a);
  if (!enc) { console.error('키 없음 (.molit-key)'); process.exit(1); }
  const wantDetail = a.detail !== '0';
  const conc = Math.max(1, Number(a.conc) || 4);
  if (Number(a.throttle) > 0) THROTTLE_MS = Number(a.throttle);
  fs.mkdirSync(OUT, { recursive: true });
  const wanted = a.regions ? a.regions.split(',') : null;
  const regions = REGIONS.filter(r => r.enabled && (!wanted || wanted.includes(r.code)));

  // 승인 사전 점검
  const probe = await call(EP_LIST, { sigunguCode: regions[0].code, pageNo: 1, numOfRows: 1 }, enc);
  if (!probe.ok) {
    console.error('K-apt 단지목록 API 사용 불가:', probe.code, probe.msg);
    console.error('→ data.go.kr에서 "공동주택 단지 목록제공 서비스"와 "공동주택 기본 정보제공 서비스"를 활용신청하세요 (자동승인).');
    process.exit(2);
  }

  const skipExisting = a['skip-existing'] !== '0';
  let calls = 1, totalK = 0, totalInfo = 0, ambig = 0;
  const doneRegions = [];
  for (const region of regions) {
    if (QUOTA_HIT) break;
    if (skipExisting && fs.existsSync(path.join(OUT, `${region.code}.json`))) {
      doneRegions.push(region.code);
      console.log(`  ${region.name}(${region.code}): 기존 샤드 유지 (--skip-existing=0으로 재수집)`);
      continue;
    }
    // ① 시군구 단지 목록 (kaptCode)
    const list = [];
    for (let page = 1; page <= 20; page++) {
      const r = await call(EP_LIST, { sigunguCode: region.code, pageNo: page, numOfRows: 100 }, enc);
      calls++;
      if (!r.ok) break;
      const items = [].concat((r.body.items) || []);
      for (const it of items) if (it && it.kaptCode) list.push({ kaptCode: it.kaptCode, kaptName: it.kaptName, bjdCode: it.bjdCode, dong: it.as3 || null });
      const total = num(r.body.totalCount) || 0;
      if (page * 100 >= total || !items.length) break;
    }
    totalK += list.length;

    // ② 단지별 기본(+상세) 정보 — 동시 수집 후, 일시 오류 실패분은 순차 2차 패스로 회수
    const fetchOne = async apt => {
      if (QUOTA_HIT) return null;
      const b = await call(EP_BASS, { kaptCode: apt.kaptCode }, enc);
      calls++;
      if (!b.ok) return null;
      const x = (b.body && b.body.item) || {};
      const rec = {
        kaptCode: apt.kaptCode, kaptName: apt.kaptName, bjdCode: apt.bjdCode, dong: apt.dong,
        households: num(x.kaptdaCnt), dongCount: num(x.kaptDongCnt),
        usedate: x.kaptUsedate ? String(x.kaptUsedate) : null,
        builder: x.kaptBcompany || null, saleType: x.codeSaleNm || null, hoCnt: num(x.hoCnt)
      };
      if (wantDetail && !QUOTA_HIT) {
        const d = await call(EP_DTL, { kaptCode: apt.kaptCode }, enc);
        calls++;
        if (d.ok) {
          const y = (d.body && d.body.item) || {};
          const park = (num(y.kaptdPcnt) || 0) + (num(y.kaptdPcntu) || 0);
          if (park > 0) {
            rec.parkTotal = park;
            if (rec.households > 0) rec.parkingRatio = Math.round(park / rec.households * 100) / 100;
          }
          if (y.subwayLine) rec.subwayLine = y.subwayLine;
          if (y.subwayStation) rec.subwayStation = y.subwayStation;
          if (y.kaptdWtimesub) rec.subwayWalk = y.kaptdWtimesub;
        }
      }
      return rec;
    };
    const recs = await pool(list, fetchOne, conc);
    for (let i = 0; i < recs.length; i++) {
      if (recs[i] || QUOTA_HIT) continue;
      await new Promise(r => setTimeout(r, 250));
      recs[i] = await fetchOne(list[i]);   // 2차 패스 (순차)
    }

    // byName 인덱스 — 같은 정규화명이 시군구 안에 2개 이상이면 검수 대기(ambiguous, 자동 확정 금지 — FR-02)
    // K-apt명은 동네 접두어가 붙는 경우가 많다("강동롯데캐슬퍼스트"·"암사선사현대"·"명일삼익그린2차")
    // → 법정동·시군구 접두어를 뗀 변형 키도 등록해 실거래명("롯데캐슬퍼스트")과 이어준다.
    const byName = {};
    const put = (k, rec) => {
      if (!k || k.length < 2) return;
      if (byName[k]) {
        if (byName[k].kaptCode === rec.kaptCode) return;   // 같은 단지의 변형 키 중복
        if (!byName[k].ambiguous) { byName[k] = { ambiguous: true, candidates: [byName[k].kaptCode] }; ambig++; }
        if (!byName[k].candidates.includes(rec.kaptCode)) byName[k].candidates.push(rec.kaptCode);
        return;
      }
      byName[k] = rec;
    };
    const regionStem = normName(region.name).replace(/(시|군|구)$/, '');
    for (const rec of recs) {
      if (!rec || !(rec.households > 0)) continue;
      const k0 = normName(rec.kaptName);
      if (!k0) continue;
      put(k0, rec);
      totalInfo++;
      const stems = new Set();
      if (rec.dong) {
        const d = normName(rec.dong);
        stems.add(d);                                   // "명일동"
        const ds = d.replace(/동$/, '').replace(/[0-9]+가?$/, '');
        if (ds.length >= 2) stems.add(ds);              // "명일"
      }
      if (regionStem.length >= 2) stems.add(regionStem); // "강동"
      for (const st of stems) {
        if (k0.startsWith(st) && k0.length - st.length >= 2) put(k0.slice(st.length), rec);
      }
    }
    const out = { meta: { code: region.code, name: region.name, src: 'K-apt 공동주택 공공데이터 (AptBasisInfoServiceV4)', asOf: new Date().toISOString().slice(0, 10), status: 'VERIFIED', n: Object.keys(byName).length }, byName };
    fs.writeFileSync(path.join(OUT, `${region.code}.json`), JSON.stringify(out));
    doneRegions.push(region.code);
    console.log(`  ${region.name}(${region.code}): K-apt ${list.length}개 → 확정 ${Object.keys(byName).length}건 (누적 호출 ${calls})`);
  }

  if (doneRegions.length) {
    fs.writeFileSync(path.join(OUT, 'status.json'), JSON.stringify({
      enabled: true, asOf: new Date().toISOString().slice(0, 10),
      regions: doneRegions.length, detail: wantDetail,
      note: QUOTA_HIT ? '일일 쿼터 도달 — 미수집 지역은 다음 날 이어서 실행 (node pipeline/complex_info.js)' : '전 지역 수집 완료'
    }));
  }
  console.log(`${QUOTA_HIT ? '⚠️ 일일 쿼터 도달 — 수집분까지 저장' : '완료'}: 지역 ${doneRegions.length}/${regions.length} · K-apt 단지 ${totalK}개 · 확정 ${totalInfo}건 · 동명 검수대기 ${ambig}건 · API 호출 ${calls}회`);
  if (Object.keys(FAILS).length) console.log('실패 사유:', JSON.stringify(FAILS));
}

if (require.main === module) main().catch(e => { console.error('실패:', e.message); process.exit(1); });
module.exports = { normName };
