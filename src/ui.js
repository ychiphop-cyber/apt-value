'use strict';
/* ═══════════════════════════════════════════════════════════════════
   닥터마빈 아파트 가치진단 — UI
   (빌드 시 CFG/HUBS/JOBS/DATA/REGIONS/AptEngine 주입)
   단지 소스 3종: ① 상세 프로필 샘플(DATA) ② 실거래 자동수집(data/live/*)
                 ③ 직접 입력
   ═══════════════════════════════════════════════════════════════════ */
const APP_VERSION = '3.3.0';
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
      <span class="l1">검색에 없는 아파트를 핵심 정보만으로 진단합니다 (신뢰도는 낮게 표시됩니다)</span>
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
    kapt: AptEngine.matchKaptInfo(KAPT.shards[code], entry.name, (ALIASES.aliases || {})[id]),
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
        <p class="subtle">요구수익률·임대가치 성장률 가정에 쓰입니다.</p></div>
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
    <p class="subtle">그 밖의 항목(주차·브랜드·공원·규제 등)은 중립 가정값으로 계산되며, 결과의 신뢰도 표시에 반영됩니다.</p>`;
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
    education: { elemM: 500, chopuma: false, middlePref: v.middlePref || 3, hubId: null, inHub: false, localAcademyLevel: v.acadLevel || 3, hubAccess: [], age3049: 0.30, studentTrend: 'stable' },
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
    <p class="hint">자동입력 값은 수정할 수 있습니다. 수정하면 결과 신뢰도 계산에 반영됩니다.</p>
    <div class="seg" id="areaSeg">${cx.areas.map(a => `<button data-k="${a.key}" aria-pressed="${a.key === state.areaKey}" aria-label="${esc(a.label)}${isLive ? `, 최근 매매 ${a.trades.length}건` : ''}">${esc(a.label)}${isLive ? ` · ${a.trades.length}건` : ''}</button>`).join('')}</div>
    <div class="grid2" style="margin-top:16px">
      <div>
        <label class="mini">현재 시장가격 ${state.ovPrice != null ? '<span class="stat est">수정됨</span>' : (latest ? '<span class="stat ok">자동입력</span>' : '<span class="stat chk" style="color:var(--accent);background:var(--accent-soft);border:1px solid var(--accent)">입력 필요</span>')}
          <span class="inline-num"><input type="number" id="inPrice" step="0.1" min="0" value="${priceVal}" aria-label="현재 시장가격, 억원 단위"><em>억원</em></span></label>
        ${latest ? `<div class="srcline">최근 실거래 ${latest.ym}${latest.d ? '-' + String(latest.d).padStart(2, '0') : ''} · ${fmtEok(latest.price)}${latest.floor ? ` (${latest.floor}층)` : ''}${(latest.o || (rep && rep.anomalous)) ? ' <span class="stat est">이상거래 의심</span>' : ''} — ${(isLive || cx.liveLinked) ? '국토교통부 실거래가 API' : esc(S.trades.src)}, ${(isLive || cx.liveLinked) ? esc(liveAsOf()) : esc(S.trades.asOf)} 기준${rep && rep.anomalous ? `<br>직전 거래가 최근 3개월 시세(중앙값 ${rep.peerMed}억)보다 뚜렷이 낮아 특수거래로 보입니다 — 최근 3개월 최고가 <b>${rep.price}억</b>을 자동입력했습니다.` : ''}</div>` : '<div class="srcline">이 평형은 최근 매매 실거래가 없습니다 — 시세를 직접 입력하세요.</div>'}
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
    <h3 class="mini-h">보완 정보 (선택) — 입력하면 정확도·신뢰도가 올라갑니다</h3>
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
    <h2>계산 가정</h2>
    <p class="hint">기본값 그대로 두어도 됩니다. 모든 가정은 결과 화면에 표시됩니다.</p>
    <div class="kv"><span>${esc(F.baseRate.label)}</span><span>${fmtPct(F.baseRate.value)} <span class="srcline" style="display:inline">(${esc(F.baseRate.asOf)})</span></span></div>
    <div class="kv"><span>${esc(F.mortgageRate.label)}</span><span>${fmtPct(F.mortgageRate.value)} <span class="srcline" style="display:inline">(${esc(F.mortgageRate.asOf)})</span></span></div>
    <div class="kv"><span>요구수익률 r (합성)</span><span>${fmtPct(r)} = 대체투자 ${fmtPct(F.altReturn)} + 유동성 ${fmtPct(F.liquidityPremium)} + 지역·자산위험</span></div>
    <div class="kv"><span>장기 임대가치 성장률 g</span><span>${fmtPct(F.longTermRentGrowth[cx.regionTier] ?? 0.006)} (${esc(cx.regionTier)})</span></div>
    <div class="grid2" style="margin-top:12px"><div>
      <label class="mini">시장 전월세전환율 ${state.ovConv != null ? '<span class="stat est">수정됨</span>' : '<span class="stat ok">자동입력</span>'}
        <span class="inline-num"><input type="number" id="inConv" step="0.1" min="1" max="12" value="${(conv * 100).toFixed(1)}" aria-label="시장 전월세전환율, 퍼센트"><em>%</em></span></label>
      <div class="srcline">법정 전환율이 아닌 지역 시장 전환율 기준</div>
    </div></div>
    ${liveExtra}`;
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

