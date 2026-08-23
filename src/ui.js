'use strict';
/* ═══════════════════════════════════════════════════════════════════
   닥터마빈 아파트 가치진단 — UI
   (빌드 시 CFG/HUBS/JOBS/DATA/REGIONS/AptEngine 주입)
   단지 소스 3종: ① 상세 프로필 샘플(DATA) ② 실거래 자동수집(data/live/*)
                 ③ 직접 입력
   ═══════════════════════════════════════════════════════════════════ */
const APP_VERSION = '5.0.0';
if (typeof ANCH !== 'undefined') HUBS.anchors = ANCH;   // Anchor Academy Index (§6) — 엔진에서 참조
const DEBUG_MODE = /[?&]debug=true/.test(location.search);
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/* FR-03 null-safe 포맷터: Missing(null)은 정상 입력 상태 — null에 숫자 포맷을 직접 호출하지 않는다 */
const fmtEok = x => x == null || !isFinite(x) ? '—' : `${(Math.round(x * 10) / 10).toFixed(1)}억`;
const fmtEokW = x => x == null || !isFinite(x) ? '—' : `${(Math.round(x * 10) / 10).toFixed(1)}억원`;
const fmtPct = (x, d = 1) => x == null || !isFinite(x) ? '—' : `${(x * 100).toFixed(d)}%`;
const signPct = x => x == null || !isFinite(x) ? '—' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;
const fmtRaw = (x, d = 3) => x == null || !isFinite(x) ? '—' : Number(x).toFixed(d);   // 반올림 전 값 표시 (FR-06)

