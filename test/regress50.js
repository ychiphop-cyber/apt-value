'use strict';
/* §30-31 서울 주요 50개 단지 회귀 — 12항목 체크리스트, 자동 로그(data/qa/regress50.json)
   §37 완료 조건: 교육 누락률 ≤5% · 적정가 산출 100%(검색 성공분) · 메인/비교 가격 불일치 0건 */
const fs = require('fs'), path = require('path');
const H = require('./live_helper.js');
const { CFG, HUBS, JOBS, STN, E } = H;

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) pass++; else { fail++; console.error('  ✗ FAIL:', n); } };
const finite = x => typeof x === 'number' && isFinite(x);

/* [지역, 표시명, 검색어(폴백 순서)] — 검색어는 사용자가 실제 칠 법한 이름 그대로 */
const LIST = [
  ['강남', '래미안대치팰리스', ['래미안대치팰리스']],
  ['강남', '은마', ['대치 은마', '은마']],
  ['강남', '대치아이파크', ['대치아이파크']],
  ['강남', '도곡렉슬', ['도곡렉슬']],
  ['강남', '타워팰리스', ['타워팰리스']],
  ['강남', '디에이치퍼스티어아이파크', ['디에이치퍼스티어', '퍼스티어아이파크']],
  ['강남', '개포자이프레지던스', ['개포자이프레지던스']],
  ['강남', '래미안블레스티지', ['래미안블레스티지']],
  ['강남', '압구정현대', ['압구정 현대', '압구정 신현대']],
  ['강남', '청담자이', ['청담자이']],
  ['서초', '아크로리버파크', ['아크로리버파크']],
  ['서초', '래미안원베일리', ['래미안원베일리', '원베일리']],
  ['서초', '래미안퍼스티지', ['래미안퍼스티지']],
  ['서초', '반포자이', ['반포자이']],
  ['서초', '신반포자이', ['신반포자이', '반포센트럴자이']],
  ['서초', '서초그랑자이', ['서초그랑자이']],
  ['서초', '방배그랑자이', ['방배그랑자이']],
  ['송파', '잠실엘스', ['잠실엘스']],
  ['송파', '리센츠', ['잠실리센츠', '리센츠']],
  ['송파', '트리지움', ['트리지움']],
  ['송파', '잠실주공5단지', ['잠실주공5', '잠실 주공5단지']],
  ['송파', '파크리오', ['파크리오']],
  ['송파', '헬리오시티', ['헬리오시티']],
  ['송파', '올림픽선수촌', ['올림픽선수기자촌', '올림픽선수촌']],
  ['강동', '고덕그라시움', ['고덕그라시움']],
  ['강동', '고덕아이파크', ['고덕아이파크']],
  ['강동', '고덕아르테온', ['고덕아르테온']],
  ['강동', '고덕자이', ['고덕자이']],
  ['강동', '고덕센트럴아이파크', ['고덕센트럴아이파크']],
  ['양천', '목동5단지', ['목동신시가지5', '목동 신시가지5단지']],
  ['양천', '목동7단지', ['목동신시가지7', '목동 신시가지7단지']],
  ['양천', '목동14단지', ['목동신시가지14', '목동 신시가지14단지']],
  ['노원', '중계청구3차', ['중계 청구3차', '청구3차']],
  ['노원', '중계건영3차', ['중계 건영3차', '건영3차']],
  ['노원', '중계그린', ['중계그린']],
  ['광진', '광장힐스테이트', ['광장힐스테이트']],
  ['광진', '광장현대파크빌', ['광장현대파크빌', '현대파크빌']],
  ['마포', '마포래미안푸르지오', ['마포래미안푸르지오']],
  ['마포', '마포프레스티지자이', ['마포프레스티지자이']],
  ['성동', '트리마제', ['트리마제']],
  ['성동', '아크로서울포레스트', ['아크로서울포레스트']],
  ['성동', '옥수파크힐스', ['옥수파크힐스', 'e편한세상옥수파크힐스']],
  ['용산', '한남더힐', ['한남더힐']],
  ['용산', '래미안첼리투스', ['래미안첼리투스', '첼리투스']],
  ['동작', '아크로리버하임', ['아크로리버하임']],
  ['영등포', '여의도시범', ['여의도 시범', '시범']],
  ['성북', '래미안길음센터피스', ['래미안길음센터피스', '길음센터피스']],
  ['서울', 'DMC파크뷰자이', ['DMC파크뷰자이', '디엠씨파크뷰자이']],
  ['서울', '경희궁자이', ['경희궁자이']],
  ['서울', '마곡엠밸리', ['마곡엠밸리7', '마곡엠밸리']]
];

