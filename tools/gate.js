'use strict';
/* ═══════════════════════════════════════════════════════════════════
   비밀번호 게이트 빌더 — app.html(평문 앱) → index.html(잠금 화면 + 암호문)
   - 본문 전체를 AES-256-GCM으로 암호화 (키: PBKDF2-SHA256 60만 회)
   - 저장소·배포본에는 암호문만 존재 → 소스 보기로 내용·비밀번호 노출 없음
   - 비밀번호는 이 파일에도 저장되지 않는다 (인자 또는 GATE_PASSWORD 환경변수)
   사용: node tools/gate.js <입력 html> <출력 html> <비밀번호>
   ═══════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const crypto = require('crypto');

const SRC = process.argv[2] || 'app.html';
const OUT = process.argv[3] || 'index.html';
const PASSWORD = process.argv[4] || process.env.GATE_PASSWORD || '';
const ITER = 600000;

if (!PASSWORD) {
  console.error('ERROR: 비밀번호가 필요합니다 — node tools/gate.js <in> <out> <password>');
  process.exit(1);
}

const html = fs.readFileSync(SRC);
const salt = crypto.randomBytes(16);
const iv = crypto.randomBytes(12);
const key = crypto.pbkdf2Sync(PASSWORD, salt, ITER, 32, 'sha256');
const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
const enc = Buffer.concat([cipher.update(html), cipher.final(), cipher.getAuthTag()]);
const payload = Buffer.concat([salt, iv, enc]).toString('base64');

const page = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<title>닥터마빈 아파트 가치진단</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;500;700&display=swap" rel="stylesheet">
<style>
:root{--page:#faf9f7;--surface:#fff;--ink:#12100f;--ink2:#56534e;--muted:#8a867e;
--line:rgba(18,16,15,.10);--accent:#A8252C;--accent-soft:#fbf1f1}
@media(prefers-color-scheme:dark){:root{--page:#0d0d0d;--surface:#161615;--ink:#fff;--ink2:#c3c2b7;
--muted:#898781;--line:rgba(255,255,255,.10);--accent:#e66767;--accent-soft:#2a1c1c}}
*{box-sizing:border-box}
html,body{margin:0;height:100%}
body{background:var(--page);color:var(--ink);display:grid;place-items:center;
font-family:'Noto Sans KR','Apple SD Gothic Neo','Malgun Gothic',system-ui,sans-serif;padding:20px}
.lock{width:100%;max-width:380px;background:var(--surface);border:1px solid var(--line);
border-radius:16px;padding:32px 26px;text-align:center}
.badge{display:inline-block;font-size:11.5px;font-weight:700;color:var(--accent);
background:var(--accent-soft);border:1px solid var(--accent);border-radius:99px;padding:3px 11px}
h1{font-size:19px;margin:14px 0 6px;letter-spacing:-.02em}
p{font-size:13px;color:var(--ink2);margin:0 0 22px;line-height:1.6}
input{width:180px;font-family:inherit;font-size:30px;font-weight:700;letter-spacing:14px;
text-align:center;color:var(--ink);background:none;border:0;border-bottom:2.5px solid var(--line);
padding:6px 0 6px 14px;outline:none;caret-color:var(--accent)}
input:focus{border-bottom-color:var(--accent)}
.msg{min-height:20px;font-size:12.5px;color:var(--accent);margin-top:14px;font-weight:500}
.foot{margin-top:18px;font-size:11px;color:var(--muted);line-height:1.6}
.shake{animation:sh .35s}
@keyframes sh{0%,100%{transform:translateX(0)}25%{transform:translateX(-7px)}75%{transform:translateX(7px)}}
.spin{display:inline-block;width:14px;height:14px;border:2px solid var(--line);
border-top-color:var(--accent);border-radius:50%;animation:rot .7s linear infinite;vertical-align:-2px;margin-right:6px}
@keyframes rot{to{transform:rotate(360deg)}}
</style>
</head>
<body>
<div class="lock" id="lock">
  <span class="badge">비공개 · 초대 열람</span>
  <h1>닥터마빈 아파트 가치진단</h1>
  <p>전달받은 비밀번호 4자리를 입력하세요.</p>
  <input id="pw" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="off" autofocus aria-label="비밀번호 4자리">
  <div class="msg" id="msg" role="status" aria-live="polite"></div>
  <div class="foot">본 콘텐츠는 암호화되어 있으며 비밀번호 확인 후 이 기기에서만 해제됩니다.</div>
</div>
<script>
const PAYLOAD='${payload}';
const ITER=${ITER};
function b64(s){
  const bin=atob(s), n=bin.length, out=new Uint8Array(n);
  for(let i=0;i<n;i++) out[i]=bin.charCodeAt(i);
  return out;
}
async function tryUnlock(pw,silent){
  const msg=document.getElementById('msg');
  if(!silent)msg.innerHTML='<span class="spin"></span>확인 중…';
  try{
    const raw=b64(PAYLOAD);
    const salt=raw.slice(0,16),iv=raw.slice(16,28),data=raw.slice(28);
    const km=await crypto.subtle.importKey('raw',new TextEncoder().encode(pw),'PBKDF2',false,['deriveKey']);
    const key=await crypto.subtle.deriveKey({name:'PBKDF2',salt,iterations:ITER,hash:'SHA-256'},km,{name:'AES-GCM',length:256},false,['decrypt']);
    const dec=await crypto.subtle.decrypt({name:'AES-GCM',iv},key,data);
    try{sessionStorage.setItem('aptdx_gate',pw)}catch(e){}
    const html=new TextDecoder().decode(dec);
    document.open();document.write(html);document.close();
    return true;
  }catch(e){
    try{sessionStorage.removeItem('aptdx_gate')}catch(e2){}
    if(!silent){
      msg.textContent='비밀번호가 올바르지 않습니다.';
      const box=document.getElementById('lock');
      box.classList.remove('shake');void box.offsetWidth;box.classList.add('shake');
      const inp=document.getElementById('pw');inp.value='';inp.focus();
    }
    return false;
  }
}
const inp=document.getElementById('pw');
inp.addEventListener('input',()=>{
  inp.value=inp.value.replace(/\\D/g,'');
  if(inp.value.length===4)tryUnlock(inp.value,false);
});
inp.addEventListener('keydown',e=>{if(e.key==='Enter'&&inp.value.length===4)tryUnlock(inp.value,false)});
(function(){
  let saved=null;
  try{saved=sessionStorage.getItem('aptdx_gate')}catch(e){}
  if(saved)tryUnlock(saved,true);
})();
</script>
</body>
</html>
`;

fs.writeFileSync(OUT, page);

/* 자가 검증 — 같은 파라미터로 복호화해 원본과 바이트 일치 확인 */
const raw = Buffer.from(payload, 'base64');
const s2 = raw.slice(0, 16), i2 = raw.slice(16, 28), body = raw.slice(28);
const k2 = crypto.pbkdf2Sync(PASSWORD, s2, ITER, 32, 'sha256');
const d = crypto.createDecipheriv('aes-256-gcm', k2, i2);
d.setAuthTag(body.slice(body.length - 16));
const plain = Buffer.concat([d.update(body.slice(0, body.length - 16)), d.final()]);
if (!plain.equals(html)) { console.error('DECRYPT-CHECK FAIL'); process.exit(1); }
console.log(`GATE OK → ${OUT} (${Math.round(page.length / 1024)}KB, 원본 ${Math.round(html.length / 1024)}KB) · DECRYPT-CHECK PASS`);
