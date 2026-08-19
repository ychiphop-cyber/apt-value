'use strict';
/* ═══════════════════════════════════════════════════════════════════
   단지 기본정보 자동수집 (K-apt 공동주택 공공데이터) — PRD V3 PART B
   세대수·동수·준공·주차·용적률·건폐율·대지면적·시공사 등 → data/complex_info/{sigungu}.json

   필요 활용신청(data.go.kr, 같은 인증키):
     ① "공동주택 단지 목록제공 서비스"   ② "공동주택 기본 정보제공 서비스"
   미승인 시: 수집을 건너뛰고 안내만 출력 — 앱은 해당 값을 UNKNOWN으로 유지한다(임의 기본값 금지).

   사용: node pipeline/complex_info.js [--regions=11740,...]
   ═══════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const REGIONS = JSON.parse(fs.readFileSync(path.join(__dirname, 'regions.json'), 'utf8')).regions;
const OUT = path.join(ROOT, 'data', 'complex_info');

/* 서비스 경로 후보 — data.go.kr 개편으로 버전이 바뀌어도 순차 시도 */
const LIST_EPS = [
  '1613000/AptListService3/getSigunguAptList3',
  '1613000/AptListService2/getSigunguAptList',
  '1611000/AptListService2/getSigunguAptList'
];
const BASS_EPS = [
  '1613000/AptBasisInfoServiceV3/getAphusBassInfoV3',
  '1613000/AptBasisInfoServiceV2/getAphusBassInfoV2',
  '1611000/AptBasisInfoService1/getAphusBassInfo'
];
const DTL_EPS = [
  '1613000/AptBasisInfoServiceV3/getAphusDtlInfoV3',
  '1613000/AptBasisInfoServiceV2/getAphusDtlInfoV2',
  '1611000/AptBasisInfoService1/getAphusDtlInfo'
];

const tag = (xml, name) => { const m = String(xml).match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`)); return m ? m[1].trim() : ''; };
const num = s => { const n = parseFloat(String(s ?? '').replace(/[, ]/g, '')); return isFinite(n) ? n : null; };
const normName = s => String(s || '').replace(/\s|\(.*?\)|아파트$/g, '');

function keyOf(a) { const k = a.key || (process.env.DATA_GO_KR_KEY || process.env.MOLIT_API_KEY || (fs.existsSync(path.join(ROOT, '.molit-key')) ? fs.readFileSync(path.join(ROOT, '.molit-key'), 'utf8').trim() : '')); return /%[0-9A-Fa-f]{2}/.test(k) ? k : encodeURIComponent(k); }

async function call(ep, params, enc) {
  const q = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const res = await fetch(`https://apis.data.go.kr/${ep}?serviceKey=${enc}&${q}`, { headers: { accept: '*/*' } });
  const body = await res.text();
  const code = tag(body, 'resultCode') || tag(body, 'returnReasonCode') || (body.includes('returnReasonCode') ? '30' : '');
  const msg = tag(body, 'resultMsg') || tag(body, 'errMsg');
  if (code && !/^0+$/.test(code)) return { ok: false, code, msg, body };
  return { ok: true, body };
}
async function firstWorking(eps, params, enc) {
  let last = null;
  for (const ep of eps) {
    const r = await call(ep, params, enc);
    if (r.ok) return { ep, ...r };
    last = r;
    if (String(r.code) === '30') return { ep: null, ...r };   // 키 미등록 — 다른 버전도 동일하므로 중단
  }
  return { ep: null, ...(last || { ok: false, msg: 'no endpoint' }) };
}