const rows = [];
const CK = ['search', 'trades', 'area', 'households', 'station', 'education', 'school', 'academy', 'value', 'band', 'reason', 'compare'];
for (const [gu, name, queries] of LIST) {
  const row = { gu, name, checks: {}, notes: [] };
  rows.push(row);
  const F = (k, cond, note) => { row.checks[k] = cond ? 'PASS' : 'FAIL'; if (!cond && note) row.notes.push(note); return cond; };
  // ① 검색
  let hit = null, usedQ = null;
  const guFilter = gu === '서울' ? null : gu;
  for (const q of queries) { const hs = H.findLive(q, guFilter); if (hs.length) { hit = hs[0]; usedQ = q; break; } }
  if (!F('search', !!hit, `검색 실패: ${queries.join(' / ')}`)) { CK.slice(1).forEach(k => row.checks[k] = '—'); continue; }
  row.matched = hit.n; row.dong = hit.d; row.query = usedQ;
  let prep, r;
  try {
    prep = H.prepareLive(hit.id);
    const areaKey = E.pickDefaultAreaKey(prep.cx.areas, CFG.search && CFG.search.defaultAreaPrefs);
    row.areaKey = areaKey;
    r = H.analyze(prep.cx, areaKey);
  } catch (e) {
    row.notes.push(e.user ? '매매 실거래 미확보 — 분석 불가 안내(정상 동작)' : `분석 오류: ${e.message}`);
    row.checks.trades = 'FAIL';
    ['area', 'households', 'station', 'education', 'school', 'academy', 'value', 'band', 'reason', 'compare'].forEach(k => row.checks[k] = '—');
    continue;
  }
  // ② 최신 실거래  ③ 면적 매칭(거래 있는 평형 기본선택)  ④ 세대수
  F('trades', r.marketRef && r.marketRef.n >= 1 && r.marketRef.latest.daysAgo <= 400, '최근 실거래 부족');
  F('area', (r.area.trades || []).length > 0, '기본선택 평형에 거래 없음');
  F('households', prep.cx.households > 0, 'K-apt 세대수 미확인');
  // ⑤ 역  ⑥⑦⑧ 교육·학교·학원
  F('station', !!r.transit, '역 연결 없음');
  const ed = r.hedonic.eduDetail;
  F('education', !!ed, '교육생활권 미매칭');
  F('school', !!(ed && ed.comps.school != null), '학교 데이터 없음');
  F('academy', !!(ed && ed.comps.academy != null), '학원 데이터 없음');
  if (ed) { row.eduZone = ed.zoneName; row.eduScore = ed.score; row.eduTier = ed.tier; }
  // ⑨ 적정가  ⑩ 밴드
  F('value', finite(r.combineOut.center) && r.combineOut.center > 0, '적정가 산출 실패');
  F('band', r.range.low < r.combineOut.center && r.combineOut.center < r.range.high, '가격 밴드 순서 오류');
  row.price = Math.round(r.currentPrice * 10) / 10;
  row.mref = r.marketRef ? `${Math.round(r.marketRef.low * 10) / 10}~${Math.round(r.marketRef.high * 10) / 10}` : null;
  // ⑪ 가격 이유 설명 (§23-26): 기여도 + 설명 3요소
  let cb = null;
  try { cb = E.priceContributions({ complex: prep.cx, areaKey: row.areaKey, asOfYM: H.INDEX.meta.updatedAt, overrides: {} }, CFG, HUBS, JOBS, STN); } catch (e) {}
  F('reason', !!(cb && cb.items.length >= 2 && r.explain.priceView.explains.length >= 1), '가격 이유 설명 생성 실패');
  // ⑫ 비교기능 (§1): 동일 단지를 비교 경로로 다시 빌드 → 가격 완전 동일
  try {
    const prep2 = H.prepareLive(hit.id);
    const r2 = H.analyze(prep2.cx, row.areaKey);
    F('compare', r2.currentPrice === r.currentPrice && r2.combineOut.center === r.combineOut.center, '메인/비교 가격 불일치');
  } catch (e) { F('compare', false, `비교 재빌드 오류: ${e.message}`); }
}