/* ── 테마 ── */
(function initTheme() {
  let t = null; try { t = localStorage.getItem('aptdx_theme'); } catch (e) {}
  if (!t) t = (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', t);
})();
$('themeBtn').textContent = document.documentElement.getAttribute('data-theme') === 'dark' ? '라이트' : '다크';
$('themeBtn').onclick = () => {
  const cur = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', cur);
  try { localStorage.setItem('aptdx_theme', cur); } catch (e) {}
  $('themeBtn').textContent = cur === 'dark' ? '라이트' : '다크';
};

/* ── 상태 ── */
const state = {
  step: 1, cxId: null, manual: false, manualVals: {},
  liveSel: null,            // {id, code, key, entry, region}
  autoEdits: {},            // 자동수집 단지 보완 입력
  areaKey: null,
  ovPrice: null, ovJeonse: null, ovConv: null,
  result: null, baseInput: null, stress: new Set()
};

/* ── 자동수집(live) 데이터 ── */
const LIVE = { index: null, shards: {}, status: 'loading' };
async function loadLive() {
  try {
    const r = await fetch('data/live/index.json', { cache: 'no-cache' });
    if (!r.ok) throw new Error('none');
    LIVE.index = await r.json();
    LIVE.status = 'ready';
  } catch (e) { LIVE.status = 'none'; }
  renderVerLine(); renderAptList($('q').value.trim());
}
async function getShard(code) {
  if (LIVE.shards[code]) return LIVE.shards[code];
  const r = await fetch(`data/live/${code}.json`, { cache: 'no-cache' });
  if (!r.ok) throw new Error('지역 데이터를 불러오지 못했습니다.');
  const j = await r.json();
  LIVE.shards[code] = j;
  return j;
}
const regionOf = code => REGIONS.regions.find(r => r.code === code);

const STEPS = ['아파트 선택', '정보 확인', '진단 결과'];

/* ── 스테퍼·내비 ── */
function renderStepper() {
  $('stepper').innerHTML = STEPS.map((s, i) => {
    const n = i + 1;
    const cls = n === state.step ? 'st cur' : n < state.step ? 'st done' : 'st';
    return `<button class="${cls}" data-go="${n}"><i></i>${s}</button>`;
  }).join('');
  $('stepper').querySelectorAll('.st.done').forEach(b => b.onclick = () => go(Number(b.dataset.go)));
}

function step2Valid() {
  const cx = getComplex();
  if (!cx) return { ok: false, msg: '' };
  const area = cx.areas.find(a => a.key === state.areaKey) || cx.areas[0];
  const rep = AptEngine.repRecentPrice(area, DATA.meta.asOf, CFG);
  const price = state.ovPrice != null ? state.ovPrice : (rep ? rep.price : null);
  const jeonse = state.ovJeonse != null ? state.ovJeonse : area.jeonse;
  if (!(price > 0)) return { ok: false, msg: '이 평형의 실거래가 없어 현재 시세를 직접 입력해야 합니다.' };
  // FR-03: 전세가 없어도 분석을 막지 않는다 — 금융·임대 지지가치만 보류하고 나머지를 분석
  if (!(jeonse > 0)) return { ok: true, msg: '', warn: '전세 실거래가 없어 금융·임대 지지가치 분석은 보류됩니다. 전세 시세를 입력하면 함께 분석합니다.' };
  return { ok: true, msg: '' };
}

function nav() {
  const prev = $('btnPrev'), next = $('btnNext'), msg = $('navMsg');
  prev.style.visibility = state.step === 1 ? 'hidden' : 'visible';
  msg.style.display = 'none';
  if (state.step === 1) {
    next.textContent = '다음';
    next.disabled = !selectionValid();
  } else if (state.step === 2) {
    next.textContent = '분석하기';
    const v = step2Valid();
    next.disabled = !v.ok;
    if (!v.ok && v.msg) { msg.textContent = v.msg; msg.style.display = 'block'; }
    else if (v.warn) { msg.textContent = 'ℹ️ ' + v.warn; msg.style.display = 'block'; }
  } else {
    next.textContent = '다른 아파트 진단하기'; next.disabled = false;
  }
}

function go(n) {
  state.step = n;
  $('step1').hidden = n !== 1; $('step2').hidden = n !== 2; $('step3').hidden = n !== 3;
  renderStepper();
  if (n === 2) renderStep2();
  nav();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

$('btnPrev').onclick = () => { if (state.step > 1) go(state.step - 1); };
$('btnNext').onclick = () => {
  if (state.step === 1 && selectionValid()) go(2);
  else if (state.step === 2 && step2Valid().ok) runAnalysis();
  else if (state.step === 3) resetAll();
};

function resetAll() {
  state.cxId = null; state.manual = false; state.manualVals = {};
  state.liveSel = null; state.autoEdits = {};
  state.areaKey = null;
  state.ovPrice = null; state.ovJeonse = null; state.ovConv = null;
  state.result = null; state.baseInput = null; state.stress = new Set();
  $('q').value = ''; $('manualCard').hidden = true; $('report').innerHTML = '';
  renderAptList(''); go(1);
}

function selectionValid() {
  if (state.manual) {
    const v = state.manualVals;
    return !!(v.name && v.price > 0 && v.jeonse > 0 && v.m2 > 0 && v.builtYear > 1960 && v.households > 0);
  }
  return !!state.cxId || !!state.liveSel;
}

/* ── STEP 1 · 검색 + 단지 목록 (샘플 + 자동수집) ── */
function matchTokens(q, hay) { return q.split(/\s+/).every(t => hay.includes(t)); }

function liveStatusHtml() {
  if (LIVE.status === 'loading') return `<div class="notebox">실거래 자동수집 데이터 확인 중…</div>`;
  if (LIVE.status === 'ready') {
    const m = LIVE.index.meta;
    return `<div class="notebox">🔄 <b>실거래 자동수집 연결됨</b> — ${m.regions}개 시군구 · ${LIVE.index.complexes.length.toLocaleString()}개 단지 (국토교통부 실거래가, ${esc(m.updatedAt)} 기준). 검색하면 자동수집 단지가 함께 검색됩니다.</div>`;
  }
  return `<div class="notebox"><b>실거래 자동수집 대기 중</b> — 공공데이터포털(국토교통부 실거래가 API) 키를 연결하면
    수도권 40개 시군구의 <b>모든 아파트 단지</b>가 자동 등재되고 매일 갱신됩니다.
    <details style="margin-top:6px"><summary style="cursor:pointer">연결 방법 (5분, 1회)</summary>
    <ol style="margin:6px 0 0;padding-left:18px;line-height:1.7">
      <li>data.go.kr 로그인 → <b>"아파트 매매 실거래자료"</b>와 <b>"아파트 전월세 자료"</b> 각각 활용신청 (즉시 승인)</li>
      <li>마이페이지의 일반 인증키를 GitHub 저장소 apt-value → Settings → Secrets → Actions에 <b>DATA_GO_KR_KEY</b>로 등록</li>
      <li>Actions 탭 → "실거래 데이터 자동 갱신" → Run workflow (months=24로 1회 백필) — 이후 매일 자동</li>
    </ol></details></div>`;
}

function renderAptList(q) {
  const sample = DATA.complexes.filter(c => {
    if (!q) return true;
    return matchTokens(q, [c.name, c.city, c.district, c.dong, ...(c.aliases || []), ...(c.tags || [])].join(' '));
  });
  let liveMatches = [], groupMatches = [];
  if (q && LIVE.status === 'ready') {
    const sampleNames = new Set(sample.map(c => c.name));
    const brandPrefixes = (CFG.search && CFG.search.brandPrefixes) || [];
    const aliasMap = (typeof ALIASES !== 'undefined' && ALIASES.aliases) || {};
    // FR-01: 정규화 검색 — 공백·통칭(동이름+단지명)·브랜드 접두어·'아파트' 접미어를 흡수 + 별칭 테이블
    liveMatches = LIVE.index.complexes
      .filter(e => AptEngine.liveSearchMatch(q, e, { brandPrefixes, aliases: aliasMap[e.id] }))
      .filter(e => !sampleNames.has(e.n))
      .slice(0, 30);
    // FR-01: 분할 등재 물리단지 — 그룹 별칭 매칭 또는 구성 단지 2개 이상 매칭 시 통합 카드 제시
    const memberIds = new Set(liveMatches.map(e => e.id));
    groupMatches = (((typeof ALIASES !== 'undefined' && ALIASES.splitGroups) || [])).filter(g =>
      AptEngine.liveSearchMatch(q, { n: g.display, gn: '', d: '' }, { brandPrefixes, aliases: g.aliases }) ||
      g.members.filter(m => memberIds.has(m)).length >= 2);
  }
  const sampleCards = sample.map(c => `
    <button class="apt ${state.cxId === c.id && !state.manual && !state.liveSel ? 'sel' : ''}" data-id="${c.id}">
      <b>${esc(c.name)}</b>
      <span class="l1">${esc(c.city)} ${esc(c.district)} ${esc(c.dong)} · ${c.builtYear}년 · ${c.households != null ? c.households.toLocaleString() : '—'}세대</span>
      <span class="tagrow"><span class="tg" style="color:var(--accent);border-color:var(--accent)">상세 프로필</span>${(c.tags || []).map(t => `<span class="tg">${esc(t)}</span>`).join('')}</span>
    </button>`).join('');
  const inGroup = new Set(groupMatches.flatMap(g => g.members));
  const groupCards = groupMatches.map(g => `
    <button class="apt" data-group="${esc(g.id)}">
      <b>${esc(g.display)}</b>
      <span class="l1">${esc(g.note || '분할 등재 단지 통합')} — 구성 등재명: ${g.members.map(m => esc(m.split('|')[2])).join(' · ')}</span>
      <span class="tagrow"><span class="tg" style="color:var(--accent);border-color:var(--accent)">통합 단지</span><span class="tg">실거래 자동</span></span>
    </button>`).join('');
  const liveCards = liveMatches.map(e => `
    <button class="apt" data-live="${esc(e.id)}">
      <b>${esc(e.n)}</b>
      <span class="l1">${esc(e.gn)} ${esc(e.d)} · ${e.y ? e.y + '년' : '연식 미상'} · 최근 2년 매매 ${e.t}건</span>
      <span class="tagrow"><span class="tg">실거래 자동</span>${inGroup.has(e.id) ? '<span class="tg">동 구간 분리 등재</span>' : ''}<span class="tg">${e.a.map(a => a + '㎡').join(' · ')}</span></span>
    </button>`).join('');
  $('aptList').innerHTML = liveStatusHtml() + sampleCards + groupCards + liveCards + `
    <button class="apt dashed full" data-id="__manual__">
      <b>＋ 직접 입력</b>
      <span class="l1">검색에 없는 아파트를 핵심 정보만으로 진단합니다 (미입력 항목은 기본값 사용으로 표기됩니다)</span>
    </button>` +
    (q && !sample.length && !liveMatches.length && !groupMatches.length ? `<div class="notebox">검색 결과가 없습니다. ${LIVE.status !== 'ready' ? '자동수집을 연결하면 수도권 전 단지가 검색됩니다. ' : ''}직접 입력으로 진단할 수 있습니다.</div>` : '');

  $('aptList').querySelectorAll('.apt').forEach(b => b.onclick = async () => {
    if (b.dataset.live || b.dataset.group) {
      try {
        b.querySelector('b').textContent = '불러오는 중…';
        if (b.dataset.group) await selectLiveGroup(b.dataset.group);
        else await selectLive(b.dataset.live);
      } catch (e) {
        b.querySelector('b').textContent = '불러오기 실패 — 다시 시도';
      }
      return;
    }
    if (b.dataset.id === '__manual__') {
      state.manual = true; state.cxId = null; state.liveSel = null;
      $('manualCard').hidden = false;
      renderManualForm();
      $('manualCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
      renderAptList($('q').value.trim()); nav();
    } else {
      state.manual = false; state.liveSel = null; state.cxId = b.dataset.id; state.areaKey = null;
      state.ovPrice = null; state.ovJeonse = null; state.ovConv = null;
      $('manualCard').hidden = true;
      // 상세 프로필 단지도 실거래는 자동수집 데이터로 연동 (샤드 선로딩)
      const cx0 = DATA.complexes.find(c => c.id === b.dataset.id);
      if (cx0 && cx0.regionCode && LIVE.status === 'ready' && !LIVE.shards[cx0.regionCode]) {
        try { await getShard(cx0.regionCode); } catch (e) {}
      }
      go(2);
    }
  });
}
$('q').addEventListener('input', () => renderAptList($('q').value.trim()));

async function selectLive(id) {
  const e = LIVE.index.complexes.find(x => x.id === id);
  if (!e) throw new Error('단지 없음');
  const shard = await getShard(e.g);
  const key = id.split('|').slice(1).join('|');
  const entry = shard.complexes[key];
  if (!entry) throw new Error('단지 데이터 없음');
  await getKaptInfo(e.g);   // FR-02: K-apt 기본정보 샤드(있으면) — 세대수·주차 자동연동
  state.liveSel = { id, code: e.g, key, entry, region: regionOf(e.g) };
  state.manual = false; state.cxId = null; state.areaKey = null; state.autoEdits = {};
  state.ovPrice = null; state.ovJeonse = null; state.ovConv = null;
  $('manualCard').hidden = true;
  go(2);
}

/* FR-01: 분할 등재 물리단지 통합 선택 — 구성 등재 단지의 거래를 합산해 하나로 분석 */
async function selectLiveGroup(groupId) {
  const g = (ALIASES.splitGroups || []).find(x => x.id === groupId);
  if (!g) throw new Error('통합 단지 정보 없음');
  const shard = await getShard(g.region);
  const entries = g.members.map(m => shard.complexes[m.split('|').slice(1).join('|')]).filter(Boolean);
  if (!entries.length) throw new Error('단지 데이터 없음');
  await getKaptInfo(g.region);
  const merged = AptEngine.mergeLiveEntries(g.display, entries);
  merged.dong = entries[0].dong;
  state.liveSel = { id: 'group|' + g.id, code: g.region, key: null, entry: merged, region: regionOf(g.region), group: g };
  state.manual = false; state.cxId = null; state.areaKey = null; state.autoEdits = {};
  state.ovPrice = null; state.ovJeonse = null; state.ovConv = null;
  $('manualCard').hidden = true;
  go(2);
}

/* FR-02: K-apt 공동주택 기본정보 샤드 — status.json으로 수집 여부를 먼저 확인해
   승인·수집 전에는 지역 샤드를 조회하지 않는다 (불필요한 404 없이 UNKNOWN 유지, 임의 기본값 금지) */
const KAPT = { shards: {}, enabled: null };
async function getKaptInfo(code) {
  if (KAPT.enabled === null) {
    try {
      const s = await fetch('data/complex_info/status.json', { cache: 'no-store' });
      KAPT.enabled = s.ok ? !!(await s.json()).enabled : false;
    } catch (e) { KAPT.enabled = false; }
  }
  if (!KAPT.enabled) return null;
  if (code in KAPT.shards) return KAPT.shards[code];
  try {
    const r = await fetch(`data/complex_info/${code}.json`, { cache: 'no-store' });
    KAPT.shards[code] = r.ok ? await r.json() : null;
  } catch (e) { KAPT.shards[code] = null; }
  return KAPT.shards[code];
}

/* ── 자동수집 단지 → 엔진 스키마 (핵심 로직은 engine.buildAutoComplex — Node 테스트 공유, AC-09) ── */
function buildAutoComplex() {
  const { entry, region, code, id } = state.liveSel;
  return AptEngine.buildAutoComplex(entry, region, {
    edits: state.autoEdits,
    ovPrice: state.ovPrice, ovJeonse: state.ovJeonse,
    areaKey: state.areaKey, conv: state.ovConv,
    asOf: liveAsOf(), stations: STN, hubs: HUBS,
    dongLink: dongLinkFor(code, entry.dong),
    // 세대수: 직접 매칭 → 분할단지 통합/합산 → 수기 확인 테이블 (kaptResolve)
    kapt: AptEngine.kaptResolve(KAPT.shards[code], entry.name, id, typeof ALIASES !== 'undefined' ? ALIASES : null),
    liveId: id
  });
}

/* 법정동→역 연결 조회: "시군구코드:동" 오버라이드 우선 (빈 배열 = 연결 안 함) */
function dongLinkFor(regionCode, dong) {
  const scoped = DONG.map[`${regionCode}:${dong}`];
  if (scoped !== undefined) return scoped.length ? scoped : null;
  return DONG.map[dong] || null;
}

/* 샘플(상세 프로필) 단지에 자동수집 실거래를 연동 — 프로필은 유지, 가격 데이터만 실데이터로 교체 (V3 P0-1) */
function mergeSampleWithLive(cx) {
  if (!cx.regionCode || LIVE.status !== 'ready') return cx;
  const shard = LIVE.shards[cx.regionCode];
  if (!shard) return cx;
  const key = Object.keys(shard.complexes).find(k => {
    const [dong, nm] = k.split('|');
    return dong === cx.dong && (nm === cx.name || (cx.aliases || []).some(a => a.replace(/\s/g, '') === nm.replace(/\s/g, '')));
  });
  if (!key) return cx;
  const live = shard.complexes[key];
  const out = JSON.parse(JSON.stringify(cx));
  let merged = 0;
  for (const a of out.areas) {
    const la = live.areas[a.key];
    if (la && la.trades && la.trades.length) {
      a.trades = la.trades; merged++;
      if (la.jeonse) { a.jeonse = la.jeonse.v; a.jeonseMeta = la.jeonse; }
      a.jeonseRaw = la.jeonseRaw || [];   // v4 STEP 1: 신규계약 원시값 (전세 3건 평균·월세 채택)
      a.wolseRaw = la.wolseRaw || [];
    }
  }
  if (merged) { out.liveLinked = true; out.aptSeq = live.aptSeq || null; }
  return out;
}
function liveAsOf() { return (LIVE.index && LIVE.index.meta.updatedAt) || DATA.meta.asOf; }

/* ── 직접 입력 ── */
const REDEV_OPTS = Object.entries(CFG.option.stageLabels);
function renderManualForm() {
  const v = state.manualVals;
  $('manualForm').innerHTML = `
    <div class="grid2">
      <div class="full"><label class="mini">단지명<input type="text" class="box" id="mName" value="${esc(v.name || '')}" placeholder="예: ○○아파트"></label></div>
      <div><label class="mini">지역 구분
        <select id="mTier">${['서울핵심', '서울', '수도권핵심', '수도권', '지방광역', '기타'].map(t => `<option ${v.tier === t ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
        <p class="subtle">지역별 기본값(전환율 등)에 쓰입니다.</p></div>
      <div><label class="mini">준공연도<span class="inline-num"><input type="number" id="mYear" min="1965" max="2026" value="${v.builtYear || 2010}"><em>년</em></span></label></div>
      <div><label class="mini">세대수<span class="inline-num"><input type="number" id="mHH" min="50" step="50" value="${v.households || 1000}"><em>세대</em></span></label></div>
      <div><label class="mini">전용면적<span class="inline-num"><input type="number" id="mM2" min="20" step="1" value="${v.m2 || 84}"><em>㎡</em></span></label></div>
      <div><label class="mini">현재 시세 (매매)<span class="inline-num"><input type="number" id="mPrice" min="0.5" step="0.1" value="${v.price || ''}"><em>억원</em></span></label></div>
      <div><label class="mini">전세 시세<span class="inline-num"><input type="number" id="mJeonse" min="0.1" step="0.1" value="${v.jeonse || ''}"><em>억원</em></span></label></div>
      <div><label class="mini">지하철 도보<span class="inline-num"><input type="number" id="mSubway" min="1" max="40" value="${v.subwayMin || 10}"><em>분</em></span></label></div>
      <div><label class="mini">강남까지 (대중교통)<span class="inline-num"><input type="number" id="mGBD" min="5" max="120" value="${v.gbd || 45}"><em>분</em></span></label></div>
      <div><label class="mini">중학교 학군 선호도
        <select id="mMid">${[1, 2, 3, 4, 5].map(n => `<option value="${n}" ${((v.middlePref || 3) === n) ? 'selected' : ''}>${n} — ${['매우 낮음', '낮음', '보통', '선호', '매우 선호'][n - 1]}</option>`).join('')}</select></label></div>
      <div><label class="mini">동네 학원가 수준
        <select id="mAcad">${[1, 2, 3, 4, 5].map(n => `<option value="${n}" ${((v.acadLevel || 3) === n) ? 'selected' : ''}>${n} — ${['거의 없음', '작음', '보통', '큼', '대형 학원가'][n - 1]}</option>`).join('')}</select></label></div>
      <div><label class="mini">향후 3년 연평균 입주(시군구)<span class="inline-num"><input type="number" id="mSupply" min="0" step="100" value="${v.supply || 2000}"><em>호</em></span></label></div>
      <div><label class="mini">지역 인구<span class="inline-num"><input type="number" id="mPop" min="1" step="1" value="${v.popMan || 40}"><em>만명</em></span></label></div>
      <div><label class="mini">정비사업 단계
        <select id="mRedev">${REDEV_OPTS.map(([k, l]) => `<option value="${k}" ${((v.redev || 'none') === k) ? 'selected' : ''}>${l}</option>`).join('')}</select></label></div>
    </div>
    <p class="subtle">그 밖의 항목(주차·브랜드·공원·규제 등)은 중립 가정값으로 계산되며, 결과 화면에 기본값 사용으로 표기됩니다.</p>`;
  const bind = (id, key, num) => { $(id).addEventListener('input', () => { state.manualVals[key] = num ? Number($(id).value) : $(id).value.trim(); nav(); }); };
  bind('mName', 'name'); bind('mYear', 'builtYear', 1); bind('mHH', 'households', 1);
  bind('mM2', 'm2', 1); bind('mPrice', 'price', 1); bind('mJeonse', 'jeonse', 1); bind('mSubway', 'subwayMin', 1);
  bind('mGBD', 'gbd', 1); bind('mSupply', 'supply', 1); bind('mPop', 'popMan', 1);
  ['mTier', 'mMid', 'mAcad', 'mRedev'].forEach(id => $(id).addEventListener('change', () => {
    const map = { mTier: 'tier', mMid: 'middlePref', mAcad: 'acadLevel', mRedev: 'redev' };
    state.manualVals[map[id]] = (id === 'mTier' || id === 'mRedev') ? $(id).value : Number($(id).value); nav();
  }));
  if (!v.tier) { v.tier = '서울'; v.builtYear = v.builtYear || 2010; v.households = v.households || 1000; v.m2 = v.m2 || 84; }
}

function buildManualComplex() {
  const v = state.manualVals;
  const conv = CFG.financial.defaultConversionRate;
  return {
    id: '__manual__', name: v.name || '직접 입력 단지', city: '', district: '', dong: '',
    regionTier: v.tier || '서울', builtYear: v.builtYear || 2010, households: v.households || 1000,
    brandTier: 2, parkingRatio: 1.0, far: 250, rentalShare: 0,
    redev: { stage: v.redev || 'none' }, conversionRate: state.ovConv != null ? state.ovConv : conv,
    tags: ['직접 입력'],
    areas: [{ key: 'M', label: `전용 ${v.m2 || 84}㎡`, m2: v.m2 || 84, jeonse: v.jeonse, trades: [{ ym: DATA.meta.asOf, price: v.price }] }],
    location: { subwayMin: v.subwayMin || 10, lines: [], transfer: false, express: false, futureTransit: null, jobMinutes: { GBD: v.gbd || 45, CBD: 50, YBD: 55, PANGYO: 45 } },
    education: { zoneId: null, elemM: 500, chopuma: false, middlePref: v.middlePref || 3, localAcademyLevel: v.acadLevel || 3, age3049: 0.30, studentTrend: 'stable' },
    life: { martMin: 10, deptMin: 20, hospitalMin: 15, streetLevel: 3 },
    nature: { parkMin: 10, bigPark: false, riverMin: 30, hanRiver: false, hanRiverView: null, forest: false },
    supply: { pop: (v.popMan || 40) * 10000, next3yAvg: v.supply ?? 2000, adjacentRatio: 1.0, metroRatio: 1.0, unsoldLevel: 2, txVolumeLevel: 3, jeonseListingsLevel: 3, jeonseTrend: 'stable', regulated: false }
  };
}

/* ── STEP 2 · 정보 확인 ── */
function getComplex() {
  if (state.manual) return buildManualComplex();
  if (state.liveSel) return buildAutoComplex();
  const cx = DATA.complexes.find(c => c.id === state.cxId);
  return cx ? mergeSampleWithLive(cx) : cx;
}

function renderStep2() {
  const cx = getComplex();
  if (!cx) return;
  // FR-04: 거래 0건 평형은 기본선택하지 않는다 — 84㎡ 최근접 → 59㎡ → 거래량 순
  if (!state.areaKey || !cx.areas.some(a => a.key === state.areaKey)) {
    state.areaKey = AptEngine.pickDefaultAreaKey(cx.areas, CFG.search && CFG.search.defaultAreaPrefs) || cx.areas[0].key;
  }
  const isLive = !!state.liveSel;
  const S = DATA.defaultSources;

  $('cxSummary').innerHTML = `
    <div class="stepnum">STEP 2 / 3</div>
    <h2>${esc(cx.name)} ${isLive ? '<span class="stat info">실거래 자동</span>' : ''}</h2>
    <p class="hint">${esc(cx.city)} ${esc(cx.district)} ${esc(cx.dong)} · ${cx.builtYear ? `${cx.builtYear}년 준공` : '준공연도 미확인'}${cx.households ? ` · ${cx.households.toLocaleString()}세대${cx.householdsNote ? ` (${esc(cx.householdsNote)})` : ''}` : ' · 세대수 미확인'}</p>
    ${isLive ? '' : `<div class="kv"><span>주차</span><span>${cx.parkingRatio ?? '—'}대/세대</span></div>
    <div class="kv"><span>용적률</span><span>${cx.far ?? '—'}%${cx.allowedFar ? ` (허용 ${cx.allowedFar}%)` : ''}</span></div>
    <div class="kv"><span>교통</span><span>${esc((cx.location.lines || []).join(' · ') || '—')} 도보 ${cx.location.subwayMin}분</span></div>
    <div class="kv"><span>정비사업</span><span>${CFG.option.stageLabels[(cx.redev && cx.redev.stage) || 'none']}</span></div>`}
    ${state.manual ? '<p class="subtle">직접 입력 단지 — 미입력 항목은 중립 가정값입니다.</p>'
      : isLive ? `<p class="subtle">국토교통부 실거래가 자동수집 단지 (${esc(liveAsOf())} 기준). 실거래·전세는 자동, 입지·상품 상세는 아래 보완 입력 또는 기본값을 사용합니다.</p>`
      : `<p class="subtle">${esc(DATA.meta.notice)}</p>`}`;

  const area = cx.areas.find(a => a.key === state.areaKey);
  // 대표 최근가 (V3.2): 직전 거래가 이상 저가(특수거래 의심)면 최근 3개월 최고가로 자동입력
  const rep = AptEngine.repRecentPrice(area, DATA.meta.asOf, CFG);
  const latest = rep ? rep.latest : null;
  const priceVal = state.ovPrice != null ? state.ovPrice : (rep ? rep.price : '');
  const jeonseVal = state.ovJeonse != null ? state.ovJeonse : (area.jeonse ?? '');
  const jm = area.jeonseMeta;
  $('areaCard').innerHTML = `
    <h2>평형과 가격을 확인해 주세요</h2>
    <p class="hint">자동입력 값은 수정할 수 있습니다. 수정한 값은 결과에 그대로 반영됩니다.</p>
    <div class="seg" id="areaSeg">${cx.areas.map(a => `<button data-k="${a.key}" aria-pressed="${a.key === state.areaKey}" aria-label="${esc(a.label)}${isLive ? `, 최근 매매 ${a.trades.length}건` : ''}">${esc(a.label)}${isLive ? ` · ${a.trades.length}건` : ''}</button>`).join('')}</div>
    <div class="grid2" style="margin-top:16px">
      <div>
        <label class="mini">현재 시장가격 ${state.ovPrice != null ? '<span class="stat est">수정됨</span>' : (latest ? '<span class="stat ok">자동입력</span>' : '<span class="stat chk" style="color:var(--accent);background:var(--accent-soft);border:1px solid var(--accent)">입력 필요</span>')}
          <span class="inline-num"><input type="number" id="inPrice" step="0.1" min="0" value="${priceVal}" aria-label="현재 시장가격, 억원 단위"><em>억원</em></span></label>
        ${latest ? `<div class="srcline">최근 실거래 ${latest.ym}${latest.d ? '-' + String(latest.d).padStart(2, '0') : ''} · ${fmtEok(latest.price)}${latest.floor ? ` (${latest.floor}층)` : ''}${(latest.o || (rep && rep.anomalous)) ? ' <span class="stat est">이상 저가 가능성</span>' : rep && rep.anomalousHigh ? ' <span class="stat est">이상 고가 가능성</span>' : ''} — ${(isLive || cx.liveLinked) ? '국토교통부 실거래가 API' : esc(S.trades.src)}, ${(isLive || cx.liveLinked) ? esc(liveAsOf()) : esc(S.trades.asOf)} 기준${rep && (rep.anomalous || rep.anomalousHigh) ? `<br>모델 판단: 이 거래는 최근 3개월 또래 거래(중앙값 <b>${rep.peerMed}억</b>)와 차이가 커 이상 ${rep.anomalous ? '저가' : '고가'} 가능성이 있습니다. <b>실거래는 사실 그대로 표시</b>합니다 — 지금 보시는 호가가 다르면 직접 수정하세요.` : ''}</div>` : '<div class="srcline">이 평형은 최근 매매 실거래가 없습니다 — 시세를 직접 입력하세요.</div>'}
      </div>
      <div>
        <label class="mini">전세 시세 ${state.ovJeonse != null ? '<span class="stat est">수정됨</span>' : (area.jeonse ? '<span class="stat ok">자동입력</span>' : '<span class="stat est">미입력 — 금융 분석만 보류</span>')}
          <span class="inline-num"><input type="number" id="inJeonse" step="0.1" min="0" value="${jeonseVal}" aria-label="전세 시세, 억원 단위"><em>억원</em></span></label>
        <div class="srcline">${jm ? `전월세 실거래 ${jm.n}건 중앙값 (최근 ${jm.windowMo}개월, 신규계약 — 갱신·해제 제외)` : isLive ? '전세 실거래 없음 — 입력하지 않으면 금융·임대 분석만 보류하고 나머지를 분석합니다' : `${esc(S.jeonse.src)}, ${esc(S.jeonse.asOf)} 기준`}</div>
      </div>
    </div>`;
  $('areaSeg').querySelectorAll('button').forEach(b => b.onclick = () => {
    state.areaKey = b.dataset.k; state.ovPrice = null; state.ovJeonse = null; renderStep2(); nav();
  });
  $('inPrice').addEventListener('input', () => {
    const n = Number($('inPrice').value);
    state.ovPrice = (rep && Math.abs(n - rep.price) < 1e-9) ? null : (n > 0 ? n : null);
    nav();
  });
  $('inJeonse').addEventListener('input', () => {
    const n = Number($('inJeonse').value);
    state.ovJeonse = (area.jeonse && Math.abs(n - area.jeonse) < 1e-9) ? null : (n > 0 ? n : null);
    nav();
  });

  /* 자동수집 단지 보완 입력 + 계산 가정 */
  const F = CFG.financial;
  const conv = state.ovConv != null ? state.ovConv : (cx.conversionRate || F.defaultConversionRate);
  const r = F.altReturn + F.liquidityPremium + F.assetRiskPremium + (F.regionRiskPremium[cx.regionTier] ?? 0.013);
  const e = state.autoEdits;
  let stationRow = '';
  if (isLive) {
    const dl = dongLinkFor(state.liveSel.code, state.liveSel.entry.dong);
    const autoSt = (!e.station && dl && dl.length && STN.stations[dl[0].st]) ? dl[0] : null;
    const badge = e.station && e.station.st ? '<span class="stat ok">입력됨</span>'
      : autoSt ? `<span class="stat est">자동연결(추정) ${esc(autoSt.st)}역 ${autoSt.min}분</span>`
      : '<span class="stat" style="color:var(--muted);background:var(--raised);border:1px solid var(--line)">미확인 — 중립 처리</span>';
    stationRow = `
      <div><label class="mini">가장 가까운 역 ${badge}
        <input type="text" class="box" id="edStName" list="stnList" value="${esc((e.station && e.station.st) || '')}" placeholder="${autoSt ? autoSt.st : '역 이름 입력'}"></label>
        <datalist id="stnList">${Object.keys(STN.stations).sort((a, b) => a.localeCompare(b, 'ko')).map(n => `<option value="${esc(n)}">`).join('')}</datalist></div>
      <div><label class="mini">역까지 도보
        <span class="inline-num"><input type="number" id="edStMin" min="1" max="40" value="${(e.station && e.station.min) || (autoSt ? autoSt.min : '')}" placeholder="8"><em>분</em></span></label>
        <p class="subtle">역을 바꾸거나 도보시간을 입력하면 확인값(MANUAL)으로 계산합니다.</p></div>`;
  }
  const liveExtra = isLive ? `
    <h3 class="mini-h">보완 정보 (선택) — 입력하면 정확도가 올라갑니다</h3>
    <div class="grid2">
      ${stationRow}
      <div><label class="mini">세대수 ${e.households > 0 ? '<span class="stat ok">입력됨</span>' : cx.householdsSource === 'KAPT' ? '<span class="stat ok">자동확인 (K-apt)</span>' : '<span class="stat" style="color:var(--muted);background:var(--raised);border:1px solid var(--line)">미확인 — 항목 보류</span>'}
        <span class="inline-num"><input type="number" id="edHH" min="50" step="50" value="${e.households || (cx.householdsSource === 'KAPT' ? cx.households : '')}" placeholder="미확인" aria-label="세대수"><em>세대</em></span></label></div>
      <div><label class="mini">정비사업 단계 ${e.redevStage ? '<span class="stat ok">입력됨</span>' : '<span class="stat est">해당 없음 가정</span>'}
        <select id="edRedev" aria-label="정비사업 단계"><option value="">모름 / 해당 없음</option>${REDEV_OPTS.filter(([k]) => k !== 'none').map(([k, l]) => `<option value="${k}" ${e.redevStage === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label></div>
      <div><label class="mini">향후 3년 연평균 입주(시군구) ${e.supplyNext3yAvg > 0 ? '<span class="stat ok">입력됨</span>' : `<span class="stat est">기본값 ${(state.liveSel.region.supplyNext3yAvg).toLocaleString()}호</span>`}
        <span class="inline-num"><input type="number" id="edSupply" min="0" step="100" value="${e.supplyNext3yAvg || ''}" placeholder="${state.liveSel.region.supplyNext3yAvg}" aria-label="향후 3년 연평균 입주 물량, 호 단위"><em>호</em></span></label></div>
    </div>` : '';

  $('assumeCard').innerHTML = `
    <details class="acc"><summary><span class="sumleft">🛠 데이터 수정하기 (선택)</span><span class="sumr">계산 가정 · 역 거리 · 세대수 · 공급</span></summary><div class="detail-body">
    <p class="hint">필요한 경우에만 열어 수정하세요. 합리성 검증을 통과한 수정값(사용자 확인)은 정확도를 높입니다. 모든 가정은 결과 화면에 표시됩니다.</p>
    <div class="kv"><span>${esc(F.baseRate.label)}</span><span>${fmtPct(F.baseRate.value)} <span class="srcline" style="display:inline">(${esc(F.baseRate.asOf)})</span></span></div>
    <div class="kv"><span>${esc(F.mortgageRate.label)}</span><span>${fmtPct(F.mortgageRate.value)} <span class="srcline" style="display:inline">(${esc(F.mortgageRate.asOf)})</span></span></div>
    <div class="kv"><span>요구수익률 r (합성)</span><span>${fmtPct(r)} = 대체투자 ${fmtPct(F.altReturn)} + 유동성 ${fmtPct(F.liquidityPremium)} + 지역·자산위험</span></div>
    <div class="kv"><span>장기 임대가치 성장률 g</span><span>${fmtPct(F.longTermRentGrowth[cx.regionTier] ?? 0.006)} (${esc(cx.regionTier)})</span></div>
    <div class="grid2" style="margin-top:12px"><div>
      <label class="mini">시장 전월세전환율 ${state.ovConv != null ? '<span class="stat est">수정됨</span>' : '<span class="stat ok">자동입력</span>'}
        <span class="inline-num"><input type="number" id="inConv" step="0.1" min="1" max="12" value="${(conv * 100).toFixed(1)}" aria-label="시장 전월세전환율, 퍼센트"><em>%</em></span></label>
      <div class="srcline">법정 전환율이 아닌 지역 시장 전환율 기준</div>
    </div></div>
    ${liveExtra}
    </div></details>`;
  $('inConv').addEventListener('input', () => {
    const n = Number($('inConv').value) / 100;
    const base = state.liveSel ? state.liveSel.region.conv : (state.manual ? F.defaultConversionRate : (cx.conversionRate || F.defaultConversionRate));
    state.ovConv = (n > 0.01 && Math.abs(n - base) > 1e-6) ? n : null;
  });
  if (isLive) {
    const bindE = (id, key) => { const el = $(id); if (!el) return; el.addEventListener('input', () => { state.autoEdits[key] = Number(el.value) || 0; nav(); }); };
    bindE('edHH', 'households'); bindE('edSupply', 'supplyNext3yAvg');
    $('edRedev').addEventListener('change', () => { state.autoEdits.redevStage = $('edRedev').value || null; nav(); });
    const syncStation = () => {
      const name = $('edStName').value.trim();
      const min = Number($('edStMin').value) || 0;
      if (name && STN.stations[name]) state.autoEdits.station = { st: name, min: min > 0 ? min : 8 };
      else if (!name) state.autoEdits.station = null;
      nav();
    };
    $('edStName').addEventListener('change', syncStation);
    $('edStName').addEventListener('blur', syncStation);
    $('edStMin').addEventListener('input', () => { if (state.autoEdits.station) { state.autoEdits.station.min = Number($('edStMin').value) || 8; } else syncStation(); });
  }
}

/* ── 분석 실행 ── */
function buildInput() {
  const cx = getComplex();
  const overrides = {};
  if (state.ovPrice != null) overrides.price = state.ovPrice;
  if (state.ovJeonse != null) overrides.jeonse = state.ovJeonse;
  return {
    complex: cx,
    areaKey: state.manual ? 'M' : state.areaKey,
    asOfYM: state.liveSel ? liveAsOf() : DATA.meta.asOf,
    overrides, manualComplex: state.manual, autoComplex: !!state.liveSel
  };
}

async function runAnalysis() {
  go(3);
  $('report').innerHTML = ''; $('loading').style.display = 'block';
  state.stress = new Set();
  state.cmpRef = null; state.cmpPrep = null;
  setTimeout(async () => {
    try {
      state.baseInput = buildInput();
      // 과거 임대 실적(10년 전 전세) 샤드 — 있으면 결과에 §C '지난 10년 실적'이 포함된다
      const histCode = state.liveSel ? state.liveSel.code : (state.baseInput.complex.regionCode || null);
      if (histCode) { try { await getRentHist(histCode); } catch (e) {} }
      const areaKeyForHist = state.baseInput.areaKey || (state.baseInput.complex.areas[0] || {}).key;
      state.baseInput.rentHist = histCode ? histResolve(histCode, state.baseInput.complex, areaKeyForHist) : null;
      // 재건축 이중 경로용 인근 신축 전월세 (모든 단지 공통 — 신축은 자연히 현 상태 경로가 이긴다)
      if (histCode && LIVE.status === 'ready' && !LIVE.shards[histCode]) { try { await getShard(histCode); } catch (e) {} }
      state.baseInput.nearbyNew = histCode ? nearbyNewOf(histCode, state.baseInput.complex, state.baseInput.asOfYM) : null;
      state.result = AptEngine.analyze(state.baseInput, CFG, HUBS, JOBS, STN);
      $('loading').style.display = 'none';
      renderReport(state.result);
    } catch (e) {
      $('loading').style.display = 'none';
      // PRD 8.2: 자바스크립트 오류 원문은 로그에만 — 화면에는 사용자 조치 안내
      console.error('[apt-value] 분석 오류:', e);
      if (e && e.user) {
        $('report').innerHTML = `<div class="warnbox"><b>분석 불가</b> — ${esc(e.message)}</div>`;
      } else {
        $('report').innerHTML = `<div class="warnbox"><b>일시적 오류</b> — 분석 중 문제가 발생했습니다. 입력값은 유지되며 다시 시도할 수 있습니다. <button class="btn ghost" id="retryAnalysis" style="margin-top:8px">다시 시도</button></div>`;
        const rb = $('retryAnalysis'); if (rb) rb.onclick = () => runAnalysis();
      }
    }
  }, 700);
}

/* ═══════════════════════════════════════════════════════════════════
   결과 화면 v5.0 (PRD 결과화면개편 v4) — 가격 명세 4층 · 지난 10년 실적 ·
   인근 비교 · 적정가 · 직접 조정 · 계산 밖의 가치 · 접힘 4종.
   본문에는 전문용어·판정을 쓰지 않는다 — 금액과 조건으로만 말한다.
   ═══════════════════════════════════════════════════════════════════ */
const fmtMan = x => x == null || !isFinite(x) ? '—' : Math.round(x).toLocaleString() + '만';
const fmtG = x => x == null || !isFinite(x) ? '—' : (x * 100).toFixed(1) + '%';
const fmtGp = x => x == null || !isFinite(x) ? '—' : (x >= 0 ? '+' : '−') + Math.abs(x * 100).toFixed(1) + '%p';

/* ── 과거 임대 실적 샤드 (data/rent_history/{code}.json) ── */
const RENTH = { shards: {}, enabled: null };
async function getRentHist(code) {
  if (RENTH.enabled === null) {
    try {
      const s = await fetch('data/rent_history/status.json', { cache: 'no-store' });
      RENTH.enabled = s.ok ? !!(await s.json()).enabled : false;
    } catch (e) { RENTH.enabled = false; }
  }
  if (!RENTH.enabled || !code) return null;
  if (code in RENTH.shards) return RENTH.shards[code];
  try {
    const r = await fetch(`data/rent_history/${code}.json`, { cache: 'no-store' });
    RENTH.shards[code] = r.ok ? await r.json() : null;
  } catch (e) { RENTH.shards[code] = null; }
  return RENTH.shards[code];
}
/* 단지·평형의 과거 전세 조회 — 실거래명·분할단지 구성명까지 시도, 없으면 구 지수 */
function histResolve(code, cx, areaKey, extraNames) {
  const h = RENTH.shards[code];
  if (!h) return null;
  const names = [cx.name, ...(extraNames || [])];
  if (state.liveSel && state.liveSel.entry && state.liveSel.entry.name === cx.name) {
    for (const m of (state.liveSel.entry.mergedFrom || [])) names.push(m);
  }
  let cxOld = null;
  for (const nm of names) {
    const rec = (h.cx[`${cx.dong}|${nm}`] || {})[areaKey];
    if (rec && rec.old > 0) { cxOld = rec; break; }
  }
  return { cxOld, gu: h.gu, oldQ: h.meta.oldQ, yearsBack: h.meta.yearsBack, guName: h.meta.name };
}

/* ── 인근 신축 전월세 (재건축 이중 경로용 — STEP R1 입력) ── */
function nearbyNewOf(code, cx, asOfYM, extraSelfNames) {
  if (!code || LIVE.status !== 'ready' || !LIVE.shards[code]) return null;
  const region = regionOf(code);
  if (!region) return null;
  const selfNames = new Set([cx.name, ...(extraSelfNames || [])].filter(Boolean));
  if (state.liveSel && state.liveSel.entry && state.liveSel.entry.name === cx.name) {
    for (const m of (state.liveSel.entry.mergedFrom || [])) selfNames.add(m);
  }
  const conv = cx.conversionRate || region.conv || CFG.financial.defaultConversionRate;
  return AptEngine.v4NearbyNew(LIVE.shards[code].complexes, selfNames, cx.dong, asOfYM, conv, CFG);
}

/* ── 인근 단지 비교 (§D) — 같은 시군구 거래 상위 단지에 같은 잣대 적용.
   인근 단지의 개발 호재는 자동 확인이 어려워 반영하지 않는다(접힘에 명시). ── */
function v4BenchmarkOf(r) {
  const v = r.v4;
  if (!v) return null;
  const code = state.liveSel ? state.liveSel.code : r.cx.regionCode;
  if (!code || LIVE.status !== 'ready' || !LIVE.shards[code]) return null;
  const region = regionOf(code);
  if (!region) return null;
  const V = CFG.v4;
  const selfNames = new Set([r.cx.name, state.liveSel && state.liveSel.entry ? state.liveSel.entry.name : null].filter(Boolean));
  const rows = [];
  for (const e of Object.values(LIVE.shards[code].complexes)) {
    if (selfNames.has(e.name)) continue;
    let best = null;
    for (const [k2, a] of Object.entries(e.areas || {})) {
      if (!a.trades || !a.trades.length) continue;
      if (!(a.jeonseRaw || []).length && !(a.jeonse && a.jeonse.v > 0)) continue;
      const dd = Math.abs((a.m2 || Number(k2) || 84) - 84);
      if (!best || dd < best.dd || (dd === best.dd && a.trades.length > best.n)) best = { a, dd, n: a.trades.length };
    }
    if (!best) continue;
    const P = best.a.trades[0].price;
    const basis = AptEngine.v4RentBasis({
      jeonseRaw: best.a.jeonseRaw || [], wolseRaw: best.a.wolseRaw || [],
      jeonse: best.a.jeonse ? best.a.jeonse.v : null, jeonseMeta: best.a.jeonse || null
    }, { overrides: {} }, CFG, state.baseInput.asOfYM);
    if (!basis.jeonse && !basis.wolse) continue;
    const conv = region.conv || CFG.financial.defaultConversionRate;
    const Rj = basis.jeonse ? basis.jeonse.v * conv : null;
    const Rw = basis.wolse ? basis.wolse.dep * conv + basis.wolse.mr * 12 / 10000 : null;
    const Rg = Math.max(Rj ?? -1, Rw ?? -1);
    if (!(Rg > 0) || !(P > 0)) continue;
    const R = Rg * (1 - V.costRate);
    const fair = AptEngine.v4FairAt(R, V.k, V.gBase, CFG, [], P).Vfair;
    const gq = AptEngine.v4SolveG(R, V.k, 0, P, CFG);
    rows.push({ name: e.name, t: e.tradeCount || best.n, resid: Math.round((P - fair) / P * 100), gReq: gq ? gq.g : null });
  }
  rows.sort((a, b) => b.t - a.t);
  const top = rows.slice(0, V.benchmarkN || 12);
  if (top.length < 4) return null;
  const all = [...top.map(x => ({ name: x.name, resid: x.resid, self: false })), { name: r.cx.name, resid: v.residPct, self: true }]
    .sort((a, b) => a.resid - b.resid);
  const rank = all.findIndex(x => x.self) + 1;
  const nb = top.map(x => x.resid).sort((a, b) => a - b);
  const med = nb.length % 2 ? nb[(nb.length - 1) / 2] : Math.round((nb[nb.length / 2 - 1] + nb[nb.length / 2]) / 2);
  const gqs = top.map(x => x.gReq).filter(x => x != null).sort((a, b) => a - b);
  const gNbr = gqs.length ? gqs[Math.floor(gqs.length / 2)] : null;
  return { top, all, rank, n: all.length, med, gNbr, region: region.name };
}

/* ── A. 헤더 + 가격 블록 ── */
function v4HeadHtml(r) {
  const cx = r.cx, v = r.v4;
  const sub = [
    `전용 ${r.area.m2}㎡`,
    cx.households != null ? `${cx.households.toLocaleString()}세대` : '세대수 미확인',
    cx.builtYear ? `${cx.builtYear}년 준공` : '준공연도 미확인',
    [cx.district, cx.dong].filter(Boolean).join(' ')
  ].filter(Boolean).join(' · ');
  const rep = r.repPrice;
  const anomaly = rep && (rep.anomalous || rep.anomalousHigh) && !(v && v.manualPrice);
  const dealSub = v && v.deal ? `${v.deal.ym.replace('-', '.')}${v.deal.floor ? ` · ${v.deal.floor}층` : ''}` : '';
  const priceRow = v && v.manualPrice
    ? `<div class="prow"><span class="pk">입력하신 시세<small>직접 입력값</small></span><span class="pv num">${fmtEok(v.P)}</span></div>`
    : `<div class="prow"><span class="pk">최근 실거래<small>${esc(dealSub)}</small></span><span class="pv num">${v ? fmtEok(v.P) : fmtEok(r.currentPrice)}</span></div>`;
  const askRow = (cx.askLow > 0 && cx.askHigh > 0)
    ? `<div class="prow ask"><span class="pk">현재 호가<small>${cx.askCount ? `매물 ${cx.askCount}건` : '매물'}</small></span><span class="pv num">${fmtEok(cx.askLow)} <em>~</em> ${fmtEok(cx.askHigh)}</span></div>`
    : '';
  return `
  <div class="v4head">
    <div class="name">${esc(cx.name)}${v && v.rbAdopted ? ' <span class="rbflag">재건축 기준</span>' : ''}</div>
    <div class="hsub">${esc(sub)}${cx.householdsNote ? ` <span class="subtle" style="font-size:11.5px">(${esc(cx.householdsNote)})</span>` : ''}</div>
  </div>
  <div class="pricebox">
    ${priceRow}
    ${askRow}
    <div class="pnote">아래 명세는 <b>${v && v.manualPrice ? '입력하신 시세' : '최근 실거래'} ${v ? fmtEok(v.P) : fmtEok(r.currentPrice)}</b> 기준입니다.${askRow ? ' 호가는 아직 거래로 확인되지 않은 가격이라 명세에 넣지 않습니다.' : ' 호가(매물 가격)는 거래로 확인된 값이 아니어서 수집하지 않습니다.'}${anomaly ? `<br>직전 거래는 3개월 또래 거래(중앙값 ${rep.peerMed}억)와 차이가 커 <b>이상 ${rep.anomalousHigh && !rep.anomalous ? '고가' : '저가'} 가능성</b>이 있습니다. 실거래는 사실 그대로 표시하며, 다르게 보이면 STEP 2에서 시세를 수정하세요.` : ''}</div>
  </div>`;
}

/* ── B-0. 재건축 경로 안내 카드 (채택 시 명세 앞에 삽입 — 왜 계산이 다른지 먼저 납득) ── */
function v4RebuildPathHtml(r) {
  const v = r.v4, rb = v.rb;
  const oldMo = Math.round(v.Rgross / 12 * 10000);
  return `
  <div class="card v4card">
    <div class="eyebrow">이 단지는 계산 방식이 다릅니다</div>
    <h2>낡은 집의 월세로 재면 안 됩니다</h2>
    <div class="lede">${r.cx.builtYear ? r.cx.builtYear + '년 준공' : '구축'} · ${esc(rb.stageRawLabel)} 단계.
      이 집을 사는 사람은 <b>지금의 낡은 집에 살려고</b> 사는 게 아니라 <b>그 땅에 새 집을 지으려고</b> 삽니다.
      그래서 두 가지를 모두 계산하고 높은 쪽을 씁니다.</div>
    <div class="paths">
      <div class="path"><div class="k">① 지금 상태로<br>계속 살 때</div><div class="v num">${fmtEok(v.Vrent)}</div>
        <div class="d">${v.rent.jeonse ? '전세 ' + fmtEok(v.rent.jeonse.v) + ' 기준' : '현 임대료 기준'}<br>월 환산 ${fmtMan(oldMo)}</div></div>
      <div class="path win"><div class="k">② 새 아파트가<br>됐을 때</div><div class="v num">${fmtEok(rb.Vrebuild)}</div>
        <div class="d">인근 신축 임대료 기준<br>분담금·기다림 반영</div><div class="badge2">채택</div></div>
    </div>
    <div class="punch">낡은 집 기준으로는 ${fmtEok(v.Vrent)}, 재건축을 반영하면 <b>${fmtEok(rb.Vrebuild)}</b>입니다.<br>
      <b>${fmtEok(v.rbDiff)} 차이</b>가 '이 땅에 새 집을 지을 수 있다'는 값입니다.</div>
  </div>`;
}

/* ── B-재건축. 워터폴 명세 (뺄셈 구조 — 스택으로 표현 불가) ── */
function v4SpecRebuildHtml(r) {
  const v = r.v4, rb = v.rb;
  const rowOf = w => {
    if (w.sub2) return `<div class="wrow sub"><span class="wl">${esc(w.l)}</span><span class="wv num">${fmtEok(w.v)}</span></div>`;
    if (w.total) return `<div class="wrow total"><span class="wl">${esc(w.l)}</span><span class="wv num">${fmtEok(w.v)}</span></div>`;
    if (w.gap) return `<div class="wrow gap"><span class="wl">${esc(w.l)}${w.sub ? `<small>${esc(w.sub)}</small>` : ''}</span><span class="wv num">${v.residNone ? '없음' : fmtEok(Math.max(0, w.v)) + ' · ' + Math.max(0, v.residPct) + '%'}</span></div>`;
    const first = w.id === 'vnew';
    return `<div class="wrow ${w.minus ? 'minus' : ''}"><span class="wl">${esc(w.l)}${w.sub ? `<small>${esc(w.sub)}</small>` : ''}</span><span class="wv num">${first ? '' : (w.v < 0 ? '−' : '+')}${fmtEok(Math.abs(w.v))}</span></div>`;
  };
  const un = Math.max(0, v.resid);
  const optAmt = v.rbDiff + v.O;
  const tot = v.Vrent + optAmt + un || 1;
  const segs =
    `<span style="background:var(--l1);flex:${(v.Vrent / tot).toFixed(3)}"></span>` +
    `<span style="background:var(--l3);flex:${(optAmt / tot).toFixed(3)}"></span>` +
    (un > 0 ? `<span style="background:var(--l4);flex:${(un / tot).toFixed(3)}"></span>` : '');
  const beforePct = Math.round(v.residRentOnly / v.P * 100);
  return `
  <div class="card v4card">
    <div class="eyebrow">가격 명세 · 재건축 기준</div>
    <h2>${fmtEok(v.P)}은 무엇으로 되어 있나</h2>
    <div class="wf">${v.wf.map(rowOf).join('')}</div>
    <div class="stack" style="height:34px">${segs}</div>
    <div class="lgd">
      <div><span class="s" style="background:var(--l1)"></span>지금 상태의 값 ${fmtEok(v.Vrent)}</div>
      <div><span class="s" style="background:var(--l3)"></span>재건축${v.O > 0 ? '·호재' : ''} 값 ${fmtEok(optAmt)}</div>
      <div><span class="s" style="background:var(--l4)"></span>설명 안 됨 ${v.residNone ? '없음' : fmtEok(un)}</div>
    </div>
    <div class="readout">재건축을 못 담으면 설명되지 않는 부분이 <b>${fmtEok(Math.max(0, v.residRentOnly))}(${Math.max(0, beforePct)}%)</b>이었습니다.
      재건축을 반영해 <b>${v.residNone ? '없음' : fmtEok(un) + `(${Math.max(0, v.residPct)}%)`}</b>${v.residNone ? '이 됐습니다' : '으로 줄었습니다'}.
      인근 신축 기준: ${rb.nearby.items.map(i => esc(i.name)).join(' · ')}${rb.nearby.scope === 'gu' ? ' <span class="subtle">(같은 동 신축 부족 — 구 전체에서 선정)</span>' : ''}</div>
  </div>`;
}

/* ── 재건축 한계 카드 — 접지 않고 본문 노출 ── */
function v4RebuildLimitsHtml(r) {
  const v = r.v4, rb = v.rb;
  const fairAtCont = c => {
    const rr = AptEngine.v4RebuildAt(v.R, rb.RnewGross, v.k, v.g, c, rb.p, rb.y, CFG);
    return Math.max(rr.Vold, rr.Vrebuild) + v.O;
  };
  const swing = Math.abs(fairAtCont(3) - fairAtCont(9));
  return `
  <div class="card v4card">
    <div class="eyebrow">이 계산이 못 하는 것 — 재건축</div>
    <div class="lede" style="margin-bottom:0">
      <b>분담금이 가장 불확실합니다.</b> 관리처분 인가 전에는 어떤 숫자도 추정치입니다.
      위 조정기에서 3억과 9억을 눌러보면 적정가가 <b>${fmtEok(swing)}</b> 움직입니다. 그만큼 이 값에 민감하다는 뜻입니다.<br><br>
      <b>기간도 그렇습니다.</b> 현재 ${esc(rb.stageRawLabel)} 단계 기준 ${rb.y}년을 가정했습니다.
      과거 지연 이력이 긴 단지는 진행 단계를 한 단계 낮춰 보는 편이 안전합니다.<br><br>
      <b>새 평형 배정은 동일 평형 유지를 가정했습니다.</b> 대지지분에 따라 더 큰 평형을 받거나 분담금이 달라질 수 있는데,
      조합의 관리처분 전에는 확정할 수 없어 반영하지 않았습니다.</div>
  </div>`;
}

/* ── B. 가격 명세 (첫 화면) ── */
function v4SpecHtml(r, bm) {
  const v = r.v4;
  if (v.rbAdopted) return v4SpecRebuildHtml(r);
  const colors = { live: 'var(--l1)', income: 'var(--l2)', fixed: 'var(--l3)', unknown: 'var(--l4)' };
  const segs = v.layers.filter(l => l.amt > 0).map(l =>
    `<span style="background:${colors[l.id]};flex:${Math.max(0.02, l.amt / v.P).toFixed(3)}"></span>`).join('');
  const rows = v.layers.map(l => `
    <div class="brow">
      <span class="dot" style="background:${colors[l.id]}"></span>
      <span class="lbl">${esc(l.label)}<small>${esc(l.sub)}</small></span>
      <span class="amt num">${l.id === 'unknown' && v.residNone ? '없음' : fmtEok(l.amt)}</span><span class="pct num">${l.id === 'unknown' && v.residNone ? '' : l.pct + '%'}</span>
    </div>`).join('');
  const explained = Math.min(100, 100 - (v.residNone ? 0 : v.layers[v.layers.length - 1].pct));
  const readout = v.residNone
    ? `가격 전체가 지금 살 수 있는 값과 소득 상승${v.events.length ? ', 확정 호재' : ''}로 설명됩니다 — 설명되지 않는 비중이 없습니다.`
    : `가격의 <b>${explained}%</b>는 지금 살 수 있는 값과 소득 상승${v.events.length ? ', 호재' : ''}로 설명됩니다. 나머지 ${fmtEok(v.resid)}은 맨 아래에서 다룹니다.`;
  const rentRows = [];
  if (v.rent.jeonse) {
    const j = v.rent.jeonse;
    rentRows.push(`<div class="brow2 ${v.rent.picked === 'jeonse' ? 'pick' : ''}"><span>전세 기준 (${fmtEok(j.v)} × ${(v.conv * 100).toFixed(1)}%)${v.rent.picked === 'jeonse' ? '<span class="pickmark">채택</span>' : ''}</span><span>${v.rent.picked === 'jeonse' ? '<b>' : ''}연 ${fmtMan(v.rent.Rj * 10000)}${v.rent.picked === 'jeonse' ? '</b>' : ''}</span></div>`);
  }
  if (v.rent.wolse) {
    const w = v.rent.wolse;
    rentRows.push(`<div class="brow2 ${v.rent.picked === 'wolse' ? 'pick' : ''}"><span>월세 기준 (보증금 ${fmtEok(w.dep)} + 월 ${fmtMan(w.mr)})${v.rent.picked === 'wolse' ? '<span class="pickmark">채택</span>' : ''}</span><span>${v.rent.picked === 'wolse' ? '<b>' : ''}연 ${fmtMan(v.rent.Rw * 10000)}${v.rent.picked === 'wolse' ? '</b>' : ''}</span></div>`);
  }
  const srcBits = [];
  if (v.rent.jeonse) srcBits.push(v.rent.jeonse.manual ? '전세는 입력하신 값'
    : v.rent.jeonse.fromMedian ? `전세 실거래 ${v.rent.jeonse.n || '—'}건 중앙값 (최근 ${v.rent.jeonse.windowMo || '—'}개월)`
    : `전세 신규계약 최근 ${v.rent.jeonse.n}건 평균 (${v.rent.jeonse.windowMo}개월 창${v.rent.jeonse.ext ? ' — 6개월 내 거래 부족으로 확대' : ''})`);
  if (v.rent.wolse) srcBits.push(`월세 신규계약 ${v.rent.wolse.n}건 평균 (최근 ${v.rent.wolse.windowMo}개월${v.rent.wolse.ext ? ' — 기간 확대' : ''})`);
  const why = v.rent.jeonseOnly
    ? `이 평형은 월세 실거래가 없어 <b>전세 신규계약만으로 산정</b>했습니다. 전세·월세 모두 갱신계약(5% 상한에 눌린 가격)은 제외합니다.`
    : `전세는 계약갱신 때문에 시세보다 눌려 있을 수 있습니다. 법정 전환 상한도 갱신에만 적용되고 신규계약은 자유롭습니다. 그래서 <b>둘 다 신규계약으로 환산해 높은 쪽</b>을 씁니다.`;
  return `
  <div class="card v4card">
    <div class="eyebrow">가격 명세</div>
    <h2>${fmtEok(v.P)}은 무엇으로 되어 있나</h2>
    <div class="stack">${segs}</div>
    ${rows}
    <div class="readout">${readout}</div>
    ${v.rb && v.rb.skipped ? `<p class="subtle" style="margin-top:8px">정비사업 단계(${esc(CFG.option.stageLabels[(r.cx.redev && r.cx.redev.stage) || 'none'] || '')})가 확인되지만 인근 신축 전월세 데이터가 없어 재건축 경로는 계산하지 못했습니다 — 현 상태 기준입니다.</p>` : ''}
    ${v.rb && v.rb.computed && !v.rbAdopted ? `<p class="subtle" style="margin-top:8px">재건축 경로도 계산했지만(${fmtEok(v.rb.Vrebuild)}) 현 상태 가치(${fmtEok(v.Vrent)})가 더 높아 현 상태 기준을 채택했습니다 — 아래 조정기에서 분담금·단계를 바꿔볼 수 있습니다.</p>` : ''}
    <div class="basis">
      <div class="t">실거주가치는 이렇게 잡았습니다</div>
      ${rentRows.join('')}
      <div class="why">${why} 채택한 임대료에서 세금·수리비·공실 몫 ${(v.costRate * 100).toFixed(0)}%를 뺀 값이 계산의 출발점입니다.<br><span class="subtle">${srcBits.map(esc).join(' · ')} · 전환율 ${(v.conv * 100).toFixed(1)}% (${esc(r.cx.district || '지역')} 시장 기준)</span></div>
    </div>
  </div>`;
}

/* ── C. 지난 10년 실적 ── */
function v4HistHtml(r) {
  const v = r.v4, h = v.hist;
  if (!h || v.gReq == null) return '';
  const gH = h.g, gNeed = v.gReq, gInc = v.gIncome;
  const dHist = h.src === 'self'
    ? `전세 ${fmtEok(h.oldDep)} → ${fmtEok(h.nowDep)}`
    : `${esc(h.guName || '')} 전세 평균 기준`;
  const needCap = v.gReqSat === 'high' ? `${(gNeed * 100).toFixed(0)}% 이상` : `${(gNeed * 100).toFixed(1)}%`;
  const exHist = gH - gInc, exNeed = gNeed - gInc;
  const diff = exNeed - exHist;
  const punch = diff > 0.002
    ? `지난 10년 이 단지${h.src === 'gu' ? '가 속한 지역' : ''}은 가구 소득보다 연 ${fmtGp(exHist)} ${exHist >= 0 ? '빠르게' : '느리게'} 올랐습니다.<br>지금 가격은 앞으로 <b>${fmtGp(exNeed)}</b>를 기대합니다. 과거보다 <b>${fmtGp(diff).replace('+', '')} 더</b> 요구하는 셈입니다.`
    : diff < -0.002
      ? `지난 10년 실적(연 ${fmtG(gH)})이 지금 가격이 요구하는 수준(연 ${needCap})보다 높습니다.<br>과거 흐름이 이어진다면 지금 가격은 무리한 기대가 아닙니다.`
      : `지금 가격이 요구하는 상승(연 ${needCap})은 지난 10년 실적(연 ${fmtG(gH)})과 거의 같습니다.`;
  const readout = diff > 0.002
    ? `과거 흐름이 그대로 이어지면 지금 가격은 대체로 설명됩니다. 다만 <b>과거보다 조금 더 좋아진다</b>는 전제가 붙어 있습니다.`
    : `과거 흐름만 이어져도 지금 가격이 설명되는 구간입니다.`;
  return `
  <div class="card v4card">
    <div class="eyebrow">지난 10년 실적</div>
    <h2>${h.src === 'self' ? '이 단지 임대료는 실제로 이렇게 올랐습니다' : '이 지역 임대료는 실제로 이렇게 올랐습니다'}</h2>
    <div class="track">
      <div class="tbox"><div class="k">지난 10년 · 실제</div><div class="v num">${(gH * 100).toFixed(1)}%</div><div class="d">${dHist}</div></div>
      <div class="arrow">→</div>
      <div class="tbox fut"><div class="k">앞으로 10년 · 필요</div><div class="v num">${needCap}</div><div class="d">월 ${fmtMan(h.nowMo)} → ${fmtMan(h.needMo)}</div></div>
    </div>
    <div style="margin-top:16px">
      <div class="bline"><span class="l">같은 기간 가구 소득 (전국)</span><span class="r num">연 ${fmtG(gInc)}</span></div>
      <div class="bline"><span class="l">${h.src === 'self' ? '이 단지가' : '이 지역이'} 더 오른 폭 (실적)</span><span class="r num">${fmtGp(exHist)}</span></div>
      <div class="bline"><span class="l">지금 가격이 기대하는 폭</span><span class="r num" style="color:var(--l-alert)">${fmtGp(exNeed)}</span></div>
    </div>
    <div class="punch">${punch}</div>
    <div class="readout">${readout}${h.src === 'gu' ? `<br><span class="subtle">이 단지의 10년 전 전세 실거래가 없어(신축 등) ${esc(h.guName || '지역')} 평균(${esc(h.oldQ || '')} → 현재, ㎡당 전세 기준)으로 계산했습니다. 지역 평균은 신축 입주 같은 단지 구성 변화를 포함한 참고치입니다.</span>` : `<br><span class="subtle">과거·현재 모두 전세 신규계약 보증금 기준(${esc(h.oldQ || '')} 분기 실거래 ${h.nOld || ''}건 → 현재)으로 같은 방식으로 비교했습니다.</span>`}</div>
  </div>`;
}

/* ── D. 인근 단지 비교 ── */
function v4NearHtml(r, bm) {
  if (!bm) return '';
  const v = r.v4;
  const vals = bm.all.map(x => x.resid);
  const lo = Math.min(...vals, 0), hi = Math.max(...vals, 5);
  const span = hi - lo || 1;
  const X = x => (6 + (x - lo) / span * 88).toFixed(1);
  const pins = bm.all.map(x => x.self
    ? `<div class="pin me" style="left:${X(x.resid)}%"></div><div class="plabel" style="left:${X(x.resid)}%">이 단지 ${x.resid <= 0 ? '0' : x.resid}%</div>`
    : `<div class="pin" style="left:${X(x.resid)}%" title="${esc(x.name)}"></div>`).join('');
  const selfResid = Math.max(0, v.residPct);
  const ord = ['첫', '두', '세', '네', '다섯', '여섯', '일곱', '여덟', '아홉', '열'][bm.rank - 1] || bm.rank + '';
  const title = bm.rank <= 10 ? `임대료가 ${ord} 번째로 든든하게 받쳐줍니다` : `임대료 받침이 ${bm.n}개 단지 중 ${bm.rank}번째입니다`;
  return `
  <div class="card v4card">
    <div class="eyebrow">${esc(bm.region)} ${bm.n}개 단지 중</div>
    <h2>${title}</h2>
    <div class="plot">
      <div class="axis"></div>
      ${pins}
      <div class="tick" style="left:${X(lo)}%">${lo}%</div>
      <div class="tick" style="left:${X(bm.med)}%">${bm.med}%</div>
      <div class="tick" style="left:${X(hi)}%">${hi}%</div>
    </div>
    <div class="cap">가로축 = 설명되지 않는 비중. 왼쪽일수록 지금 임대료가 가격을 잘 설명합니다.</div>
    <div class="readout">인근 ${bm.top.length}개 단지는 평균적으로 가격의 <b>${bm.med}%</b>가 설명되지 않습니다. 이 단지는 <b>${selfResid}%</b>로 ${selfResid < bm.med ? '평균보다 낮습니다' : selfResid > bm.med ? '평균보다 높습니다 — 그만큼 기대에 값을 지불하는 셈입니다' : '평균과 같습니다'}.</div>
  </div>`;
}

/* ── E. 적정가 ── */
function v4FairHtml(r, bm) {
  const v = r.v4, V = CFG.v4;
  const rowVal = g => v.fairAtG(g);
  const sc = v.scen;
  const card = (s, mid) => `<div class="sc ${mid ? 'mid' : ''}"><div class="k">${esc(s.label)}</div><div class="v num">${fmtEok(s.v)}</div><div class="d">${s.desc.map(esc).join('<br>')}</div></div>`;
  const vInfl = rowVal(0.02);
  const vInc = sc.base.v;
  const vNbr = bm && bm.gNbr != null ? rowVal(bm.gNbr) : null;
  const diff = v.P - vInc;
  const readout = diff > 0.05
    ? `소득이 오른 만큼 임대료가 오른다면 <b>${fmtEok(vInc)}</b>입니다. 차액 <b>${fmtEok(diff)}</b>은 이 단지가 평균보다 더 좋아진다고 볼 때만 설명됩니다.`
    : `소득이 오른 만큼 임대료가 오른다고 보면 <b>${fmtEok(vInc)}</b> — 지금 가격은 그 기준선 ${diff < -0.05 ? '아래' : '부근'}에 있습니다.`;
  const needSub = v.gReqSat === 'high' ? `연 ${(v.gReq * 100).toFixed(0)}% 이상을 기대하는 가격` : `연 ${(v.gReq * 100).toFixed(1)}%를 기대하는 가격`;
  return `
  <div class="card v4card">
    <div class="eyebrow">적정가</div>
    <h2>어디까지 인정하느냐에 달렸습니다</h2>
    <div class="scen">${card(sc.pess)}${card(sc.cons, true)}${card(sc.opti)}</div>
    <div class="basenote">기준 시나리오(현 금리 유지 + 소득 ${fmtG(V.gBase)})는 <b>${fmtEok(sc.base.v)}</b>입니다.</div>
    <div class="srow"><span class="s-l">전국 물가만큼만<small>연 2.0%</small></span><span class="s-r num">${fmtEok(vInfl)}</span></div>
    <div class="srow"><span class="s-l">가구 소득만큼<small>연 ${fmtG(V.gBase)} · 2024년 실적</small></span><span class="s-r num">${fmtEok(vInc)}</span></div>
    ${vNbr != null ? `<div class="srow"><span class="s-l">인근 평균만큼 기대받는다면<small>연 ${fmtG(bm.gNbr)}</small></span><span class="s-r num">${fmtEok(vNbr)}</span></div>` : ''}
    <div class="srow now"><span class="s-l">${v.manualPrice ? '입력하신 시세' : '최근 실거래'}<small>${needSub}</small></span><span class="s-r num">${fmtEok(v.P)}</span></div>
    <div class="readout">${readout}</div>
  </div>`;
}

/* ── F-재건축. 직접 조정하기 (재건축 경로 계산 단지 — 기존 컨트롤 + 단계·분담금·신축수준) ── */
function v4AdjustRebuildHtml(r) {
  const v = r.v4, V = CFG.v4, RB = V.rebuild, F = CFG.financial, rb = v.rb;
  const tr0 = v.events.find(e => e.id === 'transit');
  const histOpt = v.hist ? { g: v.hist.g, label: `연 ${fmtG(v.hist.g)}` } : null;
  const opt = (label, hint, pressed, data) =>
    `<button class="opt" ${data} aria-pressed="${pressed}">${esc(label)}<small>${esc(hint)}</small></button>`;
  const rateOpts = V.rateOptions.map(o => opt(o.label, o.hint, o.id === 'now', `data-k="${o.k}"`)).join('');
  const incOpts = V.incomeOptions.map(o => {
    if (o.id === 'hist') return histOpt ? opt(o.label, histOpt.label, false, `data-g="${histOpt.g}"`) : '';
    return opt(o.label, o.hint, o.id === 'nat', `data-g="${o.g}"`);
  }).join('');
  const supOpts = V.supplyOptions.map(o => opt(o.label, o.hint, o.id === 'norm', `data-d="${o.d}"`)).join('');
  const stgOpts = Object.entries(RB.stages).map(([id, s]) =>
    opt(s.label, `확률 ${(s.p * 100).toFixed(0)}% · ${s.y}년`, rb.stage === id, `data-p="${s.p}" data-y="${s.y}"`)).join('');
  const contOpts = RB.contributionOptions.map(o =>
    opt(o.label, o.hint, Math.abs(o.v - rb.cont) < 0.51, `data-v="${o.v}"`)).join('');
  const newOpts = RB.newLevelFactors.map(o => {
    const j = rb.nearby.avgJeonse != null ? Math.round(rb.nearby.avgJeonse * o.f * 10) / 10 + '억' : `×${o.f}`;
    return opt(j, o.label, o.f === 1, `data-f="${o.f}"`);
  }).join('');
  const trOpts = Object.entries(V.transitBuckets).map(([id, b]) =>
    opt(b.label, b.p > 0 ? `확률 ${(b.p * 100).toFixed(0)}% · ${b.y}년` : '계획 없음', (tr0 ? tr0.bucket : 'none') === id, `data-p="${b.p}" data-y="${b.y}"`)).join('');
  return `
  <div class="card v4card" id="adjCard">
    <div class="eyebrow">재건축 조건 조정하기</div>
    <h2>분담금과 기간을 바꿔보세요</h2>
    <div class="ctl"><div class="q">재건축 진행 단계</div>
      <div class="hint2">이 단지는 ${esc(rb.stageRawLabel)} 상태로 확인됩니다</div>
      <div class="opts" id="c-rbstage">${stgOpts}</div></div>
    <div class="ctl"><div class="q">분담금을 얼마로 볼까</div>
      <div class="hint2">관리처분 전이라 확정 금액이 없습니다 — 인근 사례 기준 추정</div>
      <div class="opts" id="c-cont">${contOpts}</div></div>
    <div class="ctl"><div class="q">새 아파트는 어느 수준이 될까</div>
      <div class="hint2">인근 신축 전세 실거래 ${rb.nearby.jeonseMin != null ? `${round1s(rb.nearby.jeonseMin)}~${round1s(rb.nearby.jeonseMax)}억 · 기준 ${rb.nearby.avgJeonse}억` : '기준값'} (${rb.nearby.items.map(i => esc(i.name)).join(' · ')})</div>
      <div class="opts" id="c-new">${newOpts}</div></div>
    <div class="ctl"><div class="q">앞으로 금리는</div>
      <div class="hint2">지금 ${esc(F.baseRate.label)} ${fmtPct(F.baseRate.value)} · ${esc(F.mortgageRate.label)} ${fmtPct(F.mortgageRate.value)} (${esc(F.baseRate.asOf)})</div>
      <div class="opts" id="c-rate">${rateOpts}</div></div>
    <div class="ctl"><div class="q">임대료를 낼 소득은 얼마나 오를까</div>
      <div class="hint2">전국 가구소득 2024년 +3.4% · 수도권 가구소득은 비수도권보다 20% 높음</div>
      <div class="opts" id="c-inc">${incOpts}</div></div>
    <div class="ctl"><div class="q">주변 전월세 수급은</div>
      <div class="hint2">멸실이 많으면 전월세가 부족해져 임대료가 더 오릅니다</div>
      <div class="opts" id="c-sup">${supOpts}</div></div>
    <div class="ctl"><div class="q">교통 호재는 어느 단계인가</div>
      <div class="hint2">${tr0 ? `이 단지는 ${esc(tr0.name)} ${esc(tr0.bucketLabel)} 상태입니다` : '확인된 교통 호재가 없습니다'}</div>
      <div class="opts" id="c-tr">${trOpts}</div></div>
    <div class="liveout">
      <div class="k">이 조건에서의 적정가</div>
      <div class="v num" id="adj-v"></div>
      <div class="lbar" id="adj-bar"></div>
      <div class="cmp" id="adj-c"></div>
    </div>
    <div class="sens" id="adj-s"></div>
    <div class="cap" style="margin-top:12px">재건축 값은 <b>확률 × 새 집 시나리오 + (1−확률) × 지금 상태 가치</b>로 계산합니다.
      무산돼도 땅은 남으므로 0이 되지 않습니다. 새 집 시나리오 = (새 아파트 가치 − 분담금) ÷ 기다림 할인 + 그동안의 임대료.</div>
  </div>`;
}
const round1s = x => Math.round(x * 10) / 10;
function wireV4AdjustRebuild(r) {
  const v = r.v4, V = CFG.v4, rb = v.rb;
  const tr0 = v.events.find(e => e.id === 'transit');
  const st = {
    k: V.k, g: V.gBase, sup: 0,
    p: rb.p, y: rb.y, cont: rb.cont, newF: 1,
    trP: tr0 ? tr0.p : 0, trY: tr0 ? tr0.y : 0
  };
  const calc = (o) => {
    const s = Object.assign({}, st, o || {});
    const g2 = s.g + s.sup;
    const rr = AptEngine.v4RebuildAt(v.R, rb.RnewGross * s.newF, s.k, g2, s.cont, s.p, s.y, CFG);
    const Ot = s.trP > 0 ? s.trP * Math.min(V.uplift.transit, V.upliftCapPct.transit * v.P) / Math.pow(1 + s.k, s.trY) : 0;
    return { rr, Ot, fair: Math.max(rr.Vold, rr.Vrebuild) + Ot };
  };
  const render = () => {
    const c = calc();
    const d = v.P - c.fair;
    const resid = Math.round(d / v.P * 100);
    $('adj-v').textContent = fmtEok(c.fair);
    $('adj-c').innerHTML = `${v.manualPrice ? '입력 시세' : '최근 실거래'} ${fmtEok(v.P)}보다 <b>${fmtEok(Math.abs(d))} ${d > 0.049 ? '낮습니다' : d < -0.049 ? '높습니다' : '와 비슷합니다'}</b> · 설명되지 않는 비중 <b>${resid > 0 ? resid + '%' : '없음'}</b>`;
    const inc = Math.max(0, c.rr.Vold - v.R / st.k);
    const rbAmt = Math.max(0, c.fair - c.rr.Vold);
    const un = Math.max(0, d);
    const tot = (v.R / st.k) + inc + rbAmt + un || 1;
    $('adj-bar').innerHTML =
      `<span style="background:#8FB4DA;flex:${((v.R / st.k) / tot).toFixed(3)}"></span>` +
      `<span style="background:#4E86BE;flex:${(inc / tot).toFixed(3)}"></span>` +
      (rbAmt > 0 ? `<span style="background:#2E8B7A;flex:${(rbAmt / tot).toFixed(3)}"></span>` : '') +
      (un > 0 ? `<span style="background:rgba(255,255,255,.28);flex:${(un / tot).toFixed(3)}"></span>` : '');
    const c2 = calc({ cont: st.cont + 1 });
    $('adj-s').innerHTML = `분담금이 <b>1억 늘면</b> 적정가가 <b>${fmtEok(Math.max(0, c.fair - c2.fair))}</b> 낮아집니다 · 지금 상태로만 보면 <b>${fmtEok(c.rr.Vold)}</b>`;
  };
  const group = (id, fn) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener('click', e => {
      const b = e.target.closest('.opt');
      if (!b) return;
      el.querySelectorAll('.opt').forEach(x => x.setAttribute('aria-pressed', 'false'));
      b.setAttribute('aria-pressed', 'true');
      fn(b); render();
    });
  };
  group('c-rbstage', b => { st.p = parseFloat(b.dataset.p); st.y = parseFloat(b.dataset.y); });
  group('c-cont', b => { st.cont = parseFloat(b.dataset.v); });
  group('c-new', b => { st.newF = parseFloat(b.dataset.f); });
  group('c-rate', b => { st.k = parseFloat(b.dataset.k); });
  group('c-inc', b => { st.g = parseFloat(b.dataset.g); });
  group('c-sup', b => { st.sup = parseFloat(b.dataset.d); });
  group('c-tr', b => { st.trP = parseFloat(b.dataset.p); st.trY = parseFloat(b.dataset.y); });
  render();
}

/* ── F. 직접 조정하기 ── */
function v4AdjustHtml(r) {
  if (r.v4.rb && r.v4.rb.computed) return v4AdjustRebuildHtml(r);
  const v = r.v4, V = CFG.v4, F = CFG.financial;
  const tr0 = v.events.find(e => e.id === 'transit');
  const rb0 = v.events.find(e => e.id === 'redev');
  const histOpt = v.hist ? { g: v.hist.g, label: `연 ${fmtG(v.hist.g)}` } : null;
  const opt = (id, label, hint, pressed, data) =>
    `<button class="opt" ${data} aria-pressed="${pressed}">${esc(label)}<small>${esc(hint)}</small></button>`;
  const rateOpts = V.rateOptions.map(o => opt('r', o.label, o.hint, o.id === 'now', `data-k="${o.k}"`)).join('');
  const incOpts = V.incomeOptions.map(o => {
    if (o.id === 'hist') {
      if (!histOpt) return '';
      return opt('g', o.label, histOpt.label, false, `data-g="${histOpt.g}"`);
    }
    return opt('g', o.label, o.hint, o.id === 'nat', `data-g="${o.g}"`);
  }).join('');
  const supOpts = V.supplyOptions.map(o => opt('s', o.label, o.hint, o.id === 'norm', `data-d="${o.d}"`)).join('');
  const rbOpts = Object.entries(V.redevBuckets).map(([id, b]) =>
    opt('rb', b.label, b.p > 0 ? `확률 ${(b.p * 100).toFixed(0)}% · ${b.y}년` : '신축·준신축', (rb0 ? rb0.bucket : 'none') === id, `data-p="${b.p}" data-y="${b.y}"`)).join('');
  const trOpts = Object.entries(V.transitBuckets).map(([id, b]) =>
    opt('tr', b.label, b.p > 0 ? `확률 ${(b.p * 100).toFixed(0)}% · ${b.y}년` : '계획 없음', (tr0 ? tr0.bucket : 'none') === id, `data-p="${b.p}" data-y="${b.y}"`)).join('');
  return `
  <div class="card v4card" id="adjCard">
    <div class="eyebrow">직접 조정하기</div>
    <h2>내 생각을 넣으면 얼마인가</h2>
    <div class="ctl"><div class="q">앞으로 금리는</div>
      <div class="hint2">지금 ${esc(F.baseRate.label)} ${fmtPct(F.baseRate.value)} · ${esc(F.mortgageRate.label)} ${fmtPct(F.mortgageRate.value)} (${esc(F.baseRate.asOf)})</div>
      <div class="opts" id="c-rate">${rateOpts}</div></div>
    <div class="ctl"><div class="q">임대료를 낼 소득은 얼마나 오를까</div>
      <div class="hint2">전국 가구소득 2024년 +3.4% · 수도권 가구소득은 비수도권보다 20% 높음</div>
      <div class="opts" id="c-inc">${incOpts}</div></div>
    <div class="ctl"><div class="q">주변 전월세 수급은</div>
      <div class="hint2">재건축·재개발 멸실이 많으면 전월세가 부족해져 임대료가 더 오릅니다</div>
      <div class="opts" id="c-sup">${supOpts}</div></div>
    <div class="ctl"><div class="q">재건축은 어느 단계인가</div>
      <div class="hint2">${rb0 ? `이 단지는 ${esc(rb0.bucketLabel)} 단계로 확인됩니다` : '재건축·리모델링 단지용 — 단계가 올라갈수록 확률이 커지고 기다리는 기간이 짧아집니다'}</div>
      <div class="opts" id="c-rb">${rbOpts}</div></div>
    <div class="ctl"><div class="q">교통 호재는 어느 단계인가</div>
      <div class="hint2">${tr0 ? `이 단지는 ${esc(tr0.name)} ${esc(tr0.bucketLabel)} 상태입니다` : '확인된 교통 호재가 없습니다 — 아는 계획이 있으면 선택해 보세요'}</div>
      <div class="opts" id="c-tr">${trOpts}</div></div>
    <div class="liveout">
      <div class="k">이 조건에서의 적정가</div>
      <div class="v num" id="adj-v"></div>
      <div class="lbar" id="adj-bar"></div>
      <div class="cmp" id="adj-c"></div>
    </div>
    <div class="cap" style="margin-top:12px">할인율은 금리에 연동해 움직입니다. 재건축·교통 호재는 '성공 확률 × 예상 상승분 ÷ 기다리는 기간'으로 계산합니다 (상승분 기본값: 재건축 ${V.uplift.redev}억 · 교통 ${V.uplift.transit}억, 가격 대비 상한 적용).</div>
  </div>`;
}
function wireV4Adjust(r) {
  if (r.v4.rb && r.v4.rb.computed) return wireV4AdjustRebuild(r);
  const v = r.v4, V = CFG.v4;
  const tr0 = v.events.find(e => e.id === 'transit');
  const rb0 = v.events.find(e => e.id === 'redev');
  const st = {
    k: V.k, g: V.gBase, sup: 0,
    rbP: rb0 ? rb0.p : 0, rbY: rb0 ? rb0.y : 0,
    trP: tr0 ? tr0.p : 0, trY: tr0 ? tr0.y : 0
  };
  const calc = () => {
    const evs = [];
    if (st.rbP > 0) evs.push({ p: st.rbP, y: st.rbY, up: Math.min(V.uplift.redev, V.upliftCapPct.redev * v.P) });
    if (st.trP > 0) evs.push({ p: st.trP, y: st.trY, up: Math.min(V.uplift.transit, V.upliftCapPct.transit * v.P) });
    const O = evs.reduce((s, e) => s + e.p * e.up / Math.pow(1 + st.k, e.y), 0);
    const Vrent = AptEngine.pv2Stage(v.R, st.k, st.g + st.sup, V.gTerm, V.years, V.termMinSpread).v;
    return { fair: Vrent + O, Vrent, O, L1: v.R / st.k };
  };
  const render = () => {
    const c = calc();
    const d = v.P - c.fair;
    const resid = Math.round(d / v.P * 100);
    $('adj-v').textContent = fmtEok(c.fair);
    $('adj-c').innerHTML = `${v.manualPrice ? '입력 시세' : '최근 실거래'} ${fmtEok(v.P)}보다 <b>${fmtEok(Math.abs(d))} ${d > 0.049 ? '낮습니다' : d < -0.049 ? '높습니다' : '와 비슷합니다'}</b> · 설명되지 않는 비중 <b>${resid > 0 ? resid + '%' : '없음'}</b>`;
    const inc = Math.max(0, c.Vrent - c.L1), un = Math.max(0, d);
    const tot = c.L1 + inc + c.O + un || 1;
    $('adj-bar').innerHTML =
      `<span style="background:#8FB4DA;flex:${(c.L1 / tot).toFixed(3)}"></span>` +
      `<span style="background:#4E86BE;flex:${(inc / tot).toFixed(3)}"></span>` +
      (c.O > 0 ? `<span style="background:#2E8B7A;flex:${(c.O / tot).toFixed(3)}"></span>` : '') +
      (un > 0 ? `<span style="background:rgba(255,255,255,.28);flex:${(un / tot).toFixed(3)}"></span>` : '');
  };
  const group = (id, fn) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener('click', e => {
      const b = e.target.closest('.opt');
      if (!b) return;
      el.querySelectorAll('.opt').forEach(x => x.setAttribute('aria-pressed', 'false'));
      b.setAttribute('aria-pressed', 'true');
      fn(b); render();
    });
  };
  group('c-rate', b => { st.k = parseFloat(b.dataset.k); });
  group('c-inc', b => { st.g = parseFloat(b.dataset.g); });
  group('c-sup', b => { st.sup = parseFloat(b.dataset.d); });
  group('c-rb', b => { st.rbP = parseFloat(b.dataset.p); st.rbY = parseFloat(b.dataset.y); });
  group('c-tr', b => { st.trP = parseFloat(b.dataset.p); st.trY = parseFloat(b.dataset.y); });
  render();
}

/* ── G. 계산 밖의 가치 — 단지 제원 + 역 가치 패널 + 정성 3장 ── */
function v4QualCards(r) {
  const cx = r.cx, v = r.v4, ed = r.hedonic.eduDetail, t = r.transit;
  const cards = [];
  const age = cx.builtYear ? (new Date().getFullYear() - cx.builtYear) : null;
  // 1) 상품성 — 대단지·신축·주차
  if ((cx.households || 0) >= 1000 || (age != null && age <= 10) || (cx.parkingRatio || 0) >= 1.2) {
    const bits = [];
    if ((cx.households || 0) >= 1000) bits.push(`${cx.households.toLocaleString()}세대 대단지는 커뮤니티·관리 인력의 분담 규모가 커서 같은 시설도 세대당 부담이 작습니다`);
    if (age != null && age <= 10) bits.push(`준공 ${age}년차 신축급 상품은 설계·커뮤니티에서 구축과 체감 차이가 큽니다`);
    if ((cx.parkingRatio || 0) >= 1.2) bits.push(`주차 ${cx.parkingRatio}대/세대는 여유 있는 수준입니다`);
    cards.push({
      t: (age != null && age <= 10 ? '신축 ' : '') + ((cx.households || 0) >= 1000 ? '대단지 상품성' : '상품성'),
      d: bits.join('. ') + '. 상품성은 세입자보다 소유자가 값을 치르는 항목이라, 임대료보다 매매가에 먼저 반영됩니다.',
      tags: [(cx.households || 0) >= 1000 ? `${cx.households.toLocaleString()}세대` : null, cx.parkingRatio ? `주차 ${cx.parkingRatio}대` : null, age != null && age <= 10 ? `${cx.builtYear}년 준공` : null].filter(Boolean)
    });
  }
  // 2) 교육환경 — 생활권
  if (ed && ed.zoneName) {
    cards.push({
      t: `${ed.zoneName} 교육환경`,
      d: `${ed.zoneName} 교육생활권${ed.adjacent ? ' 인접권' : ''}에 있습니다. 학군 수요는 전세(거주)보다 매매(정착)로 들어오는 경향이 있어, 임대료에는 덜 잡히고 가격에는 잡히는 대표 항목입니다.`,
      tags: [ed.zoneName, t ? `역 교육환경 ${Math.round(t.primary.comps.edu)}` : null].filter(Boolean)
    });
  }
  // 3) 자연·생활권 (상세 프로필) 또는 역세권 거주민 경제력 (자동)
  const nat = cx.nature;
  if (nat && (nat.hanRiver || nat.bigPark || nat.parkMin <= 10)) {
    const bits = [];
    if (nat.bigPark || nat.parkMin <= 10) bits.push(`대형 공원·녹지가 도보권(${nat.parkMin}분)에 있습니다`);
    if (nat.hanRiver) bits.push(`한강 접근 ${nat.riverMin}분${nat.hanRiverView ? ' · 조망 세대 보유' : ''}`);
    cards.push({
      t: '녹지·수변 환경',
      d: bits.join('. ') + '. 녹지와 조망은 매일 쓰는 가치인데도 월세로 따로 청구되지 않아, 임대료보다 매매가에 먼저 반영되는 항목입니다.',
      tags: [nat.bigPark ? '대형 공원' : null, nat.hanRiver ? '한강 접근' : null].filter(Boolean)
    });
  } else if (t && t.primary.comps.econ >= 80) {
    cards.push({
      t: '생활권 거주민 경제력',
      d: `${t.primary.st}역 생활권의 거주민 소득·소비 수준이 수도권 상위권입니다. 구매력 높은 이웃과 상권은 임대료보다 매매 선호에 먼저 반영되는 항목입니다.`,
      tags: [`${t.primary.st}역 생활권`, '경제력 상위']
    });
  }
  return cards.slice(0, 3);
}
function v4BeyondHtml(r) {
  const cx = r.cx, v = r.v4, t = r.transit;
  const cell = (k, val) => `<div><div class="k">${k}</div><div class="v num">${val}</div></div>`;
  const grid = [
    cell('세대수', cx.households != null ? `${cx.households.toLocaleString()}<small>세대</small>` : '<small>미확인</small>'),
    cell('용적률', cx.far != null ? `${cx.far}<small>%</small>` : '<small>미확인</small>'),
    cell('주차', cx.parkingRatio != null ? `${cx.parkingRatio}<small>대/세대</small>` : '<small>미확인</small>'),
    cell('준공', cx.builtYear ? `${cx.builtYear}<small>년</small>` : '<small>미확인</small>')
  ].join('');
  const stFull = t
    ? `<div class="full"><div class="k">교통</div><div class="v">${t.primary.lines.map(esc).join('·')} ${esc(t.primary.st)}역 <small>도보 ${t.primary.min}분${t.primary.status === 'ESTIMATED' ? ' (추정)' : ''}</small></div>
       <button class="maplink" id="btn-stn" aria-expanded="false">🚇 역 가치지도 보기</button></div>`
    : `<div class="full"><div class="k">교통</div><div class="v"><small>역 연결 미확인</small></div></div>`;
  const rdFull = `<div class="full"><div class="k">정비사업</div><div class="v">${esc(CFG.option.stageLabels[(cx.redev && cx.redev.stage) || 'none'])} <small>${cx.builtYear ? cx.builtYear + '년 준공' : ''}</small></div></div>`;
  const quals = v4QualCards(r);
  const residTxt = v && !v.residNone ? fmtEok(v.resid) : null;
  const qualHtml = quals.length ? quals.map((q, i) => `
    <div class="qual">
      <div class="qh"><span class="qn">${i + 1}</span><span class="qt">${esc(q.t)}</span></div>
      <div class="qd">${q.d}</div>
      <div>${q.tags.map(tg => `<span class="qtag">${esc(tg)}</span>`).join('')}</div>
    </div>`).join('')
    : '<p class="subtle">자동 확인 데이터로는 계산 밖 가치 후보를 특정하지 못했습니다 — 조망·브랜드·커뮤니티 같은 요소는 현장 확인이 필요합니다.</p>';
  return `
  <div class="card v4card" id="beyondCard">
    <div class="eyebrow">계산 밖의 가치</div>
    <h2>${residTxt ? `설명되지 않는 ${residTxt},<br>어디서 왔을까` : '숫자에 안 잡히는 가치들'}</h2>
    <div class="spec">${grid}${stFull}${rdFull}</div>
    <div id="stnpanel" class="stnpanel">${t ? v4StationPanel(r) : ''}</div>
    <div style="margin:22px 0 14px;font-size:14px;color:var(--ink2);line-height:1.65">
      앞의 계산은 임대료로 설명되는 부분까지입니다.
      아래는 <b style="color:var(--ink)">아직 임대료에 다 반영되지 않았지만 매수자는 값을 치르는 것</b>들입니다.
      숫자로 못 잡아 계산에서 뺐고${residTxt ? `, 그래서 ${residTxt}이 남았습니다` : ''}.
    </div>
    ${qualHtml}
    <div class="readout">${residTxt
      ? `이런 요소를 인정한다면 ${residTxt}은 거품이 아니라 <b>아직 계산에 못 담은 가치</b>입니다. 인정하지 않는다면 그만큼 비싼 값입니다. <b>그 판단까지는 이 도구가 대신 해드릴 수 없습니다.</b>`
      : `이 단지는 임대료와 소득 상승만으로 가격이 설명되는 구간입니다 — 위 요소들은 그 위에 얹힌 덤에 가깝습니다.`}</div>
  </div>`;
}
function v4StationPanel(r) {
  const t = r.transit, p = t.primary, v = r.v4;
  const lineName = p.lines[0];
  const lineColor = (typeof LINE_COLOR !== 'undefined' && LINE_COLOR[lineName]) || 'var(--accent)';
  const lineMates = RAIL_LINES.filter(l => l.name === lineName && !l.overlay).flatMap(l => l.stations).filter(s => STN.stations[s]);
  const lineRank = lineMates.length ? lineMates.slice().sort((a, b) => STN.stations[b].sv - STN.stations[a].sv).indexOf(p.st) + 1 : null;
  const vrow = (k, val) => `<div class="vrow"><span class="vl">${k}</span><span class="vtrack"><span class="vfill" style="width:${Math.round(val)}%;background:${lineColor}"></span></span><span class="vn num">${Math.round(val)}</span></div>`;
  const jm = t.jobMinutes || p.jobMinutes || {};
  const timeRows = [['JAMSIL', '잠실'], ['GBD', '강남'], ['YBD', '여의도'], ['CBD', '광화문']]
    .filter(([id]) => jm[id] != null)
    .map(([id, nm]) => `<div class="timerow"><span class="tl">${nm}</span><span class="tr num">${jm[id]}분</span></div>`).join('');
  const ev = v ? v.events.find(e => e.id === 'transit') : null;
  const evNote = ev
    ? `<div class="stnnote"><b>${esc(ev.name)}</b> — ${esc(ev.bucketLabel)} 단계입니다. 개통되면 이 역의 업무지 접근이 좋아집니다. 이 효과는 위 명세의 '${esc(ev.name)} ${fmtEok(ev.amt || 0)}'에 이미 반영돼 있습니다.</div>`
    : '';
  return `
    <div class="stnhead" style="background:${lineColor}">
      <div class="n">${esc(p.st)}역 · ${p.lines.map(esc).join('·')}</div>
      <div class="r">${lineRank ? `${esc(lineName)} ${lineMates.length}개 역 중 <b>${lineRank}위</b> · ` : ''}수도권 전체 <b>${p.rank}위</b> / ${Object.keys(STN.stations).length}개 역</div>
    </div>
    <div class="stnbody">
      <div class="sect">역 가치 산정 변수</div>
      ${vrow('강남권 접근', t.gangnamScore)}
      ${vrow('일자리 접근', t.jobScore)}
      ${vrow('교육환경', p.comps.edu)}
      ${vrow('역세권 경제력', p.comps.econ)}
      <div class="sect" style="margin-top:16px">주요 업무지구까지 (대기·환승 포함 체감시간)</div>
      ${timeRows}
      ${evNote}
      <button class="maplink" id="btn-fullmap" style="margin-top:12px">🗺 수도권 전체 역 가치지도 열기</button>
    </div>`;
}

/* ── H. 접힘 4종 ── */
function v4CollapsesHtml(r, bm) {
  const v = r.v4, V = CFG.v4;
  const rentRows = [];
  rentRows.push(`<tr><td>기준 가격 (${v.manualPrice ? '입력 시세' : '최근 실거래'})</td><td>${fmtEok(v.P)}${v.deal && !v.manualPrice ? ` (${esc(v.deal.date)}${v.deal.floor ? ' · ' + v.deal.floor + '층' : ''})` : ''}</td></tr>`);
  if (v.rent.jeonse) rentRows.push(`<tr><td>전세 신규계약 ${v.rent.jeonse.manual ? '(입력값)' : `(${v.rent.jeonse.n}건 평균 · ${v.rent.jeonse.windowMo}개월)`}</td><td>${fmtEok(v.rent.jeonse.v)}</td></tr>`);
  if (v.rent.wolse) rentRows.push(`<tr><td>월세 신규계약 (${v.rent.wolse.n}건 평균 · ${v.rent.wolse.windowMo}개월)</td><td>보증 ${fmtEok(v.rent.wolse.dep)} / 월 ${fmtMan(v.rent.wolse.mr)}</td></tr>`);
  rentRows.push(`<tr><td>전월세전환율 (${esc(r.cx.district || '지역')})</td><td>${(v.conv * 100).toFixed(1)}%</td></tr>`);
  rentRows.push(`<tr><td>채택 임대료 (${v.rent.picked === 'wolse' ? '월세' : '전세'} 기준, 높은 쪽)</td><td>연 ${fmtMan(v.Rgross * 10000)}</td></tr>`);
  rentRows.push(`<tr><td>세금·수리비·공실 차감</td><td>−${(v.costRate * 100).toFixed(0)}%</td></tr>`);
  rentRows.push(`<tr><td>요구수익률 (할인율)</td><td>${(v.k * 100).toFixed(1)}%</td></tr>`);
  rentRows.push(`<tr><td>기준 성장률</td><td>연 ${fmtG(v.g)}</td></tr>`);
  rentRows.push(`<tr><td>계산 방식</td><td>10년 성장 + 이후 물가(${fmtG(v.gTerm)}) 수렴</td></tr>`);
  for (const e of v.events) rentRows.push(`<tr><td>${esc(e.name)} 옵션가치</td><td>${(e.p * 100).toFixed(0)}% × ${fmtEok(e.upliftEff != null ? e.upliftEff : e.uplift)} ÷ ${e.y}년 할인 = ${fmtEok(e.amt || 0)}</td></tr>`);
  return `
  <details class="v4acc"><summary>숫자는 어떻게 나왔나</summary><div class="dbody">
    전세와 월세를 각각 신규계약 실거래로 환산해 높은 쪽을 임대료로 잡고, 소유자가 부담하는 세금·수리비·공실 몫을 뺀 뒤,
    그 금액이 매년 얼마나 올라야 지금 가격이 나오는지를 거꾸로 계산했습니다. 역산은 '10년 성장 + 이후 물가 수렴' 방식 하나만 씁니다 —
    영구 성장 가정의 한 줄 나눗셈은 성장률 0.1%p에 답이 널뛰어 쓰지 않습니다.
    <table>${rentRows.join('')}</table>
    <div class="src2">국토교통부 실거래가 공개 API (매매·전월세, 갱신계약 제외) · ${esc(state.liveSel ? liveAsOf() : DATA.meta.asOf)} 기준</div>
  </div></details>
  <details class="v4acc"><summary>백데이터 — 소득은 실제로 얼마나 올랐나</summary><div class="dbody">
    <b>전국 가구 평균소득</b>
    <table>
      <tr><th>연도</th><th>평균소득</th><th>전년비</th></tr>
      <tr><td>2022년</td><td>6,762만원</td><td>+4.5%</td></tr>
      <tr><td>2023년</td><td>7,185만원</td><td>+6.3%</td></tr>
      <tr><td>2024년</td><td>7,427만원</td><td>+3.4%</td></tr>
    </table>
    <div class="src2">국가데이터처·한국은행·금감원 가계금융복지조사</div>
    <div style="margin-top:16px"><b>지역별 가구소득 (2024년)</b></div>
    <table>
      <tr><td>수도권</td><td>8,118만원</td></tr>
      <tr><td>비수도권</td><td>6,752만원</td></tr>
      <tr><td>격차</td><td>+20.2%</td></tr>
    </table>
    <div class="src2">전국 하나로 묶으면 서울이 과소평가되는 이유입니다. 구 단위 소득 분리는 다음 작업입니다.</div>
    <div style="margin-top:16px"><b>임금과 집값 (2015 → 2025)</b></div>
    <table>
      <tr><td>근로자 월평균 임금</td><td>+39% (연 3.4%)</td></tr>
      <tr><td>서울 아파트 ㎡당 실거래</td><td>644만 → 1,650만 (2.5배, 연 9.9%)</td></tr>
    </table>
    <div class="src2">집값이 소득보다 3배 빠르게 올랐습니다. 이 모형이 집값이 아니라 임대료를 기준으로 삼는 이유입니다.</div>
    <div style="margin-top:16px"><b>전월세전환율</b> — 법정 상한(기준금리+2%p)은 갱신·조건변경에만 강제되고 신규계약은 제한이 없습니다. 계산에는 지역·유형별 시장 전환율을 씁니다.</div>
    ${v.hist ? `<div style="margin-top:16px"><b>이 단지 10년 실적의 근거</b> — ${v.hist.src === 'self'
      ? `${esc(v.hist.oldQ || '')} 분기 전세 실거래 ${v.hist.nOld}건 중앙값 ${fmtEok(v.hist.oldDep)} → 현재 신규계약 ${fmtEok(v.hist.nowDep)} (같은 평형·같은 방식). 전환율 변화는 반영하지 않은 보증금 기준 비교입니다.`
      : `이 단지의 10년 전 실거래가 없어 ${esc(v.hist.guName || '')} ㎡당 전세 중앙값(${esc(v.hist.oldQ || '')} → 현재)을 썼습니다. 신축 입주 등 구성 변화가 섞인 참고치입니다.`}</div>` : ''}
  </div></details>
  <details class="v4acc"><summary>왜 전국 물가를 안 쓰나</summary><div class="dbody">
    알고 싶은 건 '이 집 임대료가 얼마나 오르나'이고, 임대료는 그 동네 사람들의 소득을 따라갑니다.<br><br>
    <b>첫째, 물가지수에는 자가주거비가 거의 빠져 있습니다.</b> 집값·집세 반영 비중이 낮아 주거 부담의 상승을 잡아내지 못합니다.<br><br>
    <b>둘째, 전국 물가는 서울과 지방을 하나로 묶습니다.</b> 수도권 가구소득이 비수도권보다 20% 높은데 같은 숫자를 쓰면 서울은 항상 비싸 보이고 지방은 항상 싸 보입니다.<br><br>
    그래서 기준 성장률은 물가(2.0%)가 아니라 가구소득 증가율(3.4%)을 씁니다. 물가를 쓰면 같은 집의 설명되지 않는 부분이 훨씬 커집니다 — 위 적정가 표의 '전국 물가만큼만' 행이 그 값입니다.
  </div></details>
  <details class="v4acc"><summary>이 진단이 못 하는 것</summary><div class="dbody">
    내년에 오를지 내릴지는 알 수 없습니다. 지금 가격이 무엇에 기대고 있는지만 봅니다.<br><br>
    호가(매물 가격)는 수집하지 않습니다. 거래로 확인되지 않은 가격이라 실제보다 높거나 낮을 수 있고, 명세는 실거래만 씁니다.<br><br>
    요구수익률(할인율) ${(CFG.v4.k * 100).toFixed(1)}%는 판단으로 정한 숫자입니다. 위 '직접 조정하기'에서 금리를 바꾸면 이 값이 함께 움직이고, 적정가가 얼마나 민감한지 바로 볼 수 있습니다.<br><br>
    인근 단지 비교에는 각 단지의 재건축·교통 호재를 반영하지 못했습니다(자동 확인 불가) — 호재가 있는 단지는 실제보다 오른쪽(설명 안 되는 쪽)에 있을 수 있습니다.<br><br>
    맨 아래 정성 요소(상품성·환경·교육)는 숫자로 환산하지 않았습니다. 환산하려 들면 근거 없는 가중치를 만들게 되고, 그러면 모형 전체가 조작 가능해집니다. 그래서 계산에서 빼고 판단 재료로만 제시합니다.
  </div></details>`;
}

/* ── v4 데이터 없음(전월세 실거래 없음) 폴백 ── */
function v4FallbackHtml(r) {
  return `
  <div class="warnbox" style="margin-bottom:12px"><b>임대 기반 명세를 만들 수 없습니다</b> —
  이 평형은 전월세 실거래가 확인되지 않아 가격 명세(실거주가치·성장·잔여)를 계산하지 못했습니다.
  임의 가정값으로 채우지 않습니다. STEP 2에서 전세 시세를 입력하면 같은 명세로 분석합니다.</div>`;
}

/* ── 결과 렌더 (전체 조립) ── */
function renderReport(r) {
  const v = r.v4;
  const bm = v ? v4BenchmarkOf(r) : null;
  $('report').innerHTML = `
  <div class="v4wrap">
    ${v4HeadHtml(r)}
    ${v && v.rbAdopted ? v4RebuildPathHtml(r) : ''}
    ${v ? v4SpecHtml(r, bm) : v4FallbackHtml(r)}
    ${v ? v4HistHtml(r) : ''}
    ${v ? v4NearHtml(r, bm) : ''}
    ${v ? v4FairHtml(r, bm) : ''}
    ${v ? v4AdjustHtml(r) : ''}
    ${v && v.rbAdopted ? v4RebuildLimitsHtml(r) : ''}
    ${v4BeyondHtml(r)}
    ${v ? v4CollapsesHtml(r, bm) : ''}

    <div class="card v4card" id="cmpCard">
      <div class="eyebrow">비교</div>
      <h2>다른 단지와 같은 잣대로</h2>
      <p class="hint">같은 돈으로 무엇을 사는 것인지 — 비교 단지도 완전히 동일한 데이터 경로와 계산으로 봅니다.</p>
      <div class="grid2">
        <div><label class="mini">상세 프로필 단지<select id="cmpSel"><option value="">선택하세요</option>${DATA.complexes.filter(c => c.id !== r.cx.id).map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></label></div>
        <div><label class="mini">평형<select id="cmpArea" disabled></select></label></div>
      </div>
      ${LIVE.status === 'ready' ? `<label class="mini" style="display:block;margin-top:8px">또는 전체 단지 검색 (실거래 자동수집)<input type="text" class="box" id="cmpQ" placeholder="예: 고덕아르테온, 래미안대치팰리스"></label>
      <div id="cmpQOut"></div>` : ''}
      <div id="cmpOut"></div>
    </div>

    <div class="card v4card" id="shareCard">
      <div class="eyebrow">공유</div>
      <h2>결과 카드 저장</h2>
      <p class="hint">가격 명세를 1장 이미지로 저장해 공유하세요.</p>
      <button class="btn ghost" id="shareGen" style="width:100%">📸 결과 카드 만들기</button>
      <div id="shareOut" style="margin-top:10px;text-align:center"></div>
    </div>

    <div class="v4foot">
      국토교통부 실거래가 공개 API · K-apt 공동주택 정보 · 지역별 전월세전환율 · 가계금융복지조사 기준 · ${esc(state.liveSel ? liveAsOf() : DATA.meta.asOf)}<br>
      이 진단은 현재 가격이 무엇에 기대고 있는지 이해를 돕는 참고자료이며, 미래 예측이나 투자 권유가 아닙니다.
      개별 동·층·향·내부 상태는 반영되지 않습니다.
    </div>
    ${DEBUG_MODE ? `<div class="card"><h2>🛠 Calculation Trace (debug)</h2>
    <div class="tblwrap"><table><tbody>${r.trace.map(([k, val]) => `<tr><td style="white-space:nowrap">${esc(k)}</td><td style="text-align:left;white-space:normal">${esc(String(val))}</td></tr>`).join('')}</tbody></table></div></div>` : ''}
  </div>`;

  if (v) wireV4Adjust(r);
  const bs = $('btn-stn');
  if (bs) bs.onclick = () => {
    const panel = $('stnpanel');
    const open = panel.classList.toggle('open');
    bs.setAttribute('aria-expanded', open);
    bs.textContent = open ? '🚇 역 가치지도 닫기' : '🚇 역 가치지도 보기';
  };
  const bf = $('btn-fullmap');
  if (bf && r.transit) bf.onclick = () => openMap(r.transit.primary.st);
  const sg = $('shareGen');
  if (sg) sg.onclick = () => renderShareCard(r);

  $('cmpSel').onchange = async () => {
    const id = $('cmpSel').value;
    if (!id) { $('cmpArea').innerHTML = ''; $('cmpArea').disabled = true; $('cmpOut').innerHTML = ''; state.cmpRef = null; return; }
    const q = $('cmpQ'); if (q) { q.value = ''; $('cmpQOut').innerHTML = ''; }
    await setCompareTarget({ kind: 'sample', id });
  };
  $('cmpArea').onchange = () => renderCompare();
  const cq = $('cmpQ');
  if (cq) cq.addEventListener('input', () => {
    const q = cq.value.trim();
    if (!q) { $('cmpQOut').innerHTML = ''; return; }
    const brandPrefixes = (CFG.search && CFG.search.brandPrefixes) || [];
    const aliasMap = (typeof ALIASES !== 'undefined' && ALIASES.aliases) || {};
    const curId = state.liveSel ? state.liveSel.id : null;
    const hits = LIVE.index.complexes
      .filter(e => e.id !== curId && AptEngine.liveSearchMatch(q, e, { brandPrefixes, aliases: aliasMap[e.id] }))
      .slice(0, 6);
    $('cmpQOut').innerHTML = hits.map(e => `
      <button class="apt" data-cmplive="${esc(e.id)}" style="margin-top:6px">
        <b>${esc(e.n)}</b><span class="l1">${esc(e.gn)} ${esc(e.d)} · 최근 2년 매매 ${e.t}건 · ${e.a.map(a => a + '㎡').join('·')}</span>
      </button>`).join('') || '<p class="subtle">검색 결과 없음</p>';
    $('cmpQOut').querySelectorAll('[data-cmplive]').forEach(b => b.onclick = async () => {
      $('cmpSel').value = '';
      b.querySelector('b').textContent = '불러오는 중…';
      await setCompareTarget({ kind: 'live', id: b.dataset.cmplive });
      $('cmpQOut').innerHTML = '';
    });
  });
}

/* ═══ §1 비교 데이터 파이프라인 통일 — 메인·비교·향후 확장 모두 이 함수 하나를 쓴다.
   단지 참조 → live shard 조회 → 최신 실거래 병합 → (샘플이면 프로필 유지+가격만 교체,
   자동수집이면 buildAutoComplex) — 메인 분석과 완전히 동일한 전처리 함수를 공유한다.
   DATA.complexes → analyze() 직행 금지. ═══ */
async function prepareComplexForAnalysis(ref) {
  if (ref.kind === 'sample') {
    const cx0 = DATA.complexes.find(c => c.id === ref.id);
    if (!cx0) throw new Error('단지 없음');
    if (cx0.regionCode && LIVE.status === 'ready' && !LIVE.shards[cx0.regionCode]) {
      try { await getShard(cx0.regionCode); } catch (e) {}
    }
    const cx = mergeSampleWithLive(cx0);
    return { cx, live: !!cx.liveLinked, fallback: !cx.liveLinked };
  }
  // 자동수집(live) 단지 — 메인 선택(selectLive)과 동일한 조회·빌드 경로 (수정값 없이 원데이터)
  const e = LIVE.index.complexes.find(x => x.id === ref.id);
  if (!e) throw new Error('단지 없음');
  const shard = await getShard(e.g);
  const key = ref.id.split('|').slice(1).join('|');
  const entry = shard.complexes[key];
  if (!entry) throw new Error('단지 데이터 없음');
  await getKaptInfo(e.g);
  const cx = AptEngine.buildAutoComplex(entry, regionOf(e.g), {
    edits: {}, ovPrice: null, ovJeonse: null, areaKey: null, conv: null,
    asOf: liveAsOf(), stations: STN, hubs: HUBS,
    dongLink: dongLinkFor(e.g, entry.dong),
    kapt: AptEngine.kaptResolve(KAPT.shards[e.g], entry.name, ref.id, typeof ALIASES !== 'undefined' ? ALIASES : null),
    liveId: ref.id
  });
  return { cx, live: true, fallback: false };
}

async function setCompareTarget(ref) {
  try {
    const prep = await prepareComplexForAnalysis(ref);
    state.cmpRef = ref; state.cmpPrep = prep;
    state.cmpCode = ref.kind === 'sample' ? (prep.cx.regionCode || null) : ref.id.split('|')[0];
    if (state.cmpCode) { try { await getRentHist(state.cmpCode); } catch (e) {} }
    const sel = $('cmpArea');
    const traded = prep.cx.areas;
    sel.innerHTML = traded.map(a => `<option value="${a.key}">${esc(a.label)}${(a.trades || []).length ? '' : ' (거래 없음)'}</option>`).join('');
    sel.value = AptEngine.pickDefaultAreaKey(traded, CFG.search && CFG.search.defaultAreaPrefs) || traded[0].key;
    sel.disabled = false;
    renderCompare();
  } catch (e) {
    console.error('[apt-value] 비교 단지 준비 실패:', e);
    $('cmpOut').innerHTML = '<div class="warnbox">비교 단지 데이터를 불러오지 못했습니다 — 다시 시도해 주세요.</div>';
  }
}

/* ═══ 결과 공유 카드 — 가격 명세 1장 이미지 ═══ */
function renderShareCard(r) {
  const v = r.v4;
  const W = 680, H = v ? 900 : 520, P = 44;
  const cv = document.createElement('canvas');
  cv.width = W * 2; cv.height = H * 2;
  const g = cv.getContext('2d');
  g.scale(2, 2);
  const ink = '#15171C', mut = '#8a8f98', acc = '#A8252C', line = '#e4e7ec';
  const LCOL = { live: '#1B3A6B', income: '#4E86BE', fixed: '#2E8B7A', unknown: '#C3C9D2' };
  g.fillStyle = '#F6F7F9'; g.fillRect(0, 0, W, H);
  g.fillStyle = '#fff'; g.strokeStyle = line;
  const rr = (x, y, w, h, rad) => { g.beginPath(); g.roundRect(x, y, w, h, rad); g.fill(); g.stroke(); };
  rr(16, 16, W - 32, H - 32, 20);
  const txt = (s, x, y, size, color, bold, align) => {
    g.fillStyle = color; g.textAlign = align || 'left';
    g.font = `${bold ? '700' : '400'} ${size}px "Apple SD Gothic Neo", "Noto Sans KR", sans-serif`;
    g.fillText(s, x, y);
  };
  const wrap = (s, x, y, size, color, maxW, lh, bold) => {
    g.font = `${bold ? '700' : '400'} ${size}px "Apple SD Gothic Neo", sans-serif`;
    const words = String(s).split(' ');
    let lineS = '', yy = y;
    for (const w of words) {
      const t = lineS ? lineS + ' ' + w : w;
      if (g.measureText(t).width > maxW && lineS) { txt(lineS, x, yy, size, color, bold); lineS = w; yy += lh; }
      else lineS = t;
    }
    if (lineS) txt(lineS, x, yy, size, color, bold);
    return yy + lh;
  };
  let y = 78;
  txt('아파트 가격 명세', P, y, 15, acc, true); y += 34;
  txt(r.cx.name, P, y, 27, ink, true); y += 26;
  txt(`${r.area.label} · ${r.cx.district || ''} ${r.cx.dong || ''}`, P, y, 14, mut); y += 38;
  if (v) {
    txt(v.manualPrice ? '입력 시세' : '최근 실거래', P, y, 13, mut); y += 30;
    txt(fmtEok(v.P), P, y, 30, ink, true);
    if (v.deal && !v.manualPrice) txt(`${v.deal.ym.replace('-', '.')}${v.deal.floor ? ' · ' + v.deal.floor + '층' : ''}`, W - P, y, 13, mut, false, 'right');
    y += 30;
    // 4층 스택 바
    const barY = y, barH = 30, barW = W - P * 2;
    let x0 = P;
    for (const l of v.layers) {
      const w = Math.max(0, l.amt / v.P) * barW;
      if (w <= 0) continue;
      g.fillStyle = LCOL[l.id]; g.fillRect(x0, barY, w, barH);
      x0 += w;
    }
    y = barY + barH + 28;
    for (const l of v.layers) {
      g.fillStyle = LCOL[l.id]; g.fillRect(P, y - 10, 10, 10);
      txt(l.label, P + 18, y, 14.5, ink, false);
      txt(`${l.id === 'unknown' && v.residNone ? '없음' : fmtEok(l.amt) + ' · ' + l.pct + '%'}`, W - P, y, 15, ink, true, 'right');
      y += 30;
    }
    y += 6;
    g.strokeStyle = line; g.beginPath(); g.moveTo(P, y); g.lineTo(W - P, y); g.stroke(); y += 30;
    const rowsS = [
      ['비관적', fmtEok(v.scen.pess.v)], ['보수적', fmtEok(v.scen.cons.v)],
      ['기준 (현 금리 + 소득)', fmtEok(v.scen.base.v)], ['낙관적', fmtEok(v.scen.opti.v)]
    ];
    txt('적정가 시나리오', P, y, 13, mut); y += 26;
    for (const [k2, val] of rowsS) { txt(k2, P, y, 14, ink); txt(val, W - P, y, 15, ink, true, 'right'); y += 27; }
    y += 8;
    g.fillStyle = '#F2F5F9'; g.strokeStyle = '#E1E7EE';
    const boxY = y, boxH = 116;
    rr(P - 10, boxY, W - (P - 10) * 2, boxH, 12);
    const needTxt = v.gReqSat === 'high' ? `연 ${(v.gReq * 100).toFixed(0)}% 이상` : `연 ${(v.gReq * 100).toFixed(1)}%`;
    wrap(`이 가격을 믿으려면 — 임대료가 앞으로 10년간 ${needTxt}씩 올라야 합니다. 소득이 설명하는 건 연 ${fmtG(v.gIncome)}입니다.`, P + 6, boxY + 34, 15.5, ink, W - P * 2 - 12, 27);
  } else {
    txt('전월세 실거래가 없어 명세를 만들지 못했습니다', P, y, 15, mut); y += 30;
  }
  txt('닥터마빈 · 아파트 가치진단', P, H - 56, 13, mut);
  txt('실거래 기반 참고자료 · 투자 권유 아님', W - P, H - 56, 12, mut, false, 'right');
  g.textAlign = 'left';
  const url = cv.toDataURL('image/png');
  $('shareOut').innerHTML = `<img src="${url}" alt="결과 카드" style="max-width:340px;width:100%;border:1px solid var(--line);border-radius:12px">
    <div style="margin-top:8px"><a class="btn ghost" style="display:inline-block;text-decoration:none;padding:8px 18px" href="${url}" download="${esc(r.cx.name)}_가격명세.png">이미지 저장</a></div>`;
}

/* ── 비교 렌더 — 메인과 동일 전처리(prepareComplexForAnalysis)·동일 계산 ── */
function renderCompare() {
  if (!state.cmpPrep) return;
  const prep = state.cmpPrep, c2 = prep.cx;
  const areaKey = $('cmpArea').value || c2.areas[0].key;
  const hist2 = state.cmpCode ? histResolve(state.cmpCode, c2, areaKey, []) : null;
  const nearby2 = state.cmpCode ? nearbyNewOf(state.cmpCode, c2, state.baseInput.asOfYM) : null;
  let r2;
  try { r2 = AptEngine.analyze({ complex: c2, areaKey, asOfYM: state.baseInput.asOfYM, overrides: {}, rentHist: hist2, nearbyNew: nearby2 }, CFG, HUBS, JOBS, STN); }
  catch (e) {
    $('cmpOut').innerHTML = `<div class="warnbox">${esc(e.user ? e.message : '이 평형은 분석할 수 없습니다 — 다른 평형을 선택해 보세요.')}</div>`;
    return;
  }
  const a = state.result, b = r2;
  const av = a.v4, bv = b.v4;
  const basisOf = (r, isFallback) => {
    const m = r.marketRef;
    if (!m) return '<span class="stat est">실거래 데이터 부족</span>';
    const from = m.items.length ? m.items[m.items.length - 1].date.slice(0, 7).replace('-', '.') : '';
    const to = m.latest.date.slice(0, 7).replace('-', '.');
    return `${from && from !== to ? `${from}~${to}` : to} · ${m.n}건${isFallback ? ' <span class="stat est">등재 샘플 기준</span>' : ''}`;
  };
  const aFallback = !state.liveSel && !state.manual && !a.cx.liveLinked;
  const row = (k, va, vb, strong) => `<tr><td>${k}</td><td${strong ? ' class="strong"' : ''}>${va}</td><td${strong ? ' class="strong"' : ''}>${vb}</td></tr>`;
  const vOf = (x, f) => x ? f(x) : '—';
  const residTxt = x => !x ? '—' : (x.residNone ? '없음' : `${Math.max(0, x.residPct)}% (${fmtEok(Math.max(0, x.resid))})`);
  const needTxt = x => !x || x.gReq == null ? '—' : (x.gReqSat === 'high' ? `연 ${(x.gReq * 100).toFixed(0)}% 이상` : `연 ${(x.gReq * 100).toFixed(1)}%`);
  const diff = (bv ? bv.P : b.currentPrice) - (av ? av.P : a.currentPrice);
  let sentence;
  if (!av || !bv) sentence = '한쪽 단지의 전월세 실거래가 없어 잔여 비교는 생략합니다 — 실거래 가격 기준으로만 비교하세요.';
  else if (Math.abs(diff) < 0.05) {
    sentence = `두 단지의 최근 실거래가 비슷합니다. 설명되지 않는 비중(${a.cx.name} ${Math.max(0, av.residPct)}% vs ${b.cx.name} ${Math.max(0, bv.residPct)}%)이 작은 쪽이 임대료가 가격을 더 든든하게 받치는 쪽입니다.`;
  } else {
    const hi = diff > 0 ? { r: b, v: bv } : { r: a, v: av };
    const lo2 = diff > 0 ? { r: a, v: av } : { r: b, v: bv };
    sentence = `${fmtEok(Math.abs(diff))}을 더 주고 <b>${esc(hi.r.cx.name)}</b>를 선택한다면 — 임대가치 차이 연 ${fmtMan((hi.v.Rgross - lo2.v.Rgross) * 10000)}과 설명되지 않는 부분 ${fmtEok(Math.max(0, hi.v.resid))} vs ${fmtEok(Math.max(0, lo2.v.resid))}의 차이에 값을 지불하는 셈입니다. `;
    if (Math.max(0, hi.v.residPct) > Math.max(0, lo2.v.residPct) + 8) sentence += '비싼 쪽의 가격에는 임대료 밖의 기대(환경·상품성·개발)가 더 크게 들어 있습니다 — 그 기대를 인정하는지가 판단의 핵심입니다.';
    else sentence += '가격 차이의 상당 부분이 임대가치 차이로 뒷받침됩니다.';
  }
  $('cmpOut').innerHTML = `
    <div class="tblwrap"><table>
      <thead><tr><th></th><th>${esc(a.cx.name)} ${esc(a.area.key)}㎡</th><th>${esc(b.cx.name)} ${esc(b.area.key)}㎡</th></tr></thead><tbody>
      ${row('최근 실거래', vOf(av, x => fmtEok(x.P)) , vOf(bv, x => fmtEok(x.P)), true)}
      ${row('실거래 기준', basisOf(a, aFallback), basisOf(b, prep.fallback))}
      ${row('임대가치 (연)', vOf(av, x => fmtMan(x.Rgross * 10000)), vOf(bv, x => fmtMan(x.Rgross * 10000)))}
      ${row('지금 이 집에 사는 값', vOf(av, x => fmtEok(x.layers[0].amt)), vOf(bv, x => fmtEok(x.layers[0].amt)))}
      ${row('적정가 (기준 시나리오)', vOf(av, x => fmtEok(x.scen.base.v)), vOf(bv, x => fmtEok(x.scen.base.v)))}
      ${row('설명되지 않는 비중', residTxt(av), residTxt(bv))}
      ${row('가격이 요구하는 임대료 상승', needTxt(av), needTxt(bv))}
      ${row('지난 10년 실적', av && av.hist ? `연 ${fmtG(av.hist.g)}${av.hist.src === 'gu' ? ' (지역 평균)' : ''}` : '—', bv && bv.hist ? `연 ${fmtG(bv.hist.g)}${bv.hist.src === 'gu' ? ' (지역 평균)' : ''}` : '—')}
      ${row('세대수', a.cx.households != null ? a.cx.households.toLocaleString() : '미확인', b.cx.households != null ? b.cx.households.toLocaleString() : '미확인')}
      ${row('준공', a.cx.builtYear || '—', b.cx.builtYear || '—')}
      ${row('가까운 역', a.transit ? `${esc(a.transit.primary.st)} ${a.transit.primary.min}분` : '—', b.transit ? `${esc(b.transit.primary.st)} ${b.transit.primary.min}분` : '—')}
      </tbody></table></div>
    <div class="op"><div class="ot">비교 해석</div><p>${sentence}</p></div>`;
}

/* ═══════════════ 역 가치 지도 (Station Intelligence 시각화) ═══════════════ */
const mapState = { built: false, mode: 'sv', line: null, sel: null, showAll: false };

/* 노선 대표색 (rail_network의 실제 노선색 재사용) · 역의 대표 노선 = 노선 지수 순 */
const LINE_COLOR = {};
RAIL_LINES.forEach(l => { const nm = l.name.replace(' 급행', ''); if (!(nm in LINE_COLOR)) LINE_COLOR[nm] = l.color; });
function repLinesOf(s) {
  const ord = LINEI.lines.filter(L => (s.lines || []).includes(L.name)).map(L => L.name);
  for (const n of (s.lines || [])) if (!ord.includes(n)) ord.push(n);
  return ord;
}
/* 원 크기: 값 구간이 즉시 구분되도록 비선형 곡선 (하위 ~5px → 최상위 22px 상한) */
function svRadius(v) {
  const t = Math.max(0, Math.min(1, (v - 24) / 74));
  return 5 + 17 * Math.pow(t, 1.6);
}

function openMap(focusStation) {
  document.querySelectorAll('.step').forEach(s => s.dataset.wasHidden = s.hidden ? '1' : '0');
  $('step1').hidden = $('step2').hidden = $('step3').hidden = true;
  $('stepper').style.display = 'none'; $('bottnav').style.display = 'none';
  $('mapView').hidden = false;
  if (!mapState.built) buildMap();
  // 컨테이너가 숨김 상태에서 초기화됐을 때 크기·뷰 복구 (Leaflet invalidateSize)
  if (mapState.lmap) setTimeout(() => {
    mapState.lmap.invalidateSize();
    if (mapState.lmap.getZoom() < 9) mapState.lmap.setView([37.535, 127.0], 11, { animate: false });
  }, 0);
  if (focusStation && STN.stations[focusStation]) selectStation(focusStation);
  window.scrollTo({ top: 0 });
}
function closeMap() {
  $('mapView').hidden = true;
  $('stepper').style.display = ''; $('bottnav').style.display = '';
  document.querySelectorAll('.step').forEach(s => { s.hidden = s.dataset.wasHidden !== '0'; });
  window.scrollTo({ top: 0 });
}
$('mapBtn').onclick = () => openMap();
$('mapBack').onclick = closeMap;

/* 지도·역 카테고리(V2 §19 관점 선택): 균형형 + 4개 관점 — 선택하면 원 크기·목록·상세가 모두 그 기준으로 바뀐다 */
const CAT = {
  sv: { short: '균형형', label: '균형형 역 가치', hint: '균형형 — 교통·네트워크 30% · 역세권 경제력 35% · 교육·주거 생활권 20% · 업무·도시 중심성 15%의 가중합입니다. 절대 순위가 아니라 관점 하나의 결과이며, 아래 탭으로 관점을 바꾸면 평가가 달라집니다. 원의 크기 = 역 가치, 원의 색 = 노선.' },
  transit: { short: '교통', label: '교통·네트워크', hint: '교통·네트워크 — 강남·도심·여의도 체감 이동시간(대기·환승 포함), 환승 노선 수, 급행, 배차·심도. 전체 역 대비 백분위입니다. 원의 크기 = 교통 값.' },
  econ: { short: '경제력', label: '역세권 경제력', hint: '역세권 경제력 — 그 역 생활권에 거주하는 주민들의 경제 수준(소득·소비) 추정 구간(5단계)의 백분위입니다. 아파트 시세·업무지·상권·유동인구는 반영하지 않습니다(업무는 "업무" 탭, 시세는 검증용 참고로만 표시). 원의 크기 = 경제력 값.' },
  edu: { short: '교육·주거', label: '교육·주거 생활권', hint: '교육·주거 생활권 — 대표 학원가 접근(거리감쇠)과 아파트 단지 밀집도. 대치·목동·중계·평촌 같은 학군·주거 지역이 여기서 높습니다. 원의 크기 = 교육·주거 값.' },
  biz: { short: '직주·업무', label: '업무·도시 중심성', hint: '직주·업무 관점 — 업무·상업·문화 시설과 도시 중심성. 업무가 강한 역과 종합 부동산 가치가 높은 역을 구분해 보세요. 원의 크기 = 업무 값.' }
};
function metricOf(s) { return mapState.mode === 'sv' ? s.sv : ((s.comps || {})[mapState.mode] ?? 0); }
/* 카테고리별 순위 (동률은 같은 순위) — 역 클릭 카드·TOP10에 사용 */
const catRankCache = {};
function catRankOf(name) {
  const m = mapState.mode;
  if (!catRankCache[m]) {
    const arr = Object.keys(STN.stations).map(n => [n, m === 'sv' ? STN.stations[n].sv : ((STN.stations[n].comps || {})[m] ?? 0)])
      .sort((a, b) => b[1] - a[1]);
    const map = {};
    arr.forEach(([n, v], i) => { map[n] = (i > 0 && arr[i - 1][1] === v) ? map[arr[i - 1][0]] : i + 1; });
    catRankCache[m] = map;
  }
  return catRankCache[m][name];
}

function buildMap() {
  mapState.built = true;
  // 노선 칩 (노선 가치 지수순)
  $('lineChips').innerHTML = `<button class="lchip" data-line="" aria-pressed="true">전체</button>` +
    LINEI.lines.map(l => `<button class="lchip" data-line="${esc(l.name)}" aria-pressed="false"><i style="background:${l.color}"></i>${esc(l.name)} ${l.golden}${l.tier ? ` <b>${l.tier}</b>` : ''}</button>`).join('');
  $('lineChips').querySelectorAll('.lchip').forEach(b => b.onclick = () => {
    mapState.line = b.dataset.line || null;
    $('lineChips').querySelectorAll('.lchip').forEach(x => x.setAttribute('aria-pressed', x === b ? 'true' : 'false'));
    drawMap(); renderLineCard(); renderRank();
  });
  $('mapMode').querySelectorAll('button').forEach(b => b.onclick = () => {
    mapState.mode = b.dataset.v;
    $('mapMode').querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', x === b ? 'true' : 'false'));
    $('mapHint').textContent = CAT[mapState.mode].hint;
    drawMap(); renderRank();
    if (mapState.sel) selectStation(mapState.sel);
  });
  drawMap(); renderRank();
}

/* Leaflet 실지도 (줌·팬·fit) — 로드 실패 시 개념도 SVG 폴백 */
function drawMap() {
  if (typeof L !== 'undefined') drawMapLeaflet();
  else drawMapSVG();
}

function accentColor() { return (getComputedStyle(document.documentElement).getPropertyValue('--accent') || '#A8252C').trim(); }

function drawMapLeaflet() {
  const M = mapState;
  if (!M.lmap) {
    $('mapBox').innerHTML = '<div id="leafletMap"></div>';
    M.lmap = L.map('leafletMap', { preferCanvas: true, zoomSnap: 0.25, attributionControl: false }).setView([37.535, 127.0], 11);
    L.control.attribution({ prefix: false }).addTo(M.lmap);   // 'Leaflet' 문구 숨김 — 지도 데이터 출처는 유지
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 17, attribution: '© OpenStreetMap'
    }).addTo(M.lmap);
    M.lineLayer = L.layerGroup().addTo(M.lmap);
    M.markerLayer = L.layerGroup().addTo(M.lmap);
    M.tipLayer = L.layerGroup().addTo(M.lmap);
    M.lmap.on('zoomend moveend', () => renderMapTips());
  }
  // 노선
  M.lineLayer.clearLayers();
  const lineOn = M.line;
  M.lineStations = new Set();
  for (const le of RAIL_LINES) {
    if (le.overlay) continue;
    const hi = lineOn && le.name === lineOn;
    if (hi) le.stations.forEach(s => M.lineStations.add(s));
    const pts = le.stations.filter(s => STN.stations[s] && STN.stations[s].c).map(s => STN.stations[s].c);
    if (le.loop && pts.length) pts.push(pts[0]);
    L.polyline(pts, { color: le.color, weight: hi ? 5 : 2, opacity: lineOn ? (hi ? 0.9 : 0.12) : 0.4, interactive: false }).addTo(M.lineLayer);
  }
  // Golden Corridor 강조 (§73)
  if (lineOn) {
    const LI = LINEI.lines.find(x => x.name === lineOn);
    if (LI && LI.corridor) {
      const cpts = LI.corridor.stations.filter(s => STN.stations[s] && STN.stations[s].c).map(s => STN.stations[s].c);
      if (cpts.length > 1) L.polyline(cpts, { color: accentColor(), weight: 11, opacity: 0.3, interactive: false }).addTo(M.lineLayer);
    }
    const all = [...M.lineStations].filter(s => STN.stations[s] && STN.stations[s].c).map(s => STN.stations[s].c);
    if (all.length) M.lmap.fitBounds(L.latLngBounds(all).pad(0.12));
  }
  // 역 버블 — 크기 = 역 가치(비선형), 색 = 대표 노선색, 이중 테두리 = 환승역
  M.markerLayer.clearLayers();
  M.markers = {};
  const names = Object.keys(STN.stations).filter(n => STN.stations[n].c);
  for (const n of names.sort((a, b) => metricOf(STN.stations[a]) - metricOf(STN.stations[b]))) {
    const s = STN.stations[n];
    const v = metricOf(s);
    const faded = lineOn && !M.lineStations.has(n);
    const reps = repLinesOf(s);
    const col = LINE_COLOR[reps[0]] || accentColor();
    const r = svRadius(v);
    if (reps.length >= 2 && !faded) {
      L.circleMarker(s.c, {
        radius: r + 2.4, color: LINE_COLOR[reps[1]] || '#888', weight: 2.2,
        fill: false, opacity: 0.9, interactive: false
      }).addTo(M.markerLayer);
    }
    const mk = L.circleMarker(s.c, {
      radius: r,
      color: M.sel === n ? '#111' : '#fff', weight: M.sel === n ? 2.5 : 1,
      fillColor: col, fillOpacity: faded ? 0.07 : 0.85,
      interactive: !faded
    }).addTo(M.markerLayer);
    mk.on('click', () => selectStation(n));
    M.markers[n] = mk;
  }
  renderMapTips();
  const lg = [[50, '중위'], [75, '상위'], [92, '최상위']].map(([v, k]) =>
    `<span class="lgi"><i class="lgc" style="width:${Math.round(svRadius(v) * 2)}px;height:${Math.round(svRadius(v) * 2)}px"></i>${k} ${v}점</span>`).join('');
  $('mapLegend').innerHTML = `<span>원 크기 = ${CAT[M.mode].label}</span>${lg}<span>원 색 = 노선 색상 · 겹테두리 = 환승역</span><span>역 ${names.length}개 · 자동 계산 (${esc(STN.meta.updatedAt)})</span>`;
}

/* 줌 레벨별 라벨 (§66·71 — 숫자 겹침 방지) */
function renderMapTips() {
  const M = mapState;
  if (!M.lmap || !M.tipLayer) return;
  M.tipLayer.clearLayers();
  const z = M.lmap.getZoom();
  const bounds = M.lmap.getBounds();
  const topN = z < 10.5 ? 14 : z < 11.5 ? 34 : z < 12.5 ? 80 : z < 13.5 ? 200 : 999;
  const cand = Object.keys(STN.stations)
    .filter(n => STN.stations[n].c && bounds.contains(STN.stations[n].c))
    .filter(n => !M.line || M.lineStations.has(n))
    .sort((a, b) => metricOf(STN.stations[b]) - metricOf(STN.stations[a]))
    .slice(0, topN);
  if (M.sel && STN.stations[M.sel] && !cand.includes(M.sel)) cand.push(M.sel);
  const showVal = z >= 12 || M.line;
  for (const n of cand) {
    const s = STN.stations[n];
    const v = Math.round(metricOf(s));
    L.tooltip({ permanent: true, direction: 'top', offset: [0, -6], className: 'stn-tip' + (v >= 85 ? ' hi' : ''), interactive: false })
      .setLatLng(s.c).setContent(showVal ? `${n} ${v}` : n).addTo(M.tipLayer);
  }
}

/* 폴백: 고정 SVG 개념도 (오프라인 등 Leaflet 불가 시) */
function drawMapSVG() {
  const names = Object.keys(STN.stations).filter(n => STN.stations[n].c);
  const lats = names.map(n => STN.stations[n].c[0]), lngs = names.map(n => STN.stations[n].c[1]);
  const laMin = Math.min(...lats), laMax = Math.max(...lats), loMin = Math.min(...lngs), loMax = Math.max(...lngs);
  const W = 700, kx = 0.793;
  const H = Math.round(W * (laMax - laMin) / ((loMax - loMin) * kx));
  const pad = 26;
  const X = lng => pad + (lng - loMin) / (loMax - loMin) * (W - pad * 2);
  const Y = lat => pad + (laMax - lat) / (laMax - laMin) * (H - pad * 2);
  const lineOn = mapState.line;
  const lineStations = new Set();
  let paths = '';
  for (const le of RAIL_LINES) {
    if (le.overlay) continue;
    const hi = lineOn && le.name === lineOn;
    if (hi) le.stations.forEach(s => lineStations.add(s));
    const pts = le.stations.filter(s => STN.stations[s] && STN.stations[s].c)
      .map(s => `${X(STN.stations[s].c[1]).toFixed(1)},${Y(STN.stations[s].c[0]).toFixed(1)}`).join(' ');
    paths += `<polyline class="lpath ${hi ? 'hi' : ''}" stroke="${le.color}" points="${pts}"></polyline>`;
  }
  const ranked = names.slice().sort((a, b) => metricOf(STN.stations[b]) - metricOf(STN.stations[a]));
  const labelSet = new Set(ranked.slice(0, 22));
  if (lineOn) [...lineStations].forEach(s => labelSet.add(s));
  if (mapState.sel) labelSet.add(mapState.sel);
  let dots = '';
  for (const n of ranked.slice().reverse()) {
    const s = STN.stations[n];
    const v = metricOf(s);
    const x = X(s.c[1]).toFixed(1), y = Y(s.c[0]).toFixed(1);
    const rr = (svRadius(v) * 0.62).toFixed(1);
    const col = LINE_COLOR[repLinesOf(s)[0]] || 'var(--accent)';
    const dim = lineOn && !lineStations.has(n);
    dots += `<g class="stn ${dim ? 'dim' : ''} ${mapState.sel === n ? 'sel' : ''}" data-st="${esc(n)}">
      <circle cx="${x}" cy="${y}" r="${rr}" fill="${col}" fill-opacity="0.85" stroke="#fff" stroke-width="0.6"></circle>
      ${labelSet.has(n) && !dim ? `<text class="slabel ${v >= 85 ? 'hi' : ''}" x="${x}" y="${(y - rr - 2.5)}" text-anchor="middle">${esc(n)}${lineOn ? ' ' + Math.round(v) : ''}</text>` : ''}
    </g>`;
  }
  $('mapBox').innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="역 가치 지도">${paths}${dots}</svg>`;
  $('mapLegend').innerHTML = `<span>원 크기 = ${CAT[mapState.mode].label} · 원 색 = 노선</span><span>오프라인 개념도 모드</span>`;
  $('mapBox').querySelectorAll('.stn').forEach(g => g.onclick = () => selectStation(g.dataset.st));
}

function selectStation(name) {
  mapState.sel = name;
  drawMap();
  const s = STN.stations[name];
  if (!s) return;
  if (mapState.lmap && s.c) mapState.lmap.panTo(s.c, { animate: true });
  const total = Object.keys(STN.stations).length;
  const sb = (k, v) => `<div class="sb"><div class="k">${k}</div><div class="sbar"><i style="width:${Math.round(v)}%"></i></div><div class="v">${Math.round(v)}</div></div>`;
  // 한 정거장 비교
  let hop = '';
  for (const le of RAIL_LINES) {
    if (le.overlay || !le.stations.includes(name)) continue;
    const i = le.stations.indexOf(name);
    const trio = [le.stations[i - 1], name, le.stations[i + 1]].filter(Boolean);
    hop += `<h3 class="mini-h">한 정거장의 가치 — ${esc(le.name)}</h3><div class="hopviz">${trio.map(x => { const d = STN.stations[x]; return `<div class="hop ${x === name ? 'cur' : ''}"><div class="hn">${esc(x)}</div><div class="hv">${d ? Math.round(d.sv) : '—'}</div><div class="hs">SV</div></div>`; }).join('')}</div>`;
    if (hop.split('hopviz').length > 2) break;
  }
  // 교통 대비 거주민 경제수준 해석 (콘텐츠)
  let rel = '';
  {
    const diff = s.comps.transit - s.comps.econ;
    let msg;
    if (diff >= 20) msg = '교통·네트워크 가치 대비 거주민 경제수준이 낮습니다 — 교통 인프라에 비해 주거지 프리미엄이 아직 낮은 생활권입니다.';
    else if (diff <= -20) msg = '거주민 경제수준이 교통·네트워크 가치보다 높습니다 — 교통보다 학군·환경·선호도가 만드는 주거 프리미엄 생활권입니다.';
    else msg = '교통·네트워크 가치와 거주민 경제수준이 대체로 부합하는 생활권입니다.';
    rel = `<p class="subtle" style="margin-top:8px">${msg}</p>`;
  }
  const GRADE_LABEL = [null, '최저권', '낮은 편', '중간권', '상위권', '최상위권'];
  const srcTag = '<span class="stat est" style="margin-left:4px">5단계 추정</span>';
  const sub = s.sub || {};
  const tier = AptEngine.stationTier(s.sv, CFG);
  const tierCls = tier.label === 'S' ? 'green' : tier.label === 'A' ? 'blue' : 'gray';
  const catPct = mapState.mode !== 'sv' ? Math.round(catRankOf(name) / total * 100) : null;
  const reason = AptEngine.stationReason(s.comps, CFG);
  $('stnCard').hidden = false;
  $('stnCard').innerHTML = `
    <div class="stnhead"><b>${esc(name)}</b>
      <span>${s.lines.map(l => `<i style="width:9px;height:9px;border-radius:50%;background:${LINE_COLOR[l] || 'var(--muted)'};display:inline-block;margin-right:3px"></i>${esc(l)}`).join(' ')}${s.express ? ' · 급행/광역' : ''}</span></div>
    <div class="tiles3" style="grid-template-columns:1fr 1fr;margin-top:10px">
      <div class="t3" style="cursor:default"><div class="k">균형형 기준 <span class="badge ${tierCls}" style="vertical-align:1px">${tier.label} Tier</span></div><div class="v ">${Math.round(s.sv)}<em> /100</em></div><div class="s">수도권 ${total}개 역 중 상위 ${s.rankPct}%${catPct != null ? `<br>현재 선택 <b>${CAT[mapState.mode].short}</b> 관점 상위 ${catPct}%` : ''}</div></div>
      <div class="t3" style="cursor:default"><div class="k">역세권 경제력${srcTag}</div><div class="v">${s.wealth}<em> /100</em></div><div class="s">근거: 거주민 소득·소비 수준 <b>${GRADE_LABEL[s.econGrade] || '중간권'}</b> (구간 ${s.econGrade ?? 3}/5) — 시세·업무·상권 미반영${s.priceLevel != null ? `<br>참고: 주변 시세 백분위 ${s.priceLevel}${s.priceN ? ` · ${s.priceN}개 단지` : ''} (평가 미반영 · 검증용)` : ''}</div></div>
    </div>
    <h3 class="mini-h">구성 지표 — 4축 (전체 역 대비 백분위)</h3>
    ${sb('교통·네트워크 30%', s.comps.transit)}${sb('역세권 경제력 35%', s.comps.econ)}${sb('교육·주거 생활권 20%', s.comps.edu)}${sb('업무·도시 중심성 15%', s.comps.biz)}
    <p class="subtle" style="margin-top:6px">교통: 핵심지 체감접근 ${sub.core ?? '—'} · 네트워크 ${sub.net ?? '—'} · 운행편의 ${sub.fric ?? '—'} /
      교육·주거: 학원가 접근 ${sub.hubEdu ?? '—'}${s.hubName ? ` (${esc(s.hubName)})` : ''} · 단지 밀집 ${sub.density ?? '—'}</p>
    <div class="op" style="margin-top:10px"><div class="ot">왜 이 자리인가</div><p>${esc(reason)} 관점(교통·경제력·교육주거·직주)을 바꾸면 이 역의 위치도 달라집니다 — 위 탭에서 직접 확인하세요.</p></div>
    <div class="kv"><span>강남 핵심 업무지</span><span>약 ${s.gangnamMin}분 (대기·환승 포함 체감시간)</span></div>
    ${hop}${rel}
    <p class="subtle">아파트 평가에는 이 역의 교통·업무 축을 중심으로 반영하고, 경제력 축은 추정치라 축소 반영합니다(중복·과신 방지).</p>`;
  $('stnCard').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function renderLineCard() {
  const nm = mapState.line;
  if (!nm) { $('lineCard').hidden = true; return; }
  const L = LINEI.lines.find(x => x.name === nm);
  if (!L) { $('lineCard').hidden = true; return; }
  const B = L.breakdown || {};
  const hubs = B.hubs || [];
  const AXES = [['station', '노선 내 역세권 가치', '30%'], ['hub', '핵심 생활권 연결력', '25%'], ['network', '도시 횡단·네트워크', '20%'], ['efficiency', '실제 이동 효율', '15%'], ['uniqueness', '대체불가능성', '10%']];
  const axBars = AXES.map(([k, lb, w]) => `<div class="sb"><div class="k">${lb} ${w}</div><div class="sbar"><i style="width:${Math.round(B[k] ?? 0)}%"></i></div><div class="v">${B[k] ?? '—'}</div></div>`).join('');
  const strengths = [];
  if ((B.station ?? 0) >= 68) strengths.push(`역세권 가치 상위 — 환승 감쇄 후 중앙값 ${B.medianDecayed} · 80점 이상 역 ${B.share80}%`);
  if ((B.hub ?? 0) >= 80) strengths.push(`서로 다른 핵심 생활권 ${hubs.length}곳 직결 — ${hubs.slice(0, 5).map(h => h.n).join('·')}${hubs.length > 5 ? ' 등' : ''} (추가 생활권은 한계효용 체감)`);
  if ((B.network ?? 0) >= 75) strengths.push(`도시 네트워크 — 환승 ${B.otherLines}개 노선${B.gateways && B.gateways.length ? ` · ${B.gateways.join('·')} 관문` : ''}${(B.ewKm >= 18 || B.nsKm >= 18) ? ' · 서울 횡단축' : ''}`);
  if ((B.efficiency ?? 0) >= 72) strengths.push(`이동 효율 — 배차 ${L.svc.headway}분${L.express ? ' · 급행 운행' : ''}${B.kmh ? ` · 표정속도 약 ${B.kmh}km/h` : ''}`);
  if ((B.uniqueness ?? 0) >= 65) strengths.push(`대체 불가 — 이 노선이 없어지면 소속 역의 핵심지 도달시간이 크게 늘어남 (우회 부담 ${B.detour}/100)`);
  const exHubs = hubs.filter(h => h.ex).map(h => h.n);
  if (exHubs.length >= 2) strengths.push(`${exHubs.slice(0, 4).join('·')}${exHubs.length > 4 ? ' 등' : ''}은 사실상 이 노선(±1개)만 연결`);
  if (!strengths.length) strengths.push('구조적 강점이 뚜렷하지 않음 — 세부 축 값을 확인하세요');
  const weaknesses = [];
  if ((B.station ?? 0) < 55) weaknesses.push(`역세권 가치 ${B.station} — 외곽·저수요 구간 비중이 큼 (중앙값 ${B.medianDecayed})`);
  if ((B.hub ?? 0) < 55) weaknesses.push(`핵심 생활권 연결 ${B.hub} — 직결하는 고가치 생활권이 적음`);
  if ((B.network ?? 0) < 55) weaknesses.push(`네트워크 축 낮음 — 환승 ${B.otherLines}개 노선${B.gateways && B.gateways.length ? '' : ' · KTX/공항 관문 없음'}${(B.ewKm < 10 && B.nsKm < 10) ? ' · 도심 횡단축 아님' : ''}`);
  if ((B.efficiency ?? 0) < 55) weaknesses.push(`이동 효율 — 배차 ${L.svc.headway}분${L.svc.fare ? ' · 별도요금' : ''}${L.svc.depth >= 3 ? ' · 깊은 역사' : ''}`);
  if ((B.uniqueness ?? 0) < 40) weaknesses.push(`대체 경로 많음 — 이 노선이 없어도 소속 역 대부분이 다른 노선으로 비슷하게 이동 가능 (우회 부담 ${B.detour}/100)`);
  if (L.stdev >= 16) weaknesses.push(`역별 편차 큼(±${L.stdev}) — 같은 노선이라도 역마다 프리미엄이 다름`);
  if (!weaknesses.length) weaknesses.push('뚜렷한 구조적 약점 없음');
  const hubChips = hubs.map(h => `<span class="badge gray" title="${esc(h.n)} — ${h.cnt}개 역${h.ex ? ' · 사실상 독점 연결' : ''}">${esc(h.n)}${h.tier === 1 ? ' ★' : ''}${h.ex ? ' ◆' : ''}</span>`).join(' ');
  const corr = new Set((L.corridor && L.corridor.stations) || []);
  const profile = (L.profile || []).map(p => `
    <div class="pcol ${corr.has(p.n) ? 'corr' : ''}">
      <div class="pbar"><i style="height:${Math.max(6, p.sv)}%"></i></div>
      <div class="pv">${p.sv}</div><div class="pn">${esc(p.n)}</div>
    </div>`).join('');
  const tops = (L.topStations || []).map(t => `<span class="badge gray" style="cursor:pointer" data-st="${esc(t.n)}">${esc(t.n)} ${t.sv}</span>`).join(' ');
  $('lineCard').hidden = false;
  $('lineCard').innerHTML = `
    <h2><i style="width:10px;height:10px;border-radius:50%;background:${L.color};display:inline-block;margin-right:6px"></i>${esc(nm)} — 노선 가치 ${L.golden} / 100${L.tier ? ` <span class="badge ${L.tier === 'S' ? 'green' : L.tier === 'A' ? 'blue' : 'gray'}" style="vertical-align:2px">${L.tier} Tier</span>` : ''} <span style="font-size:12px;color:var(--muted)">(${LINEI.lines.findIndex(x => x.name === nm) + 1}위)</span></h2>
    <p class="hint"><b>노선 가치는 역 평균이 아닙니다.</b> 역세권 가치 30%(환승역 편승 감쇄) + 핵심 생활권 연결력 25%(추가 생활권은 한계효용 체감) + 도시 횡단·네트워크 20%(환승·관문·횡단성만 — 생활권과 중복 가산 없음) + 이동 효율 15% + 대체불가능성 10%(노선 제거 시 우회 시간 실측)로 평가하며, 값은 계산 결과 그대로입니다(순위 강제 확대 없음). 값 차이가 작은 노선은 같은 Tier로 묶입니다.</p>
    ${axBars}
    <div class="chips" style="margin:10px 0 2px"><span style="font-size:12px;color:var(--muted)">주요 연결 생활권 (★ 최상위 ◆ 독점)</span> ${hubChips || '<span class="badge gray">—</span>'}</div>
    <div class="kv"><span>역세권 가치 산출</span><span style="text-align:left;flex:2">환승 감쇄 SV 중앙값 <b>${B.medianDecayed ?? '—'}</b> · 상위 25%(${B.topN}개 역) <b>${B.topAvgDecayed ?? '—'}</b> · SV 80+ 역 비율 <b>${B.share80}%</b> · ${L.count}개 역</span></div>
    <div class="chips" style="margin:8px 0 2px"><span style="font-size:12px;color:var(--muted)">대표 고가치 역</span> ${tops}</div>
    <div class="factors">
      <div class="fbox up"><div class="fh">강점</div><ul>${strengths.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>
      <div class="fbox down"><div class="fh">약점</div><ul>${weaknesses.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>
    </div>
    <h3 class="mini-h">역별 가치 프로필 — <span style="color:var(--accent)">붉은 구간 = Golden Corridor</span> (${esc((L.corridor ? L.corridor.stations : []).slice(0, 3).join('·'))}${L.corridor && L.corridor.stations.length > 3 ? '…' : ''})</h3>
    <div class="profile-strip">${profile}</div>`;
  $('lineCard').querySelectorAll('.badge[data-st]').forEach(b => b.onclick = () => selectStation(b.dataset.st));
}

function renderRank() {
  const m = mapState.mode;
  const inLine = mapState.line ? new Set((RAIL_LINES.filter(l => l.name === mapState.line)).flatMap(l => l.stations)) : null;
  const names = Object.keys(STN.stations).filter(n => !inLine || inLine.has(n));
  // 동률(백분위 같은 값)은 해당 축의 세부 값으로 정렬 — 교육·주거 탭에서 학원가 핵심지가 위로
  const subKey = { transit: 'core', edu: 'hubEdu', biz: 'dest' }[m];
  const tie = n => subKey ? ((STN.stations[n].sub || {})[subKey] || 0) : 0;
  const ranked = names.sort((a, b) => metricOf(STN.stations[b]) - metricOf(STN.stations[a]) || tie(b) - tie(a) || STN.stations[a].rank - STN.stations[b].rank);
  // V2 §16·18: 절대순위(1위·2위…) 대신 Tier 그룹 — 균형형 값 기준 Tier
  const rowOf = n => {
    const s = STN.stations[n];
    const c = s.comps || {};
    const dot = `<i style="width:8px;height:8px;border-radius:50%;background:${LINE_COLOR[repLinesOf(s)[0]] || 'var(--muted)'};display:inline-block;margin-right:4px;flex:none"></i>`;
    const lowN = m === 'econ' && s.econGrade ? ` <span class="stat est">구간 ${s.econGrade}/5</span>` : '';
    const tier = AptEngine.stationTier(s.sv, CFG);
    const tCls = tier.label === 'S' ? 'green' : tier.label === 'A' ? 'blue' : 'gray';
    const sub = m === 'sv'
      ? `교통 ${c.transit} · 경제력 ${c.econ} · 교육주거 ${c.edu} · 업무 ${c.biz}`
      : `균형형 ${Math.round(s.sv)} (${tier.label} Tier) · ${['transit', 'econ', 'edu', 'biz'].filter(k => k !== m).map(k => `${CAT[k].short} ${c[k]}`).join(' · ')}`;
    return `<div class="rankrow" data-st="${esc(n)}" style="cursor:pointer;flex-wrap:wrap">
      <span class="badge ${tCls}" style="flex:none;min-width:26px;text-align:center;padding:2px 7px">${tier.label}</span>${dot}<span class="nm">${esc(n)}${lowN}</span>
      <span class="ln">${s.lines.map(esc).join('·')}</span><span class="sc">${Math.round(metricOf(s))}</span>
      <span class="rsub">${sub}</span>
    </div>`;
  };
  const catNote = {
    sv: '4개 축(교통·네트워크 30% / 역세권 경제력 35% / 교육·주거 20% / 업무·중심성 15%)의 가중합 — 절대 순위가 아니라 균형형 관점의 결과입니다.',
    transit: '강남·도심·여의도 체감 이동시간과 환승·급행·배차 기준 — 균형형 평가와 다를 수 있습니다.',
    econ: '거주민 소득·소비 수준 추정 구간(5단계) 기준 — 시세·업무·상권 미반영이라 같은 구간은 동률입니다. 정밀 소득 데이터 미확보(전 역 추정).',
    edu: '학원가 접근성과 단지 밀집도 기준 — 학군·주거 지역이 업무지역보다 높게 나올 수 있습니다.',
    biz: '업무·상업·문화 시설 기준 — "업무가 강한 역"과 "종합 부동산 가치가 높은 역"은 다릅니다.'
  }[m];
  let body;
  if (m === 'sv') {
    // Tier 섹션 렌더 — 기본은 S·A만, 전체 보기 시 B·C 포함
    const groups = { S: [], A: [], B: [], C: [] };
    for (const n of ranked) groups[AptEngine.stationTier(STN.stations[n].sv, CFG).label].push(n);
    const tierDesc = { S: '수도권 핵심 역세권', A: '상위 역세권', B: '중상위 역세권', C: '그 외' };
    const shown = mapState.showAll ? ['S', 'A', 'B', 'C'] : ['S', 'A'];
    body = shown.filter(t => groups[t].length).map(t => `
      <h3 class="mini-h" style="margin-top:14px">${t} Tier <span style="font-weight:400;color:var(--muted)">— ${tierDesc[t]} · ${groups[t].length}개 역 (Tier 내 순서는 서열이 아닙니다)</span></h3>
      ${(mapState.showAll ? groups[t] : groups[t].slice(0, t === 'A' ? 14 : 99)).map(rowOf).join('')}
      ${!mapState.showAll && t === 'A' && groups.A.length > 14 ? `<p class="subtle">… A Tier ${groups.A.length - 14}개 역 더 (전체 보기)</p>` : ''}`).join('');
  } else {
    body = ranked.slice(0, mapState.showAll ? ranked.length : 12).map(rowOf).join('');
  }
  $('rankCard').innerHTML = `
    <h2>${mapState.line ? `${esc(mapState.line)} — ${CAT[m].short} 관점` : m === 'sv' ? '수도권 핵심 역세권 — Tier' : `${CAT[m].label} 관점 상위 역`}</h2>
    <p class="hint">실제 계산 결과로 생성되며 사전에 고정된 순위가 없습니다. ${catNote} 위 탭으로 관점을 바꾸면 지도 원 크기와 목록이 함께 바뀝니다 — 관점이 다르면 상위 역도 달라집니다.</p>
    ${body}
    <button class="btn ghost" id="rankMore" style="width:100%;margin-top:10px">${mapState.showAll ? '접기 — 핵심 Tier만 보기' : `전체 역 보기 (${ranked.length}개)`}</button>
    <p class="subtle" style="margin-top:10px">노선 가치: ${LINEI.lines.slice(0, 5).map(l => `${esc(l.name)} ${l.golden}${l.tier ? '(' + l.tier + ')' : ''}`).join(' · ')} — 역 평균이 아닌 별도 모델이며, 값 차이가 작은 노선은 같은 Tier입니다 (노선 칩을 눌러 근거 확인)</p>`;
  $('rankCard').querySelectorAll('.rankrow').forEach(row => row.onclick = () => selectStation(row.dataset.st));
  $('rankMore').onclick = () => { mapState.showAll = !mapState.showAll; renderRank(); if (mapState.showAll === false) $('rankCard').scrollIntoView({ block: 'start' }); };
}

/* ── 부팅 ── */
function renderVerLine() {
  const live = LIVE.status === 'ready'
    ? `실거래 자동 ${LIVE.index.meta.regions}개 지역 · ${LIVE.index.complexes.length.toLocaleString()}개 단지 (${LIVE.index.meta.updatedAt})`
    : '실거래 자동수집 연결 대기';
  $('verLine').textContent = `v${APP_VERSION} · ${live} · 상세 프로필 ${DATA.complexes.length}개 (${DATA.meta.asOf}) · 계수 ${CFG.asOf}`;
}
if (STN.meta.version !== LINEI.meta.version || STN.meta.generatedAt !== LINEI.meta.generatedAt)
  console.warn('⚠ station/line intelligence 데이터 버전 불일치 — pipeline/station_intel.js 재실행 필요', STN.meta.version, LINEI.meta.version);
renderVerLine();
renderAptList('');
renderStepper(); nav();
loadLive();