async function main() {
  const a = {}; for (const s of process.argv.slice(2)) { const m = s.match(/^--([^=]+)=(.*)$/); if (m) a[m[1]] = m[2]; }
  const enc = keyOf(a);
  if (!enc) { console.error('키 없음 (.molit-key)'); process.exit(1); }
  fs.mkdirSync(OUT, { recursive: true });
  const wanted = a.regions ? a.regions.split(',') : null;
  const regions = REGIONS.filter(r => r.enabled && (!wanted || wanted.includes(r.code)));

  // 승인 여부 사전 점검
  const probe = await firstWorking(LIST_EPS, { sigunguCode: regions[0].code, pageNo: 1, numOfRows: 1 }, enc);
  if (!probe.ep) {
    console.error('K-apt 단지목록 API 사용 불가:', probe.code, probe.msg);
    console.error('→ data.go.kr에서 "공동주택 단지 목록제공 서비스"와 "공동주택 기본 정보제공 서비스"를 활용신청하세요 (자동승인).');
    console.error('→ 승인 전까지 세대수·주차·용적률 등은 UNKNOWN으로 유지됩니다 (임의 기본값 미사용).');
    process.exit(2);
  }
  console.log('단지목록 endpoint:', probe.ep);

  let calls = 1, matched = 0, totalK = 0;
  let bassEp = null, dtlEp = null;
  for (const region of regions) {
    // ① 시군구 단지 목록 (kaptCode)
    const list = [];
    for (let page = 1; page <= 10; page++) {
      const r = await call(probe.ep, { sigunguCode: region.code, pageNo: page, numOfRows: 100 }, enc);
      calls++;
      if (!r.ok) break;
      const items = r.body.match(/<item>[\s\S]*?<\/item>/g) || [];
      for (const it of items) list.push({ kaptCode: tag(it, 'kaptCode'), kaptName: tag(it, 'kaptName'), bjdCode: tag(it, 'bjdCode') });
      const total = num(tag(r.body, 'totalCount')) || 0;
      if (page * 100 >= total) break;
    }
    totalK += list.length;
    // ② 단지별 기본·상세 정보
    const out = { meta: { code: region.code, name: region.name, src: 'K-apt 공동주택 공공데이터', asOf: new Date().toISOString().slice(0, 10), status: 'VERIFIED' }, byName: {} };
    for (const apt of list) {
      if (!apt.kaptCode) continue;
      const b = bassEp ? await call(bassEp, { kaptCode: apt.kaptCode }, enc) : await firstWorking(BASS_EPS, { kaptCode: apt.kaptCode }, enc);
      calls++;
      if (b.ep) bassEp = b.ep;
      if (!b.ok) continue;
      const x = b.body;
      const rec = {
        kaptCode: apt.kaptCode, kaptName: apt.kaptName, bjdCode: apt.bjdCode,
        households: num(tag(x, 'kaptdaCnt')), dongCount: num(tag(x, 'kaptDongCnt')),
        usedate: tag(x, 'kaptUsedate') || null,
        far: num(tag(x, 'kaptTarea')) && num(tag(x, 'kaptMarea')) ? null : num(tag(x, 'kaptdEcntp')),
        landArea: num(tag(x, 'kaptTarea')), buildArea: num(tag(x, 'kaptMarea')),
        builder: tag(x, 'kaptBcompany') || null, rentalHouseholds: num(tag(x, 'kaptdCcnt'))
      };
      const d = dtlEp ? await call(dtlEp, { kaptCode: apt.kaptCode }, enc) : await firstWorking(DTL_EPS, { kaptCode: apt.kaptCode }, enc);
      calls++;
      if (d.ep) dtlEp = d.ep;
      if (d.ok) {
        rec.parkTotal = (num(tag(d.body, 'kaptdPcnt')) || 0) + (num(tag(d.body, 'kaptdPcntu')) || 0) || null;
        if (rec.parkTotal && rec.households) rec.parkingRatio = Math.round(rec.parkTotal / rec.households * 100) / 100;
        rec.subwayLine = tag(d.body, 'kaptdWtimesub') || null;
      }
      const dong = (apt.bjdCode || '').length >= 8 ? null : null;
      out.byName[normName(apt.kaptName)] = rec;
      matched++;
    }
    fs.writeFileSync(path.join(OUT, `${region.code}.json`), JSON.stringify(out));
    console.log(`  ${region.name}: 단지 ${list.length}개 수집`);
  }
  console.log(`완료: K-apt 단지 ${totalK}개 · 정보 ${matched}건 · API 호출 ${calls}회`);
}

if (require.main === module) main().catch(e => { console.error('실패:', e.message); process.exit(1); });
module.exports = { normName };