function runAnalysis() {
  go(3);
  $('report').innerHTML = ''; $('loading').style.display = 'block';
  state.stress = new Set();
  setTimeout(() => {
    try {
      state.baseInput = buildInput();
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

/* ═══ FR-07 "왜 이 가격인가" — 가격별 원자료→공식→중간값→최종값 공개 (AC-07: 화면 숫자만으로 재계산 가능) ═══ */
function whyPriceCard(r) {
  const mref = r.marketRef, fin = r.financial, co = r.combineOut, cx = r.cx;
  const RG = CFG.range, FNC = CFG.final, VD = CFG.verdicts, FG = CFG.financialGrade;
  const rc = 1 - r.market.compQuality;   // 잔차계수: 비교거래가 대상 자체일수록 히도닉 이중반영 제거
  const priceMethod = r.input.overrides.price != null ? '사용자 입력'
    : (r.repPrice && r.repPrice.anomalous) ? '이상 저가 보정 — 최근 3개월 내 최고가'
    : '최근 실거래';

  /* ② 시장 기준가 — 사용 거래·가중치·공식 */
  let refBody = '<p class="subtle">동일평형 거래가 없어 시장 기준가를 산출하지 못했습니다 — 비교거래 앵커로 대체합니다.</p>';
  if (mref && mref.items) {
    const rows = mref.items.slice().sort((a, b) => b.w - a.w).map(t =>
      `<tr><td>${esc(t.date)}</td><td>${t.floor ? t.floor + '층' : '—'}</td><td style="text-align:right">${t.price}억</td><td style="text-align:right">${(t.w * 100).toFixed(1)}%</td><td>${[t.outlier ? `이상거래 저가중 ×${mref.formula.outlierWeight}` : '', t.lowFloor ? `저층(≤${mref.formula.lowFloorMax}층) ×${mref.formula.lowFloorWeight}` : ''].filter(Boolean).join(' · ') || '—'}</td></tr>`).join('');
    const f = mref.formula;
    refBody = `
      <p class="subtle">기간창 규칙: ${CFG.marketRef.windowsDays.join('→')}일 — ${mref.baseWindowDays || 90}일 내 유효 거래 ${CFG.marketRef.minComps}건 미만이면 다음 창으로 확장${mref.extended ? ` (이번 계산: ${mref.windowDays}일까지 확장)` : ` (이번 계산: ${mref.windowDays}일창)`}. 최근성 반감기 ${f.recencyHalfLifeDays}일.</p>
      <div class="tblwrap"><table><thead><tr><th>계약일</th><th>층</th><th>거래가</th><th>가중치</th><th>저가중 사유</th></tr></thead><tbody>${rows}</tbody></table></div>
      <div class="kv"><span>가중중앙값 (반올림 전)</span><span class="strong">${fmtRaw(mref.med)}억 → 표시 ${fmtEok(mref.med)}</span></div>
      <div class="kv"><span>범위 반폭 half</span><span>max(최소반폭 ${(f.minHalfSpread * 100).toFixed(1)}%×중앙값 = ${fmtRaw(f.minHalf)}억, 사분위폭/2 = ${fmtRaw(f.iqrHalf)}억) = <b>${fmtRaw(f.half)}억</b>${f.minHalfApplied ? ' (최소반폭 적용)' : ' (분산 기준)'}</span></div>
      <div class="kv"><span>하단 = 중앙값 − half</span><span>${fmtRaw(mref.med)} − ${fmtRaw(f.half)} = ${fmtRaw(mref.low)}억 → 표시 ${fmtEok(mref.low)}</span></div>
      <div class="kv"><span>상단 = 중앙값 + half</span><span>${fmtRaw(mref.med)} + ${fmtRaw(f.half)} = ${fmtRaw(mref.high)}억 → 표시 ${fmtEok(mref.high)}</span></div>`;
  }

  /* ③ 금융 지지가치 — R·r·g 대입값 */
  let finBody;
  if (fin) {
    const scenRows = (fin.scen || []).map(s =>
      `<tr><td>${s.k === 'low' ? '보수' : s.k === 'base' ? '기준' : '우호'}</td><td style="text-align:right">${(s.g * 100).toFixed(2)}%</td><td style="text-align:right">${(fin.r * 100).toFixed(2)}% − ${(s.g * 100).toFixed(2)}% = ${((fin.r - s.g) * 100).toFixed(2)}%</td><td style="text-align:right"><b>${fmtRaw(s.v, 2)}억</b> → ${fmtEok(s.v)}</td><td>${s.mode === 'gordon' ? 'V=R÷(r−g)' : `유한 DCF ${CFG.financial.dcfYears}년`}</td></tr>`).join('');
    finBody = `
      <div class="kv"><span>연간 주거서비스 가치 R</span><span class="strong">${esc(fin.rSourceText)} = ${fmtRaw(fin.R)}억/년</span></div>
      <div class="kv"><span>요구수익률 r (합성)</span><span>대체투자 ${fmtPct(fin.rParts.altReturn)} + 유동성 ${fmtPct(fin.rParts.liquidityPremium)} + 자산위험 ${fmtPct(fin.rParts.assetRiskPremium)} + 지역위험 ${fmtPct(fin.rParts.regionRiskPremium)}${fin.rParts.rateDelta ? ` + 금리변화 ${signPct(fin.rParts.rateDelta)}` : ''} = <b>${(fin.r * 100).toFixed(2)}%</b></span></div>
      <div class="tblwrap"><table><thead><tr><th>시나리오</th><th>성장률 g</th><th>r − g</th><th>V (반올림 전 → 표시)</th><th>공식</th></tr></thead><tbody>${scenRows}</tbody></table></div>
      <div class="kv"><span>금융 지지력 비율</span><span>기준 시나리오 ${fmtRaw(fin.fsv.base, 2)}억 ÷ 현재가 ${fmtRaw(r.currentPrice, 2)}억 = <b>${r.verdicts.financial.ratio != null ? Math.round(r.verdicts.financial.ratio * 100) + '%' : '—'}</b></span></div>
      ${fin.impliedG != null ? `<div class="kv"><span>필요 성장률 역산 g*</span><span>r − R÷현재가 = ${(fin.r * 100).toFixed(2)}% − ${fmtRaw(fin.R)}÷${fmtRaw(r.currentPrice, 2)} = <b>${(fin.impliedG * 100).toFixed(2)}%</b></span></div>` : ''}
      <p class="subtle">전세 ${fmtEok(fin.jeonse)}${r.input.overrides.jeonse != null ? ' <span class="stat est">수동 입력(MANUAL)</span>' : ' (전월세 실거래 중앙값)'} · 전환율 ${(fin.conv * 100).toFixed(1)}% (지역 시장 전환율).</p>`;
  } else {
    finBody = '<p class="subtle">전세 실거래가 없어 금융·임대 지지가치를 산출하지 않았습니다(N/A). 임의 가정값으로 채우지 않으며, STEP 2에서 전세 시세를 입력하면 같은 공식(V=R÷(r−g))으로 계산해 표시합니다. 시장·주거·수급·미래 분석은 이 보류와 무관하게 계속 제공됩니다.</p>';
  }

  /* ④ 모델 종합가치 — 상대모델 브리지 (앵커 × (1+Σ조정)) */
  const adjLabels = { transport: '교통·역세권', job: '직주근접', education: '교육', life: '생활편의', nature: '자연환경', product: '상품성' };
  const vM = r.market.value;
  const adjRows = Object.entries(r.hedonic.adj).map(([k, a]) => {
    if (r.hedonic.subs[k] == null) return `<tr style="color:var(--muted)"><td>${adjLabels[k] || k}</td><td style="text-align:right">미확인</td><td style="text-align:right">—</td><td style="text-align:right">제외</td></tr>`;
    return `<tr><td>${adjLabels[k] || k}</td><td style="text-align:right">${signPct(a)}</td><td style="text-align:right">${signPct(a * rc)}</td><td style="text-align:right">${a ? (a * rc * vM >= 0 ? '+' : '') + fmtRaw(a * rc * vM, 2) + '억' : '—'}</td></tr>`;
  }).join('');
  const bridgeBody = `
    <p class="subtle">주거가치 점수는 가격에 직접 더하지 않습니다. 아래 브리지는 <b>비교거래 앵커</b>(동일단지·유사평형·인근 실거래 가중중앙값 — 대상의 현재가 입력값이 아님)에 항목별 조정률(카테고리 상한 ±${(CFG.hedonic.categoryCaps.transport * 100).toFixed(0)}% 수준, 총량 상한 ±${(CFG.hedonic.totalCap * 100).toFixed(0)}%)을 적용한 금액 경로입니다. 동일단지 거래 비중(${(r.market.compQuality * 100).toFixed(0)}%)만큼 이미 시장가격에 반영됐다고 보고 잔차계수 ${rc.toFixed(2)}를 곱합니다.</p>
    <div class="kv"><span>① 비교거래 앵커 P₀</span><span class="strong">${fmtRaw(vM, 2)}억 (동일평형 ${r.market.compCount}건 + 유사 ${r.market.compCountAll - r.market.compCount}건)</span></div>
    <div class="tblwrap"><table><thead><tr><th>항목</th><th>조정률</th><th>×잔차계수</th><th>금액 기여</th></tr></thead><tbody>${adjRows}
      <tr style="border-top:2px solid var(--line)"><td><b>히도닉 잔차 합계</b></td><td style="text-align:right">${signPct(r.hedonic.total)}</td><td style="text-align:right"><b>${signPct(co.hRes)}</b></td><td style="text-align:right"><b>${(co.hRes * vM >= 0 ? '+' : '') + fmtRaw(co.hRes * vM, 2)}억</b></td></tr>
      <tr><td>수급 조정</td><td style="text-align:right">${signPct(r.supplyE.adj)}</td><td style="text-align:right">${signPct(r.supplyE.adj)}</td><td style="text-align:right">${(r.supplyE.adj * vM >= 0 ? '+' : '') + fmtRaw(r.supplyE.adj * vM, 2)}억</td></tr></tbody></table></div>
    <div class="kv"><span>② 조정 후 시장경로 가치</span><span>P₀ × (1 ${signPct(co.hRes)} ${signPct(r.supplyE.adj)}) = <b>${fmtRaw(co.vMktAdj, 2)}억</b></span></div>
    ${co.marketOnly
      ? '<div class="kv"><span>③ 금융 결합</span><span>전세 없음 — 금융 경로 보류, 시장 경로만 사용 (가중 1.0)</span></div>'
      : `<div class="kv"><span>③ 금융 결합 (괴리 ${(co.disagreement * 100).toFixed(0)}% → 가중 축소)</span><span>${fmtRaw(co.vMktAdj, 2)}×${co.wm.toFixed(2)} + ${fmtRaw(co.vFundEff, 2)}×${co.wf.toFixed(2)} = <b>${fmtRaw(co.wm * co.vMktAdj + co.wf * co.vFundEff, 2)}억</b></span></div>`}
    <div class="kv"><span>④ 시장앵커 클램프 (±${(FNC.anchorClamp * 100).toFixed(0)}%)</span><span>${co.anchorClamped ? `범위 밖 → P₀×(1±${(FNC.anchorClamp * 100).toFixed(0)}%)로 제한 = ` : '범위 내 — 그대로 = '}<b>${fmtRaw(co.center, 2)}억</b></span></div>
    <div class="kv"><span>⑤ 범위 폭 spread</span><span>${(RG.minSpread * 100).toFixed(1)}% + ${RG.dispersionWeight}×분산 ${(r.market.dispersion * 100).toFixed(1)}% + ${RG.disagreementWeight}×괴리 ${(co.disagreement * 100).toFixed(0)}% + ${RG.dataGapWeight}×결측 ${((1 - r.fillRate) * 100).toFixed(0)}% = <b>${(r.range.spread * 100).toFixed(1)}%</b> [${(RG.minSpread * 100).toFixed(1)}~${(RG.maxSpread * 100).toFixed(0)}% 클램프]</span></div>
    <div class="kv"><span>모델 종합가치 범위</span><span class="strong">${fmtRaw(co.center, 2)}×(1∓${(r.range.spread * 100).toFixed(1)}%) = ${fmtRaw(r.range.low, 2)} ~ ${fmtRaw(r.range.high, 2)}억 → 표시 ${fmtEok(r.range.low)}~${fmtEok(r.range.high)}</span></div>
    <p class="subtle">역 경제력 축은 거주민 소득·소비 추정 등급만 쓰므로 '집값→역 가치→집값' 순환이 없습니다. 이 범위는 판정·가격매력도 계산에 쓰는 모델값이며, 상단 '시장 기준가'(동일평형 가중중앙값)와는 정의가 다른 별도 개념입니다.</p>`;

  /* ⑤ 판정 기준 — 임계치 공개 */
  const verdictBody = `
    <div class="kv"><span>시장 상대평가</span><span>현재가 ${fmtRaw(r.currentPrice, 2)}억 vs 기준가 ${mref ? `${fmtRaw(mref.low, 2)}~${fmtRaw(mref.high, 2)}억` : '—'} — 하단×${(1 - VD.marketTolerance).toFixed(3)} 미만이면 '${VD.marketLabels[0]}', 상단×${(1 + VD.marketTolerance).toFixed(3)} 초과면 '${VD.marketLabels[2]}', 그 외 '${VD.marketLabels[1]}' → <b>${r.verdicts.market.label}</b></span></div>
    <div class="kv"><span>금융 지지력</span><span>${fin ? `비율 ${Math.round(r.verdicts.financial.ratio * 100)}% — ≥${FG.bands[0] * 100}% ${FG.labels[0]} / ≥${FG.bands[1] * 100}% ${FG.labels[1]} / ≥${FG.bands[2] * 100}% ${FG.labels[2]} / 미만 ${FG.labels[3]} → <b>${r.verdicts.financial.label}</b>` : `전세 없음 → <b>${VD.heldLabel}</b>`}</span></div>
    <div class="kv"><span>미래 기대 반영도</span><span>${fin && fin.impliedG != null ? `역산 g* ${(fin.impliedG * 100).toFixed(2)}% vs 시나리오 [보수 ${(fin.gScen.low * 100).toFixed(1)}% / 기준 ${(fin.gScen.base * 100).toFixed(1)}% / 우호 ${(fin.gScen.high * 100).toFixed(1)}%] — 보수 미만 '낮음', 기준 이하 '보통', 우호 이하 '높음', 초과 '매우 높음' → <b>${r.verdicts.expectation.label}</b>` : `전세 없음 → <b>${VD.heldLabel}</b>`}</span></div>`;

  return `
  <div class="card" id="whyCard">
    <h2>왜 이 가격인가 — 금액 근거</h2>
    <p class="hint">화면의 모든 가격을 원자료 → 가중치 → 공식 → 중간값 → 최종값 순서로 공개합니다. 반올림은 표시 단계에서 한 번만 하며, 아래 숫자를 그대로 대입하면 대표 가격이 재계산됩니다.</p>
    <details class="acc"><summary><span class="sumleft">① 현재 시장가격 — ${esc(priceMethod)}</span><span class="sumr">${fmtEokW(r.currentPrice)}</span></summary><div class="detail-body">
      <div class="kv"><span>선택 규칙</span><span>사용자 수정 &gt; 이상 저가 보정(직전 거래가 3개월 또래 중앙값×${((CFG.marketRef.anomalyLow || {}).ratio || 0.85)} 미만 또는 이상거래 플래그면 3개월 내 최고가) &gt; 최근 실거래 — 이번 계산: <b>${esc(priceMethod)}</b></span></div>
      ${mref ? `<div class="kv"><span>근거 거래</span><span>${esc(mref.latest.date)} 계약 · ${mref.latest.floor ? mref.latest.floor + '층 · ' : ''}전용 ${r.area.m2}㎡ · ${mref.latest.price}억${mref.latest.outlier ? ' (이상거래 플래그)' : ''}</span></div>` : ''}
      ${r.repPrice && r.repPrice.anomalous && r.input.overrides.price == null ? `<div class="kv"><span>보정 내용</span><span>직전 거래가 최근 3개월 또래 중앙값 ${r.repPrice.peerMed}억의 ${((CFG.marketRef.anomalyLow || {}).ratio || 0.85) * 100}% 미만 → 3개월 내 최고가 ${r.repPrice.price}억으로 표기</span></div>` : ''}
      <div class="kv"><span>출처</span><span>${state.liveSel || cx.liveLinked ? '국토교통부 실거래가 공개 API' : 'DB 등재 실거래'} · ${esc(state.liveSel ? liveAsOf() : DATA.meta.asOf)} 기준${r.input.overrides.price != null ? ' · <b>사용자 입력(MANUAL)</b>' : ''}</span></div>
      <p class="subtle">현재 시장가격은 계산값이 아니라 실제 거래(또는 사용자 입력)의 대표값입니다.</p>
    </div></details>
    <details class="acc"><summary><span class="sumleft">② 시장 기준가 — 동일평형 가중중앙값</span><span class="sumr">${mref ? `${fmtEok(mref.low)}~${fmtEokW(mref.high)}` : '산출 불가'}</span></summary><div class="detail-body">${refBody}</div></details>
    <details class="acc"><summary><span class="sumleft">③ 금융 지지가치 — V = R ÷ (r − g)</span><span class="sumr">${fin ? `${fmtEok(fin.fsv.low)}~${fmtEokW(fin.fsv.high)}` : '분석 보류'}</span></summary><div class="detail-body">${finBody}</div></details>
    <details class="acc"><summary><span class="sumleft">④ 모델 종합가치 — 비교거래 앵커 × 속성 조정 브리지</span><span class="sumr">${fmtEok(r.range.low)}~${fmtEokW(r.range.high)}</span></summary><div class="detail-body">${bridgeBody}</div></details>
    <details class="acc"><summary><span class="sumleft">⑤ 가격 판정 기준 — 임계치</span><span class="sumr">${r.verdicts.market.label} · ${r.verdicts.financial.label} · ${r.verdicts.expectation.label}</span></summary><div class="detail-body">${verdictBody}</div></details>
  </div>`;
}

/* ── 등급 헬퍼 ── */
function gradeCls(score) { const B = CFG.scores.gradeBands; return score >= B.high ? 'A' : score >= B.mid ? 'B' : 'C'; }
function verdictBadge(pos) {
  if (pos.includes('하단 아래')) return ['green', pos + ' — 지표상 저평가 신호'];
  if (pos.includes('하단')) return ['green', pos];
  if (pos.includes('중앙')) return ['blue', pos];
  if (pos.includes('상단 위')) return ['', pos + ' — 프리미엄 구간'];
  return ['amber', pos];
}

/* ── 결과 렌더 ── */
function renderReport(r) {
  const cx = r.cx, area = r.area;
  const isLive = !!state.liveSel;
  const conf = r.confidence;
  const S = DATA.defaultSources;
  const mref = r.marketRef, V = r.verdicts, FU = r.future, ST = r.structural;

  const rvLow = mref ? mref.low : r.range.low, rvHigh = mref ? mref.high : r.range.high, rvMid = mref ? mref.med : r.combineOut.center;
  const lo0 = Math.min(rvLow, r.currentPrice), hi0 = Math.max(rvHigh, r.currentPrice);
  const span = hi0 - lo0 || 1;
  const dLo = lo0 - span * 0.18, dHi = hi0 + span * 0.18;
  const pos = x => ((x - dLo) / (dHi - dLo) * 100).toFixed(1);

  const vCls = { '할인': 'green', '적정': 'blue', '프리미엄': 'amber' };
  const fCls = { '강함': 'green', '양호': 'green', '보통': 'blue', '약함': 'amber' };
  const eCls = { '낮음': 'green', '보통': 'blue', '높음': 'amber', '매우 높음': '' };

  const tiles = [
    { k: '주거가치', v: Math.round(r.scores.living.total), s: '실제 거주하기 좋은가', id: 'accC' },
    { k: '투자가치', v: Math.round(r.scores.invest.total), s: '자산으로 보유할 경쟁력', id: 'accI' },
    { k: '미래가치', v: FU.score, s: '앞으로 더 선호될 이유가 있는가', id: 'accF' }
  ];

  const contribRows = r.explain.contrib.map(c => {
    const w = Math.min(50, Math.abs(c.v) / 40 * 50);
    return `<div class="cr"><div class="ck">${esc(c.k)}</div>
      <div class="cbar"><span class="mid"></span><i class="${c.v >= 0 ? 'pos' : 'neg'}" style="width:${w}%"></i></div>
      <div class="cv">${c.v >= 0 ? '+' : ''}${Math.round(c.v)}</div></div>`;
  }).join('');

  const sbRow = (k, v) => `<div class="sb"><div class="k">${k}</div><div class="sbar"><i style="width:${Math.round(v)}%"></i></div><div class="v">${Math.round(v)}</div></div>`;

  const compRows = r.market.comps.slice().sort((a, b) => b.w - a.w).slice(0, 8).map(c =>
    `<tr><td>${c.ym}</td><td>${esc(c.label)}</td><td>${fmtEok(c.raw)}</td><td>${fmtEok(c.v)}</td><td>${(c.w * 100).toFixed(0)}%</td></tr>`).join('');

  const fin = r.financial, sup = r.supplyE, opt = r.option, hd = r.hedonic, ed = hd.eduDetail;

  const srcRows = isLive
    ? `<div class="kv"><span>국토교통부 실거래가 공개 API (매매·전월세 자동수집)</span><span>${esc(liveAsOf())} 기준</span></div>
       <div class="kv"><span>입지·수급 간이 기본값 (pipeline/regions.json)</span><span>${esc(REGIONS.asOf)} 기준</span></div>`
    : Object.values(S).map(s => `<div class="kv"><span>${esc(s.src)}</span><span>${esc(s.asOf)} 기준</span></div>`).join('');

  $('report').innerHTML = `
  <div class="hero">
    <div class="aptname">${esc(cx.name)} <span style="font-weight:500;color:var(--muted);font-size:13px">${esc(area.label)}</span></div>
    <div class="aptsub">${esc(cx.city)} ${esc(cx.district)} ${esc(cx.dong)} · ${cx.builtYear ? `${cx.builtYear}년` : '준공연도 미확인'} · ${cx.households != null ? `${cx.households.toLocaleString()}세대` : '세대수 미확인'}${isLive ? ' · 실거래 자동수집' : ''}</div>
    <div class="quad">
      <div class="hs"><span class="k">현재 시장가격</span><div class="big">${fmtEokW(r.currentPrice)}</div>
        <div class="s">${mref ? `최근 실거래 ${esc(mref.latest.date)} · ${fmtEok(mref.latest.price)} · ${mref.latest.floor}층${(mref.latest.outlier || (r.repPrice && r.repPrice.anomalous)) ? ' <span class="stat est">이상거래 의심</span>' : ''}${r.repPrice && r.repPrice.anomalous && r.input.overrides.price == null ? ' — 이상 저가로 보여 최근 3개월 최고가로 표기' : ''}` : '실거래 기준'}</div></div>
      <div class="hs"><span class="k">시장 기준가</span><div class="big accent mid" style="font-size:21px">${mref ? `${fmtEok(mref.low)} ~ ${fmtEokW(mref.high)}` : `${fmtEok(r.range.low)} ~ ${fmtEokW(r.range.high)}`}</div>
        <div class="s">${mref ? `최근 ${mref.windowDays}일 동일평형 ${mref.n}건 가중중앙값${mref.extended ? ` <span class="stat est">${mref.baseWindowDays || 90}일 거래 부족 — ${mref.windowDays}일까지 확장</span>` : ''}${mref.nOutlier ? ` · 이상거래 ${mref.nOutlier}건 저가중` : ''}` : '비교거래 기반'}</div></div>
      <div class="hs"><span class="k">금융 지지가치</span><div class="big mid">${r.financial ? `${fmtEok(r.financial.fsv.low)} ~ ${fmtEokW(r.financial.fsv.high)}` : '<span style="font-size:16px;color:var(--muted)">분석 보류</span>'}</div>
        <div class="s">${r.financial ? '전세·금리·요구수익률 기준 (성장률 보수~우호 시나리오)' : '전세 실거래 없음 — STEP 2에서 전세 시세를 입력하면 제공됩니다'}</div></div>
      <div class="hs"><span class="k">장기 경쟁력</span><div class="big mid">${ST.score} <em style="font-style:normal;font-size:13px;color:var(--muted)">/ 100 · ${esc(ST.band)}</em></div>
        <div class="s">입지·교육·상품·희소성·미래 종합${ST.excluded.length ? ` (미확인 ${ST.excluded.length}개 항목 제외)` : ''}</div></div>
    </div>
    <div class="rangeviz">
      <div class="rv-band">
        <div class="rv-rail"></div>
        <div class="rv-fill" style="left:${pos(rvLow)}%;width:${(pos(rvHigh) - pos(rvLow)).toFixed(1)}%"></div>
        <div class="rv-center" style="left:${pos(rvMid)}%"></div>
        <div class="rv-price" style="left:${pos(r.currentPrice)}%" title="현재 가격"></div>
      </div>
      <div class="rv-labels"><span>${fmtEok(rvLow)}</span><span>시장 기준가 (중앙 ${fmtEok(rvMid)})</span><span>${fmtEok(rvHigh)}</span></div>
      <div class="rv-cap">● 현재 가격 위치</div>
    </div>
    <div class="chiprow">
      <span class="vlabel-chip">시장 상대평가</span><span class="badge ${vCls[V.market.label] ?? 'gray'}">${V.market.label}</span>
      <span class="vlabel-chip">금융 지지력</span><span class="badge ${fCls[V.financial.label] ?? 'gray'}">${V.financial.held ? V.financial.label : `${V.financial.label} ${Math.round(V.financial.ratio * 100)}%`}</span>
      <span class="vlabel-chip">미래 기대 반영도</span><span class="badge ${eCls[V.expectation.label] ?? 'gray'}">${V.expectation.label}</span>
      <span class="badge gray">신뢰도 ${conf.label}</span>${r.fillRate < 0.7 ? '<span class="badge amber">데이터 충족률 낮음 — 참고 수준</span>' : ''}
    </div>
    <div class="conf">시장 기준가 거래 ${mref ? mref.n : r.market.compCount}건 · 데이터 충족률 ${(r.fillRate * 100).toFixed(0)}% · 신뢰도 ${conf.score}/100${r.dataStatus ? ` · 확인 ${r.dataStatus.VERIFIED} / 수동 ${r.dataStatus.MANUAL} / 추정 ${r.dataStatus.ESTIMATED} / 미확인 ${r.dataStatus.UNKNOWN}` : ''}</div>
  </div>

  ${r.explain.oneLiner ? `<div class="oneliner"><b>이 아파트를 한 문장으로 보면</b> — ${esc(r.explain.oneLiner)}</div>` : ''}

  ${whyPriceCard(r)}

  <div class="card">
    <h2>핵심 진단</h2>
    <p class="hint">좋은 아파트와 싼 아파트는 다른 개념입니다 — 세 점수를 분리해 보세요. 점수를 누르면 상세 근거로 이동합니다.</p>
    <div class="tiles3">
      ${tiles.map(t => { const g = gradeCls(t.v); return `<button class="t3" data-acc="${t.id}">
        <div class="k">${t.k}</div><div class="v g${g}">${t.v}<em> / 100</em></div>
        <div class="bar"><i class="bg${g}" style="width:${t.v}%"></i></div><div class="s">${t.s}</div></button>`; }).join('')}
    </div>
    ${r.fillRate < 0.7 ? `<p class="subtle" style="margin-top:10px"><span class="stat est">참고 수준</span> 데이터 충족률 ${(r.fillRate * 100).toFixed(0)}%로 낮아 점수를 단일 확정값이 아닌 참고 범위로 보세요 — 미확인 항목은 제외·재정규화했고, 보완 입력 시 정밀해집니다.</p>` : ''}
    ${isLive ? '<p class="subtle" style="margin-top:10px">실거래 자동수집 단지는 가격·전세는 실데이터, 입지·상품 상세는 기본값 기반입니다. 주거가치·투자가치는 참고 수준으로 보고, 보완 정보를 입력할수록 정확해집니다.</p>' : ''}
  </div>

  ${r.transit ? (() => {
    const t = r.transit, p = t.primary;
    const totalStn = Object.keys(STN.stations).length;
    const goldenRows = p.lines.map(ln => { const L = LINEI.lines.find(x => x.name === ln); return L ? `<span class="badge gray" style="border-color:${L.color};color:var(--ink)"><i style="width:8px;height:8px;border-radius:50%;background:${L.color};display:inline-block"></i>${esc(ln)} 노선 가치 ${L.golden}${L.tier ? ' · ' + L.tier : ''}</span>` : ''; }).join(' ');
    let hopViz = '';
    for (const ln of p.lines) {
      const le = RAIL_LINES.find(x => x.name === ln && !x.overlay && x.stations.includes(p.st));
      if (!le) continue;
      const i = le.stations.indexOf(p.st);
      const trio = [le.stations[i - 1], p.st, le.stations[i + 1]].filter(Boolean);
      hopViz = `<h3 class="mini-h">한 정거장의 가치 (${esc(ln)})</h3><div class="hopviz">${trio.map(s => { const d = STN.stations[s]; return `<div class="hop ${s === p.st ? 'cur' : ''}"><div class="hn">${esc(s)}</div><div class="hv">${d ? Math.round(d.sv) : '—'}</div><div class="hs">Station Value</div></div>`; }).join('')}</div>`;
      break;
    }
    let sentence;
    if (t.bonus > 0.01 && t.bonusNotes.length) sentence = `단순한 복수 역세권이 아니라, ${t.bonusNotes[0]} — 서로 다른 생활권을 실제로 확장하는 구성이라 추가 가치를 인정했습니다.`;
    else if (t.secondary) sentence = `두 개 역을 이용할 수 있지만 접근 가능한 업무지가 크게 겹쳐, 가장 강한 역(${esc(p.st)}) 중심으로 평가했습니다 — 노선 개수가 아니라 새로 열리는 목적지가 기준입니다.`;
    else if (p.express) sentence = `${esc(p.st)}은(는) 급행·광역 노선이 정차해 단일 노선임에도 주요 업무지 도달력이 높게 평가됐습니다.`;
    else sentence = `${esc(p.st)}의 힘(업무지 접근·네트워크·목적지가치)과 도보 ${p.min}분 거리를 함께 반영한 평가입니다.`;
    const sb = (k, v) => `<div class="sb"><div class="k">${k}</div><div class="sbar"><i style="width:${Math.round(v)}%"></i></div><div class="v">${Math.round(v)}</div></div>`;
    return `<div class="card" id="transitCard">
    <h2>교통 가치 분석 <span style="font-size:14px;color:var(--accent)">${Math.round(r.hedonic.subs.transport)} / 100</span></h2>
    <p class="hint">"역세권인가?"가 아니라 "얼마나 강력한 역을 얼마나 가까이 이용하는가"를 평가합니다.</p>
    <div class="tiles3" style="grid-template-columns:1fr 1fr">
      <div class="t3" style="cursor:default"><div class="k">가장 강력한 역 — 내 역의 힘</div>
        <div class="v">${esc(p.st)} <em>${p.lines.map(esc).join(' · ')}</em></div>
        <div class="s">Station Value <b>${p.sv}</b> / 100 · 수도권 ${totalStn}개 역 중 <b>${p.rank}위 (상위 ${p.rankPct}%)</b> · 도보 ${p.min}분${p.status === 'ESTIMATED' ? ' <span class="stat est">추정</span>' : p.status === 'MANUAL' ? ' <span class="stat ok">확인</span>' : ''}</div></div>
      <div class="t3" style="cursor:default"><div class="k">강남 핵심 접근</div>
        <div class="v g${gradeCls(t.gangnamScore)}">${t.gangnamScore}<em> / 100</em></div>
        <div class="s">${esc(p.st)}에서 강남권 약 ${t.gangnamMin}분</div></div>
    </div>
    <h3 class="mini-h">역 가치 구성 — 4축 (수도권 전체 역 대비 백분위)</h3>
    ${sb('교통·네트워크 (30%)', p.comps.transit)}${sb('역세권 경제력 (35%)', p.comps.econ)}${sb('교육·주거 생활권 (20%)', p.comps.edu)}${sb('업무·도시 중심성 (15%)', p.comps.biz)}
    <div class="chips" style="margin-top:10px">${goldenRows}</div>
    ${hopViz}
    <div class="op" style="margin-top:14px"><div class="ot">분석</div><p>${sentence}</p></div>
    <button class="btn ghost" id="openMapFromResult" style="width:100%;margin-top:8px">🚇 역 가치 지도에서 ${esc(p.st)}역 보기</button>
    <p class="subtle" style="margin-top:8px">역 가치는 그래프 이동시간·공개 데이터 기반 자동 계산(추정 포함)이며, 기존 교통점수를 대체할 뿐 별도 가산되지 않습니다. 역의 경제력 축은 거주민 소득·소비 수준 추정 등급(5단계)만 사용하고 아파트 시세는 쓰지 않습니다(순환 참조 차단). 아파트 평가에 쓰는 블렌드(svT)는 경제력·교육 축을 각 ${Math.round(CFG.station.v4.axesForValuation.econ * 100)}%·${Math.round(CFG.station.v4.axesForValuation.edu * 100)}%로 축소해, 추정 등급의 불확실성과 단지 교육점수와의 중복을 줄입니다.</p>
  </div>`; })() : ''}

  <div class="card">
    <h2>가격을 움직이는 요인</h2>
    <div class="factors">
      <div class="fbox up"><div class="fh">가격을 올리는 요인</div><ul>${r.explain.up.map(f => `<li>${esc(f)}</li>`).join('')}</ul></div>
      <div class="fbox down"><div class="fh">가격을 누르는 요인</div><ul>${r.explain.down.map(f => `<li>${esc(f)}</li>`).join('')}</ul></div>
    </div>
    <h3 class="mini-h">상대적 가치 기여도 <span style="font-weight:400">— 평균적 아파트(0) 대비 상대 지표. 실제 금액 반영 경로는 위 '왜 이 가격인가 → ④ 모델 종합가치'에 공개</span></h3>
    <div class="contrib">${contribRows}</div>
  </div>

  <div class="card">
    <h2>진단 요약</h2>
    <div class="diag core"><div class="dt">이 아파트의 핵심 경쟁력</div><p>${esc(r.explain.diagnosis.core)}</p></div>
    <div class="diag supp"><div class="dt">현재 가격을 지지하는 요소</div><p>${esc(r.explain.diagnosis.support)}</p></div>
    <div class="diag weak"><div class="dt">현재 가격의 취약점</div><p>${esc(r.explain.diagnosis.weakness)}</p></div>
    <div class="diag watch"><div class="dt">앞으로 볼 변수</div><p>${esc(r.explain.diagnosis.watch)}</p></div>
  </div>

  <div class="card">
    <h2>현재 가격에 대한 해석</h2>
    ${r.explain.interpretation.map(t => `<div class="op"><div class="ot">해석</div><p>${esc(t)}</p></div>`).join('')}
    ${opt.scenario ? `<div class="notebox"><b>미래 옵션가치 ${opt.gradeLabel}</b> — ${esc(opt.scenario)}${opt.note ? `<br>※ ${esc(opt.note)}` : ''}${opt.premiumNote ? `<br>※ ${esc(opt.premiumNote)}` : ''}</div>` : ''}
  </div>

  <div class="card" id="stressCard">
    <h2>스트레스 테스트</h2>
    <p class="hint">조건이 바뀌면 이 가격은 어떻게 되나 — 시나리오를 눌러 즉시 확인하세요. 복수 선택할 수 있습니다.</p>
    <div class="stressgrid" id="stressBtns">
      ${CFG.stress.presets.map(p => `<button class="sbtn" data-sid="${p.id}" aria-pressed="false">${esc(p.label)}</button>`).join('')}
      <button class="sreset" id="stressReset">초기화</button>
    </div>
    <div id="stressOut"></div>
  </div>

  <div class="card">
    <h2>상세 분석</h2>
    <p class="hint">다섯 개 엔진의 계산 근거를 각각 확인할 수 있습니다.</p>

    <details class="acc" id="accA"><summary><span class="sumleft">시장 상대가치 — 비교거래 앵커</span><span class="sumr">${fmtEok(r.market.value)}</span></summary><div class="detail-body">
      <p class="subtle">비교거래 앵커는 유사평형·비교단지까지 포함한 모델 계산용 기준으로, 상단의 '시장 기준가'(동일평형만의 기간창 가중중앙값)와는 정의가 다른 별도 지표입니다 (FR-06 — 같은 개념이 아니므로 이름을 분리).</p>
      <div class="kv"><span>비교거래 가중중앙값</span><span>${fmtEokW(r.market.value)}</span></div>
      <div class="kv"><span>가중 25~75분위</span><span>${fmtEok(r.market.p25)} ~ ${fmtEokW(r.market.p75)}</span></div>
      <div class="kv"><span>비교거래 구성</span><span>동일평형 ${r.market.compCount}건 / 전체 ${r.market.compCountAll}건 (동일평형 비중 ${(r.market.compQuality * 100).toFixed(0)}%)</span></div>
      <p class="subtle">거래시점이 오래될수록 가중치를 절반씩 감소(반감기 ${CFG.market.compHalfLifeMonths}개월), 타평형·타단지는 면적·특성 보정 후 낮은 유사도로 반영합니다.</p>
      <div class="tblwrap"><table><thead><tr><th>시점</th><th>구분</th><th>거래가</th><th>보정가</th><th>가중치</th></tr></thead><tbody>${compRows}</tbody></table></div>
    </div></details>

    <details class="acc" id="accB"><summary><span class="sumleft">금융·임대 내재가치</span><span class="sumr">${fin ? fmtEok(fin.value) : '분석 보류'}</span></summary><div class="detail-body">
      ${fin ? `
      <div class="kv"><span>연간 주거서비스 가치 R</span><span>${fmtEokW(fin.R)} <span class="srcline" style="display:inline">(${esc(fin.rSourceText)})</span></span></div>
      <div class="kv"><span>요구수익률 r</span><span>${fmtPct(fin.r)}</span></div>
      <div class="kv"><span>장기 임대가치 성장률 g</span><span>${fmtPct(fin.g)}</span></div>
      <div class="kv"><span>계산 방식</span><span>${fin.mode === 'gordon' ? 'V = R ÷ (r − g)' : `유한 DCF ${CFG.financial.dcfYears}년 (r−g 근접 가드)`}</span></div>
      <div class="kv"><span>임대 내재가치</span><span class="strong">${fmtEokW(fin.value)}</span></div>
      <div class="kv"><span>현재가 유지에 필요한 성장률 (역산)</span><span class="strong">연 ${fmtPct(fin.impliedG)}</span></div>
      <h3 class="mini-h">전세 = 자금조달 구조</h3>
      <div class="kv"><span>전세가율</span><span>${fmtPct(fin.jeonseRatio, 0)}</span></div>
      <div class="kv"><span>필요 자기자본 (매매가 − 전세가)</span><span>${fmtEokW(fin.equity)}</span></div>
      ${r.support ? `<div class="kv"><span>전세지지력</span><span class="strong">${r.support.label} (${r.support.score}점)</span></div>
      <p class="subtle">근거: ${r.support.factors.map(esc).join(' · ')}</p>` : ''}`
      : '<p class="subtle">전세 실거래가 없어 금융·임대 지지가치와 전세지지력 산출을 보류했습니다. 임의 가정값으로 대체하지 않으며, STEP 2에서 전세 시세를 입력하면 제공됩니다. 시장·주거·수급·미래 분석은 정상 제공됩니다.</p>'}
    </div></details>

    <details class="acc" id="accC"><summary><span class="sumleft">주거·입지·상품가치</span><span class="sumr">주거가치 ${Math.round(r.scores.living.total)}점</span></summary><div class="detail-body">
      ${sbRow('교통', hd.subs.transport)}${sbRow('직주근접', hd.subs.job)}${sbRow('교육', hd.subs.education)}${sbRow('생활편의', hd.subs.life)}${sbRow('자연환경', hd.subs.nature)}${sbRow('상품성', hd.subs.product)}
      <h3 class="mini-h">교육가치 상세</h3>
      ${sbRow('학교환경', ed.school)}${sbRow('학원가', ed.academy)}${sbRow('교육접근성', ed.access)}${sbRow('수요 지속성', ed.demand)}
      <p class="subtle">${esc(hd.notes.education.join(' / '))}</p>
      <h3 class="mini-h">근거 메모</h3>
      <ul style="margin:4px 0 0;padding-left:18px;font-size:12.5px;color:var(--ink2);line-height:1.7">
        ${['transport', 'job', 'life', 'nature', 'product'].map(k => (hd.notes[k] || []).map(x => `<li>${esc(x)}</li>`).join('')).join('')}
      </ul>
      <p class="subtle" style="margin-top:10px">겹치는 프리미엄(역세권·직주·학군 등)은 카테고리 안에서 점수화하고, 가격 반영은 카테고리별 상한(cap)과 총량 상한으로 제한해 중복가산을 막습니다. 동일단지 동일평형 실거래로 비교할 때는 이 조정이 이미 시장가격에 들어있다고 보고 잔차만 반영합니다(현재 잔차 ${signPct(r.combineOut.hRes)}).</p>
    </div></details>

    <details class="acc" id="accD"><summary><span class="sumleft">수요·공급·시장구조</span><span class="sumr">${sup.gradeLabel}</span></summary><div class="detail-body">
      ${sup.notes.map(x => `<div class="kv"><span style="flex:1">${esc(x)}</span><span></span></div>`).join('')}
      <div class="kv"><span>종합 공급부담 판정</span><span class="strong">${sup.gradeLabel}</span></div>
      <div class="kv"><span>가격 반영(제한적)</span><span>${signPct(sup.adj)}</span></div>
      <p class="subtle">간이 수요추정치(인구×${fmtPct(CFG.supply.demandRate, 1)})는 절대수요가 아닌 관행적 근사값입니다. 행정구역만이 아니라 인접 생활권·광역시장을 ${Math.round(CFG.supply.zoneWeights.local * 100)}:${Math.round(CFG.supply.zoneWeights.adjacent * 100)}:${Math.round(CFG.supply.zoneWeights.metro * 100)}으로 가중합니다.${isLive ? ' 자동수집 단지의 공급·인구는 시군구 간이 기본값입니다(STEP 2에서 수정 가능).' : ''}</p>
      <h3 class="mini-h">규제 효과 (양면)</h3>
      <div class="kv"><span>매수수요 압력</span><span style="text-align:left;flex:1.2">${esc(sup.regulation.demandSide)}</span></div>
      <div class="kv"><span>매물잠김 압력</span><span style="text-align:left;flex:1.2">${esc(sup.regulation.lockinSide)}</span></div>
    </div></details>

    <details class="acc" id="accE"><summary><span class="sumleft">미래 옵션가치</span><span class="sumr">${opt.gradeLabel}</span></summary><div class="detail-body">
      <div class="kv"><span>정비사업 단계</span><span>${opt.label}</span></div>
      <div class="kv"><span>단계별 실현확률 가정</span><span>${(opt.prob * 100).toFixed(0)}%</span></div>
      ${opt.headroom != null ? `<div class="kv"><span>용적률 여유</span><span>${cx.far}% → 허용 ${cx.allowedFar}% (+${(opt.headroom * 100).toFixed(0)}%)</span></div>` : ''}
      <div class="kv"><span>내재가치 보정(제한적)</span><span>${opt.premium > 0 ? '+' + fmtPct(opt.premium) : '금액 미반영'}</span></div>
      ${opt.scenario ? `<p class="subtle">${esc(opt.scenario)}</p>` : '<p class="subtle">현재 정비사업·리모델링 추진 단계가 아닙니다. 연식이 쌓이고 용적률 여유가 있으면 옵션가치가 생길 수 있습니다.</p>'}
      <p class="subtle">연식에 따른 상품성 감점과 재건축 옵션가치는 분리해 계산합니다.</p>
    </div></details>

    <details class="acc" id="accI"><summary><span class="sumleft">투자가치 구성</span><span class="sumr">${Math.round(r.scores.invest.total)}점</span></summary><div class="detail-body">
      ${r.scores.invest.subs.jeonseSupport != null ? sbRow('전세지지력', r.scores.invest.subs.jeonseSupport) : '<div class="sb"><div class="k">전세지지력</div><div style="font-size:11px;color:var(--muted)">전세 없음 — 보류·재정규화</div><div class="v">—</div></div>'}${sbRow('수급 구조', r.scores.invest.subs.supplyDemand)}${sbRow('희소성', r.scores.invest.subs.scarcity)}${sbRow('미래가치', r.scores.invest.subs.future)}${sbRow('핵심입지', r.scores.invest.subs.location)}${sbRow('유동성', r.scores.invest.subs.liquidity)}
    </div></details>

    <details class="acc" id="accF"><summary><span class="sumleft">미래가치 · 성장률 시나리오</span><span class="sumr">${FU.score}점</span></summary><div class="detail-body">
      ${[['수요 지속성', FU.comps.demand], ['공급 희소성', FU.comps.scarcity], ['교통·일자리 변화', FU.comps.transitChange], ['교육·주거선호', FU.comps.eduPref], ['정비사업 옵션', FU.comps.redevOption]]
        .map(([k, v]) => v == null ? `<div class="sb"><div class="k">${k}</div><div style="font-size:11px;color:var(--muted)">미확인 — 제외</div><div class="v">—</div></div>` : sbRow(k, v)).join('')}
      <div class="kv"><span>장기 주거가치 성장률 시나리오</span><span class="strong">보수 ${fmtPct(FU.g.low)} · 기준 ${fmtPct(FU.g.base)} · 우호 ${fmtPct(FU.g.high)}</span></div>
      <div class="kv"><span>현재가 유지에 필요한 성장률 (역산)</span><span class="strong">${r.financial ? `연 ${fmtPct(r.financial.impliedG)}` : '전세 없음 — 보류'}</span></div>
      <p class="subtle">미래가치는 재건축 하나가 아니라 수요·공급·교통변화·교육선호·정비옵션 다섯 축으로 평가하며, 그 결과가 금융가치의 성장률 가정(g)을 결정합니다. 역산 성장률이 우호 시나리오보다 높으면 "미래 기대 반영도"가 높음/매우 높음으로 표시됩니다.</p>
    </div></details>

    <details class="acc" id="accP"><summary><span class="sumleft">가격 판정 산출 근거</span><span class="sumr">${V.market.label} · ${V.financial.label} · ${V.expectation.label}</span></summary><div class="detail-body">
      <div class="kv"><span>① 시장 상대평가</span><span class="strong">${V.market.label}</span></div>
      <p class="subtle">현재가 ${fmtEokW(r.currentPrice)} vs 시장 기준가 ${mref ? `${fmtEok(mref.low)}~${fmtEok(mref.high)}` : '—'} — 최근 실거래 여러 건의 가중중앙값 범위와 비교합니다. 최근 1건이 아니라 기간창(${mref ? mref.windowDays : 90}일) 거래로 판단합니다.</p>
      <div class="kv"><span>② 금융 지지력</span><span class="strong">${V.financial.held ? V.financial.label : `${V.financial.label} (현재가의 ${Math.round(V.financial.ratio * 100)}%)`}</span></div>
      ${r.financial
        ? `<p class="subtle">전세 ${fmtEok(r.financial.jeonse)} × 전환율 ${(r.financial.conv * 100).toFixed(1)}% ÷ (요구수익률 ${fmtPct(r.financial.r)} − 성장률) = ${fmtEok(r.financial.fsv.low)}~${fmtEok(r.financial.fsv.high)}. 금융수익률이 낮다고 '고평가'로 단정하지 않습니다 — 서울 핵심 아파트의 가격은 임대수익만으로 설명되지 않는 프리미엄(입지·교육·희소성·토지가치)을 포함할 수 있습니다.</p>`
        : '<p class="subtle">전세 실거래가 없어 금융 지지력 판정을 보류했습니다. 전세 시세를 입력하면 판정이 포함됩니다.</p>'}
      <div class="kv"><span>③ 미래 기대 반영도</span><span class="strong">${V.expectation.label}</span></div>
      ${r.financial
        ? `<p class="subtle">역산 성장률 ${fmtPct(r.financial.impliedG)} vs 모델 시나리오(${fmtPct(r.financial.gScen.low)}~${fmtPct(r.financial.gScen.high)}) — 현재 가격이 어느 시나리오까지 미래를 당겨왔는지 봅니다.</p>`
        : '<p class="subtle">역산 성장률 계산에 전세 기반 임대가치가 필요해, 전세 입력 전까지 보류합니다.</p>'}
    </div></details>

    <details class="acc" id="accConf"><summary><span class="sumleft">신뢰도 · 데이터 출처</span><span class="sumr">${conf.label} ${conf.score}/100</span></summary><div class="detail-body">
      ${conf.penalties.length ? `<ul style="margin:0;padding-left:18px;font-size:12.5px;color:var(--ink2);line-height:1.7">${conf.penalties.map(p => `<li>${esc(p)}</li>`).join('')}</ul>` : '<p class="subtle">감점 요인이 없습니다.</p>'}
      ${r.dataStatus ? `<h3 class="mini-h">자동 데이터 상태</h3>
      <div class="chips">
        <span class="stat ok">확인(VERIFIED) ${r.dataStatus.VERIFIED}</span>
        <span class="stat info">수동 입력(MANUAL) ${r.dataStatus.MANUAL}</span>
        <span class="stat est">추정(ESTIMATED) ${r.dataStatus.ESTIMATED}</span>
        <span class="stat" style="color:var(--muted);background:var(--raised);border:1px solid var(--line)">미확인(UNKNOWN) ${r.dataStatus.UNKNOWN}</span>
      </div>
      <p class="subtle">미확인 항목은 실제 값처럼 계산하지 않고 중립 처리하며, 그만큼 신뢰도를 낮춰 표시합니다.</p>` : ''}
      ${r.gaps.length ? `<p class="subtle">데이터 공백: ${r.gaps.map(esc).join(' · ')}</p>` : ''}
      <h3 class="mini-h">데이터 출처·기준일</h3>
      ${srcRows}
      <div class="kv"><span>금리·계수 설정</span><span>${esc(CFG.asOf)} 기준 (config)</span></div>
      ${isLive ? '' : `<p class="subtle">${esc(DATA.meta.notice)}</p>`}
    </div></details>
  </div>

  ${(() => {
    const W = CFG.scores.living;
    const cats = [['transport', '교통·역세권'], ['job', '직주근접'], ['education', '교육'], ['life', '생활편의'], ['nature', '자연환경'], ['product', '단지 경쟁력']];
    const usedW = cats.reduce((a, [k]) => a + (hd.subs[k] != null ? W[k] : 0), 0);
    const renorm = usedW < 0.999;
    const rows = cats.map(([k, label]) => {
      const s = hd.subs[k];
      const reason = k === 'education' ? ((hd.notes.education || [])[1] || (hd.notes.education || [])[0] || '—') : ((hd.notes[k] || [])[0] || '—');
      if (s == null) return `<tr style="color:var(--muted)"><td>${label}</td><td style="text-align:right">—</td><td style="text-align:right">${Math.round(W[k] * 100)}%</td><td style="text-align:right">제외</td><td>${esc(reason)}</td></tr>`;
      const effW = W[k] / usedW;
      return `<tr><td>${label}</td><td style="text-align:right"><b>${Math.round(s)}</b></td><td style="text-align:right">${Math.round(W[k] * 100)}%${renorm ? `→${Math.round(effW * 100)}%` : ''}</td><td style="text-align:right">${(s * effW).toFixed(1)}</td><td>${esc(reason)}</td></tr>`;
    }).join('');
    const lm = { transport: '교통·역세권', job: '직주근접', education: '교육', life: '생활편의', nature: '자연환경', product: '상품성', jeonseSupport: '전세지지력', supplyDemand: '수급', scarcity: '희소성', future: '미래가치', location: '핵심입지', liquidity: '유동성', transit: '교통' };
    const wline = obj => Object.entries(obj).map(([k, v]) => `${lm[k] || k} ${Math.round(v * 100)}%`).join(' · ');
    const cBadge = { '높음': 'green', '보통': 'blue', '낮음': 'amber' }[conf.label] || 'gray';
    const AV = CFG.station.v4 ? CFG.station.v4.axesForValuation : null;
    return `<div class="card" id="modelCard">
    <h2>이 아파트의 가치는 어떻게 계산했나요?</h2>
    <p class="hint">점수의 근거를 공개합니다 — 아래 가중치와 점수는 설명용 예시가 아니라 이번 계산에 실제 사용된 값(config)입니다.</p>
    <p style="font-size:13.5px;color:var(--ink2);line-height:1.75;margin:0 0 12px">이 모델은 현재 가격만 보지 않습니다. 교통·역 가치·직주근접·교육·생활편의·주거환경·단지 규모·연식·브랜드·정비사업 가능성·미래 성장 시나리오를 함께 계산해, 같은 지역·수도권 아파트 대비 <b>상대가치</b>를 평가합니다. 그래서 결과도 하나의 '적정가'가 아니라 <b>시장 기준가 범위 · 금융 지지가치 · 판정 3종</b>으로 제시합니다.</p>
    <h3 class="mini-h">① 이 단지의 주거가치 ${Math.round(r.scores.living.total)}점은 이렇게 나왔습니다</h3>
    <div class="tblwrap"><table class="modeltbl"><thead><tr><th>평가항목</th><th>점수</th><th>가중치</th><th>기여도</th><th>평가 이유</th></tr></thead><tbody>${rows}
      <tr style="font-weight:700;border-top:2px solid var(--line)"><td>주거가치 합계</td><td></td><td></td><td style="text-align:right">${Math.round(r.scores.living.total)}</td><td style="font-weight:400;color:var(--muted)">${renorm ? '미확인 항목은 제외하고 나머지 가중치를 재정규화한 합계' : '가중 평균'}</td></tr></tbody></table></div>
    <h3 class="mini-h">② 전체 평가 구조 — 실제 가중치</h3>
    <div class="kv"><span>주거가치</span><span style="text-align:left;flex:2.2">${wline(W)}</span></div>
    <div class="kv"><span>투자가치</span><span style="text-align:left;flex:2.2">${wline(CFG.scores.invest)}</span></div>
    <div class="kv"><span>장기 경쟁력</span><span style="text-align:left;flex:2.2">${wline(CFG.structural.weights)}</span></div>
    <div class="kv"><span>가격 판정</span><span style="text-align:left;flex:2.2">시장 상대평가(기준가 범위 대비) · 금융 지지력(전세·금리 기반) · 미래 기대 반영도(역산 성장률) — 근거는 위 '가격 판정 산출 근거'</span></div>
    <h3 class="mini-h">③ 각 항목은 어떤 데이터로 계산되나</h3>
    <ul style="margin:4px 0 0;padding-left:18px;font-size:12.5px;color:var(--ink2);line-height:1.8">
      <li><b>가격·시장 기준가</b> — 국토교통부 실거래가(매매·전월세 자동수집), 최근 ${mref ? mref.windowDays : 90}일 동일평형 가중중앙값 범위. 이상거래는 자동 저가중. 직전 거래가 시세 대비 이상 저가(특수거래 의심)면 현재가는 최근 3개월 최고가로 표기합니다.</li>
      <li><b>교통·역세권</b> — 가장 가까운 역까지 도보시간 × 역 가치(Station Value: 교통·네트워크 30 / 역세권 경제력 35 / 교육·주거 20 / 업무·중심성 15). 역 경제력은 거주민 소득·소비 수준 추정 등급(5단계)이며 아파트 시세·업무·상권을 쓰지 않습니다. 환승·급행·복수역 보너스는 '새로 열리는 목적지'가 있을 때만.</li>
      <li><b>직주근접</b> — 주요 업무지 10곳까지의 체감 이동시간(대기·환승·진입 포함).</li>
      <li><b>교육</b> — 학교 접근성·학군 선호·학원가 허브 생활권·수요 지속성. 역 가치의 교육 축은 '생활권의 구조적 교육력', 이 항목은 '이 단지에서 실제 이용 가능한 정도'로 역할을 분리합니다.</li>
      <li><b>단지 경쟁력</b> — 세대수·연식·브랜드·주차·임대비중. 정비사업 가능성은 미래 옵션가치에서 별도 평가.</li>
      <li><b>미래가치</b> — 수요 지속·공급 희소·교통 변화·교육 선호·정비 옵션 5축 → 성장률 시나리오(g)로 연결.</li>
    </ul>
    ${AV ? `<p class="subtle" style="margin-top:8px">순환·중복 방지 — 역 경제력은 거주민 경제수준 추정 등급만 쓰고 아파트 시세를 쓰지 않아 '집값→역 가치→아파트 가치' 순환이 없습니다. 평가용 블렌드에서 경제력·교육 축은 각 ${Math.round(AV.econ * 100)}%·${Math.round(AV.edu * 100)}%로 축소 반영됩니다(추정 등급의 불확실성·단지 교육점수와의 중복 방지).</p>` : ''}
    <h3 class="mini-h">④ 이 결과의 한계</h3>
    <ul style="margin:4px 0 0;padding-left:18px;font-size:12.5px;color:var(--ink2);line-height:1.8">
      <li>감정평가 가격이 아닙니다 — 공개 데이터 기반의 상대가치 모델입니다.</li>
      <li>거래량이 적거나 데이터가 부족한 단지·지역은 신뢰도가 낮을 수 있습니다 (아래 신뢰도 표시).</li>
      <li>개발계획·재건축·정책 변화 등 미래 변수는 실제 결과와 다를 수 있습니다.</li>
      <li>개별 동·층·향·내부상태는 반영되지 않습니다.</li>
    </ul>
    <div class="chips" style="margin-top:10px">
      <span class="badge ${cBadge}">데이터 신뢰도 ${conf.label} (${conf.score}/100)</span>
      <span class="badge gray">기준가 거래 ${mref ? mref.n : r.market.compCount}건</span>
      <span class="badge gray">데이터 충족률 ${(r.fillRate * 100).toFixed(0)}%</span>
    </div>
  </div>`; })()}

  <div class="card" id="cmpCard">
    <h2>다른 단지와 비교</h2>
    <p class="hint">같은 돈으로 무엇을 사는 것인지 — 상세 프로필 단지와 나란히 봅니다.</p>
    <div class="grid2">
      <div><label class="mini">비교 단지<select id="cmpSel"><option value="">선택하세요</option>${DATA.complexes.filter(c => c.id !== cx.id).map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></label></div>
      <div><label class="mini">평형<select id="cmpArea" disabled></select></label></div>
    </div>
    <div id="cmpOut"></div>
  </div>

  <div class="warnbox"><b>이 결과를 읽는 법</b> — 본 진단은 미래 집값 예측이 아니라, 현재 가격이 어떤 요인으로 설명되며 어떤 조건이 무너지면 취약해지는지 이해를 돕는 도구입니다. 가격은 항상 범위와 판정으로 제시하며, 개별 동·층·향·내부상태는 반영되지 않습니다. 투자 권유가 아닙니다.</div>

  ${DEBUG_MODE ? `<div class="card"><h2>🛠 Calculation Trace (debug)</h2>
    <p class="hint">?debug=true — 개발자용 전체 계산 경로. 일반 결과 화면에는 노출되지 않습니다.</p>
    <div class="tblwrap"><table><tbody>${r.trace.map(([k, v]) => `<tr><td style="white-space:nowrap">${esc(k)}</td><td style="text-align:left;white-space:normal">${esc(String(v))}</td></tr>`).join('')}</tbody></table></div>
  </div>` : ''}`;

  $('report').querySelectorAll('.t3[data-acc]').forEach(b => b.onclick = () => {
    const acc = $(b.dataset.acc); if (!acc) return;
    acc.open = true; acc.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  const omr = $('openMapFromResult');
  if (omr && r.transit) omr.onclick = () => openMap(r.transit.primary.st);

  $('stressBtns').querySelectorAll('.sbtn').forEach(b => b.onclick = () => {
    const id = b.dataset.sid;
    const preset = CFG.stress.presets.find(p => p.id === id);
    if (state.stress.has(id)) state.stress.delete(id);
    else {
      (preset.excludes || []).forEach(x => state.stress.delete(x));
      state.stress.add(id);
    }
    $('stressBtns').querySelectorAll('.sbtn').forEach(x => x.setAttribute('aria-pressed', state.stress.has(x.dataset.sid) ? 'true' : 'false'));
    renderStress();
  });
  $('stressReset').onclick = () => {
    state.stress.clear();
    $('stressBtns').querySelectorAll('.sbtn').forEach(x => x.setAttribute('aria-pressed', 'false'));
    renderStress();
  };

  $('cmpSel').onchange = () => {
    const c2 = DATA.complexes.find(c => c.id === $('cmpSel').value);
    const sel = $('cmpArea');
    if (!c2) { sel.innerHTML = ''; sel.disabled = true; $('cmpOut').innerHTML = ''; return; }
    sel.innerHTML = c2.areas.map(a => `<option value="${a.key}">${esc(a.label)}</option>`).join('');
    sel.disabled = false; renderCompare();
  };
  $('cmpArea').onchange = renderCompare;
}

/* ── 스트레스 렌더 ── */
function renderStress() {
  const out = $('stressOut');
  if (!state.stress.size) { out.innerHTML = ''; return; }
  const ids = Array.from(state.stress);
  let sr;
  try { sr = AptEngine.applyStress(state.baseInput, ids, CFG, HUBS, JOBS, STN); }
  catch (e) { out.innerHTML = `<div class="warnbox">${esc(e.message)}</div>`; return; }
  const b = state.result;
  const dArrow = (a, c) => {
    const d = c - a;
    if (Math.abs(d) < 0.05) return '<span style="color:var(--muted)">변화 없음</span>';
    const up = d > 0;
    return `<span class="${up ? 'd-up' : 'd-down'}">${up ? '▲' : '▼'} ${Math.abs(d) < 1 ? Math.abs(d).toFixed(1) : Math.round(Math.abs(d))}</span>`;
  };
  const labels = ids.map(id => CFG.stress.presets.find(p => p.id === id).label).join(' + ');
  out.innerHTML = `
    <div class="notebox" style="margin-top:14px"><b>시나리오: ${esc(labels)}</b></div>
    <div class="tblwrap"><table class="deltatbl">
      <thead><tr><th>지표</th><th>기본</th><th>시나리오</th><th>변화</th></tr></thead><tbody>
      <tr><td>금융 지지가치</td><td>${b.financial ? `${fmtEok(b.financial.fsv.low)}~${fmtEok(b.financial.fsv.high)}` : '보류'}</td><td class="strong">${sr.financial ? `${fmtEok(sr.financial.fsv.low)}~${fmtEok(sr.financial.fsv.high)}` : '보류'}</td><td class="delta">${b.financial && sr.financial ? dArrow(b.financial.fsv.base, sr.financial.fsv.base) + '억' : ''}</td></tr>
      <tr><td>금융 지지력</td><td>${b.verdicts.financial.held ? b.verdicts.financial.label : `${b.verdicts.financial.label} ${Math.round(b.verdicts.financial.ratio * 100)}%`}</td><td class="strong">${sr.verdicts.financial.held ? sr.verdicts.financial.label : `${sr.verdicts.financial.label} ${Math.round(sr.verdicts.financial.ratio * 100)}%`}</td><td></td></tr>
      <tr><td>미래 기대 반영도</td><td>${b.verdicts.expectation.label}</td><td class="strong">${sr.verdicts.expectation.label}</td><td></td></tr>
      <tr><td>필요 성장률(역산)</td><td>${b.financial ? fmtPct(b.financial.impliedG) : '—'}</td><td class="strong">${sr.financial ? fmtPct(sr.financial.impliedG) : '—'}</td><td></td></tr>
      <tr><td>전세지지력</td><td>${b.support ? b.support.label : '보류'}</td><td class="strong">${sr.support ? sr.support.label : '보류'}</td><td></td></tr>
      <tr><td>투자가치</td><td>${Math.round(b.scores.invest.total)}</td><td class="strong">${Math.round(sr.scores.invest.total)}</td><td class="delta">${dArrow(b.scores.invest.total, sr.scores.invest.total)}</td></tr>
      <tr><td>미래가치 점수</td><td>${b.future.score}</td><td class="strong">${sr.future.score}</td><td class="delta">${dArrow(b.future.score, sr.future.score)}</td></tr>
      </tbody></table></div>
    <p class="subtle">시나리오는 해당 변수만 바꾼 조건부 재계산입니다. 실제 시장에서는 변수들이 함께 움직일 수 있습니다.</p>`;
}

/* ── 비교 렌더 ── */
function renderCompare() {
  const c2 = DATA.complexes.find(c => c.id === $('cmpSel').value);
  if (!c2) return;
  const areaKey = $('cmpArea').value || c2.areas[0].key;
  let r2;
  try { r2 = AptEngine.analyze({ complex: c2, areaKey, asOfYM: DATA.meta.asOf, overrides: {} }, CFG, HUBS, JOBS, STN); }
  catch (e) { $('cmpOut').innerHTML = `<div class="warnbox">${esc(e.message)}</div>`; return; }
  const a = state.result, b = r2;
  const row = (k, va, vb, strong) => `<tr><td>${k}</td><td${strong ? ' class="strong"' : ''}>${va}</td><td${strong ? ' class="strong"' : ''}>${vb}</td></tr>`;
  const diff = b.currentPrice - a.currentPrice;
  let sentence;
  const dl = Math.round(b.scores.living.total - a.scores.living.total);
  const di = Math.round(b.scores.invest.total - a.scores.invest.total);
  const nm = x => `<b>${esc(x.cx.name)}</b>`;
  if (Math.abs(diff) < 0.05) sentence = `두 단지의 현재 가격이 비슷합니다. 주거가치 ${dl >= 0 ? '+' : ''}${dl} · 투자가치 ${di >= 0 ? '+' : ''}${di} 차이로 판단해 보세요.`;
  else {
    const hi = diff > 0 ? b : a, lo2 = diff > 0 ? a : b;
    const hl = Math.round(hi.scores.living.total - lo2.scores.living.total);
    const hv = Math.round(hi.scores.invest.total - lo2.scores.invest.total);
    sentence = `${fmtEok(Math.abs(diff))}을 더 주고 ${nm(hi)}를 선택한다면 — 주거가치 ${hl >= 0 ? '+' : ''}${hl}점, 투자가치 ${hv >= 0 ? '+' : ''}${hv}점의 차이에 값을 지불하는 셈입니다. `;
    const optEdge = hi.option.gradeIdx <= 1 && lo2.option.gradeIdx >= 2;
    if (optEdge) sentence += `점수 차이보다도, 정비사업 기대(미래 옵션 ${hi.option.gradeLabel})가 이 프리미엄의 큰 부분을 설명합니다 — 사업 지연 시나리오의 변동성도 함께 고려하세요.`;
    else if (hl <= 0 && hv <= 0) sentence += '지표상으로는 추가 지불의 근거가 뚜렷하지 않습니다 — 개별 요인(동·층·향, 실물 상태)을 확인하세요.';
    else if (hi.scores.attract.score < lo2.scores.attract.score - 8) sentence += `다만 가격매력도는 ${nm(lo2)} 쪽이 높아, 프리미엄의 상당 부분이 이미 가격에 반영되어 있습니다.`;
    else if (hl + hv <= 8) sentence += '지표상 점수 차이는 크지 않습니다 — 희소성·상징성 등 지표 밖 프리미엄에 값을 지불하는 것인지 확인해 보세요.';
    else sentence += '점수 차이가 가격 차이를 상당 부분 뒷받침합니다.';
  }
  $('cmpOut').innerHTML = `
    <div class="tblwrap"><table>
      <thead><tr><th></th><th>${esc(a.cx.name)} ${esc(a.area.key)}㎡</th><th>${esc(b.cx.name)} ${esc(b.area.key)}㎡</th></tr></thead><tbody>
      ${row('현재 가격', fmtEokW(a.currentPrice), fmtEokW(b.currentPrice), true)}
      ${row('시장 기준가', a.marketRef ? `${fmtEok(a.marketRef.low)}~${fmtEok(a.marketRef.high)}` : '—', b.marketRef ? `${fmtEok(b.marketRef.low)}~${fmtEok(b.marketRef.high)}` : '—')}
      ${row('금융 지지가치', a.financial ? `${fmtEok(a.financial.fsv.low)}~${fmtEok(a.financial.fsv.high)}` : '보류', b.financial ? `${fmtEok(b.financial.fsv.low)}~${fmtEok(b.financial.fsv.high)}` : '보류')}
      ${row('판정', `${a.verdicts.market.label}·${a.verdicts.financial.label}·기대 ${a.verdicts.expectation.label}`, `${b.verdicts.market.label}·${b.verdicts.financial.label}·기대 ${b.verdicts.expectation.label}`)}
      ${row('장기 경쟁력', `${a.structural.score} (${a.structural.band})`, `${b.structural.score} (${b.structural.band})`)}
      ${row('주거가치', Math.round(a.scores.living.total), Math.round(b.scores.living.total))}
      ${row('투자가치', Math.round(a.scores.invest.total), Math.round(b.scores.invest.total))}
      ${row('미래가치', a.future.score, b.future.score)}
      ${row('전세지지력', a.support ? a.support.label : '보류', b.support ? b.support.label : '보류')}
      ${row('수급', a.supplyE.gradeLabel, b.supplyE.gradeLabel)}
      ${row('미래 옵션', a.option.gradeLabel, b.option.gradeLabel)}
      ${row('신뢰도', a.confidence.label, b.confidence.label)}
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
/* 원 크기: 점수 구간이 즉시 구분되도록 비선형 곡선 (하위 ~5px → 최상위 22px 상한) */
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

/* 지도·TOP10 카테고리: 종합 + 4축 — 선택하면 원 크기·순위·상세가 모두 그 기준으로 바뀐다 */
const CAT = {
  sv: { short: '종합', label: '종합 역 가치', hint: '역 가치(Station Value) — 교통·네트워크 30% · 역세권 경제력 35% · 교육·주거 생활권 20% · 업무·도시 중심성 15%로 자동 계산합니다. 원의 크기 = 역 가치, 원의 색 = 노선.' },
  transit: { short: '교통', label: '교통·네트워크', hint: '교통·네트워크 — 강남·도심·여의도 체감 이동시간(대기·환승 포함), 환승 노선 수, 급행, 배차·심도. 전체 역 대비 백분위입니다. 원의 크기 = 교통 점수.' },
  econ: { short: '경제력', label: '역세권 경제력', hint: '역세권 경제력 — 그 역 생활권에 거주하는 주민들의 경제 수준(소득·소비) 추정 등급(5단계)의 백분위입니다. 아파트 시세·업무지·상권·유동인구는 반영하지 않습니다(업무는 "업무" 탭, 시세는 검증용 참고로만 표시). 원의 크기 = 경제력 점수.' },
  edu: { short: '교육·주거', label: '교육·주거 생활권', hint: '교육·주거 생활권 — 대표 학원가 접근(거리감쇠)과 아파트 단지 밀집도. 대치·목동·중계·평촌 같은 학군·주거 지역이 여기서 높습니다. 원의 크기 = 교육·주거 점수.' },
  biz: { short: '업무', label: '업무·도시 중심성', hint: '업무·도시 중심성 — 업무·상업·문화 시설과 도시 중심성. 업무가 강한 역과 종합 부동산 가치가 높은 역을 구분해 보세요. 원의 크기 = 업무 점수.' }
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
    if (diff >= 20) msg = '교통·네트워크 가치 대비 거주민 경제수준 등급이 낮습니다 — 교통 인프라에 비해 주거지 프리미엄이 아직 낮은 생활권입니다.';
    else if (diff <= -20) msg = '거주민 경제수준이 교통·네트워크 가치보다 높습니다 — 교통보다 학군·환경·선호도가 만드는 주거 프리미엄 생활권입니다.';
    else msg = '교통·네트워크 가치와 거주민 경제수준이 대체로 부합하는 생활권입니다.';
    rel = `<p class="subtle" style="margin-top:8px">${msg}</p>`;
  }
  const GRADE_LABEL = [null, '최저권', '낮은 편', '중간권', '상위권', '최상위권'];
  const srcTag = '<span class="stat est" style="margin-left:4px">5단계 추정</span>';
  const sub = s.sub || {};
  $('stnCard').hidden = false;
  $('stnCard').innerHTML = `
    <div class="stnhead"><b>${esc(name)}</b>
      <span>${s.lines.map(l => `<i style="width:9px;height:9px;border-radius:50%;background:${LINE_COLOR[l] || 'var(--muted)'};display:inline-block;margin-right:3px"></i>${esc(l)}`).join(' ')}${s.express ? ' · 급행/광역' : ''}</span></div>
    <div class="tiles3" style="grid-template-columns:1fr 1fr;margin-top:10px">
      <div class="t3" style="cursor:default"><div class="k">Station Value</div><div class="v g${gradeCls(s.sv)}">${Math.round(s.sv)}<em> /100</em></div><div class="s">수도권 ${total}개 역 중 <b>${s.rank}위</b> · 상위 ${s.rankPct}%${mapState.mode !== 'sv' ? `<br>현재 선택 <b>${CAT[mapState.mode].short}</b> 기준 <b>${catRankOf(name)}위</b>` : ''}</div></div>
      <div class="t3" style="cursor:default"><div class="k">역세권 경제력${srcTag}</div><div class="v">${s.wealth}<em> /100</em></div><div class="s">근거: 거주민 소득·소비 수준 <b>${GRADE_LABEL[s.econGrade] || '중간권'}</b> (등급 ${s.econGrade ?? 3}/5) — 시세·업무·상권 미반영${s.priceLevel != null ? `<br>참고: 주변 시세 백분위 ${s.priceLevel}${s.priceN ? ` · ${s.priceN}개 단지` : ''} (평가 미반영 · 검증용)` : ''}</div></div>
    </div>
    <h3 class="mini-h">점수 구성 — 4축 (전체 역 대비 백분위)</h3>
    ${sb('교통·네트워크 30%', s.comps.transit)}${sb('역세권 경제력 35%', s.comps.econ)}${sb('교육·주거 생활권 20%', s.comps.edu)}${sb('업무·도시 중심성 15%', s.comps.biz)}
    <p class="subtle" style="margin-top:6px">교통: 핵심지 체감접근 ${sub.core ?? '—'} · 네트워크 ${sub.net ?? '—'} · 운행편의 ${sub.fric ?? '—'} /
      교육·주거: 학원가 접근 ${sub.hubEdu ?? '—'}${s.hubName ? ` (${esc(s.hubName)})` : ''} · 단지 밀집 ${sub.density ?? '—'}</p>
    <div class="kv"><span>강남 핵심 업무지</span><span>약 ${s.gangnamMin}분 (대기·환승 포함 체감시간)</span></div>
    ${hop}${rel}
    <p class="subtle">아파트 평가에는 이 역의 교통·업무 축을 중심으로 반영하고, 경제력·교육 축은 축소 반영합니다(중복 계산 방지).</p>`;
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
  if (!strengths.length) strengths.push('구조적 강점이 뚜렷하지 않음 — 세부 축 점수를 확인하세요');
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
    <p class="hint"><b>노선 가치는 역 평균이 아닙니다.</b> 역세권 가치 30%(환승역 편승 감쇄) + 핵심 생활권 연결력 25%(추가 생활권은 한계효용 체감) + 도시 횡단·네트워크 20%(환승·관문·횡단성만 — 생활권과 중복 가산 없음) + 이동 효율 15% + 대체불가능성 10%(노선 제거 시 우회 시간 실측)로 평가하며, 점수는 계산값 그대로입니다(순위 강제 확대 없음). 점수차가 작은 노선은 같은 Tier로 묶입니다.</p>
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
  // 동률(백분위 같은 점수)은 해당 축의 세부 점수로 정렬 — 교육·주거 탭에서 학원가 핵심지가 위로
  const subKey = { transit: 'core', edu: 'hubEdu', biz: 'dest' }[m];
  const tie = n => subKey ? ((STN.stations[n].sub || {})[subKey] || 0) : 0;
  const ranked = names.sort((a, b) => metricOf(STN.stations[b]) - metricOf(STN.stations[a]) || tie(b) - tie(a) || STN.stations[a].rank - STN.stations[b].rank);
  const showN = mapState.showAll ? ranked.length : 10;
  const rows = ranked.slice(0, showN).map((n, i) => {
    const s = STN.stations[n];
    const c = s.comps || {};
    const dot = `<i style="width:8px;height:8px;border-radius:50%;background:${LINE_COLOR[repLinesOf(s)[0]] || 'var(--muted)'};display:inline-block;margin-right:4px;flex:none"></i>`;
    const lowN = m === 'econ' && s.econGrade ? ` <span class="stat est">등급 ${s.econGrade}/5</span>` : '';
    const sub = m === 'sv'
      ? `교통 ${c.transit} · 경제력 ${c.econ} · 교육주거 ${c.edu} · 업무 ${c.biz}`
      : `종합 ${Math.round(s.sv)} (전체 ${s.rank}위) · ${['transit', 'econ', 'edu', 'biz'].filter(k => k !== m).map(k => `${CAT[k].short} ${c[k]}`).join(' · ')}`;
    return `<div class="rankrow" data-st="${esc(n)}" style="cursor:pointer;flex-wrap:wrap">
      <span class="rk ${i < 3 ? 'top' : ''}">${i + 1}</span>${dot}<span class="nm">${esc(n)}${lowN}</span>
      <span class="ln">${s.lines.map(esc).join('·')}</span><span class="sc">${Math.round(metricOf(s))}</span>
      <span class="rsub">${sub}</span>
    </div>`;
  }).join('');
  const catNote = {
    sv: '4개 축(교통·네트워크 30% / 역세권 경제력 35% / 교육·주거 20% / 업무·중심성 15%)의 가중합입니다.',
    transit: '강남·도심·여의도 체감 이동시간과 환승·급행·배차 기준 — 종합 순위와 다를 수 있습니다.',
    econ: '거주민 소득·소비 수준 추정 등급(5단계) 기준 — 시세·업무·상권 미반영이라 같은 등급은 동률입니다. 정밀 소득 데이터 미확보(전 역 추정).',
    edu: '학원가 접근성과 단지 밀집도 기준 — 학군·주거 지역이 업무지역보다 높게 나올 수 있습니다.',
    biz: '업무·상업·문화 시설 기준 — "업무가 강한 역"과 "종합 부동산 가치가 높은 역"은 다릅니다.'
  }[m];
  $('rankCard').innerHTML = `
    <h2>${mapState.line ? `${esc(mapState.line)} — ${CAT[m].short} 순위` : `수도권 ${CAT[m].label} TOP 10`}</h2>
    <p class="hint">실제 계산 결과로 생성된 순위입니다 — 사전에 고정된 순위가 없습니다. ${catNote} 위 탭으로 기준을 바꾸면 지도 원 크기와 순위가 함께 바뀝니다.</p>
    ${rows}
    <button class="btn ghost" id="rankMore" style="width:100%;margin-top:10px">${mapState.showAll ? '접기 — TOP 10만 보기' : `전체 역 보기 (${ranked.length}개 · ${CAT[m].short} 점수순)`}</button>
    <p class="subtle" style="margin-top:10px">노선 가치: ${LINEI.lines.slice(0, 5).map(l => `${esc(l.name)} ${l.golden}${l.tier ? '(' + l.tier + ')' : ''}`).join(' · ')} — 역 평균이 아닌 별도 모델이며, 점수차가 작은 노선은 같은 Tier입니다 (노선 칩을 눌러 근거 확인)</p>`;
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