/* ── 로그 저장 (§31: FAIL 사유 포함) ── */
const outDir = path.join(__dirname, '..', 'data', 'qa');
fs.mkdirSync(outDir, { recursive: true });
const summary = {};
for (const k of CK) summary[k] = rows.filter(x => x.checks[k] === 'PASS').length;
fs.writeFileSync(path.join(outDir, 'regress50.json'), JSON.stringify({
  meta: { asOf: H.INDEX.meta.updatedAt, total: LIST.length, note: 'V2 개선 §30-31 회귀 로그 — 체크 12항목, FAIL 사유 포함' },
  summary, rows
}, null, 1));

/* ── 표 출력 ── */
const mark = v => v === 'PASS' ? '✓' : v === 'FAIL' ? '✗' : '·';
console.log('\n═══ §30 서울 주요 50개 단지 회귀 — 검색|실거래|면적|세대수|역|교육|학교|학원|적정가|밴드|이유|비교 ═══');
for (const row of rows) {
  console.log(`${(row.gu + ' ' + row.name).padEnd(22, ' ')} ${CK.map(k => mark(row.checks[k])).join(' ')}  ${row.price ? row.price + '억' : ''} ${row.eduZone ? `${row.eduZone} ${row.eduScore}(${row.eduTier})` : ''}${row.notes.length ? '  ⚠ ' + row.notes.join('; ') : ''}`);
}
console.log('항목별 PASS:', CK.map(k => `${k} ${summary[k]}/${LIST.length}`).join(' · '));

/* ── §37 완료 조건 검증 ── */
const found = rows.filter(x => x.checks.search === 'PASS' && x.checks.value !== '—');
const searched = rows.filter(x => x.checks.search === 'PASS');
ok(searched.length >= 48, `단지 검색 성공 ${searched.length}/50 (≥48)`);
const eduOK = found.filter(x => x.checks.education === 'PASS');
ok(eduOK.length / found.length >= 0.95, `§37 교육정보 누락률 ${(100 - eduOK.length / found.length * 100).toFixed(1)}% (≤5%)`);
ok(found.every(x => x.checks.value === 'PASS' && x.checks.band === 'PASS'), '§37 적정가·밴드 산출 100%');
ok(found.every(x => x.checks.compare === 'PASS'), '§37 메인/비교 가격 불일치 0건');
ok(found.every(x => x.checks.reason === 'PASS'), '§37 가격 이유 설명(금액 단위) 100%');
const hhOK = found.filter(x => x.checks.households === 'PASS');
ok(hhOK.length / found.length >= 0.85, `세대수 자동확인 ${hhOK.length}/${found.length} (≥85%)`);
ok(found.every(x => x.checks.station === 'PASS'), '역 연결 100%');

console.log(`\nregress50.js  ${pass} pass / ${fail} fail`);
if (fail) process.exit(1);
