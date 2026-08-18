'use strict';
/* src + config + data → app.html (평문 단일 파일)
   config/data JSON은 빌드 시점에 상수로 인라인된다 — 원본은 JSON 파일. */
const fs = require('fs');
const path = require('path');
const R = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const head = R('src/head.html');
const engine = R('src/engine.js');
const ui = R('src/ui.js');
const consts = [
  `const CFG=${JSON.stringify(JSON.parse(R('config/valuation-parameters.json')))};`,
  `const HUBS=${JSON.stringify(JSON.parse(R('config/education_hubs.json')))};`,
  `const JOBS=${JSON.stringify(JSON.parse(R('config/job_centers.json')))};`,
  `const DATA=${JSON.stringify(JSON.parse(R('data/apartments.json')))};`,
  `const REGIONS=${JSON.stringify(JSON.parse(R('pipeline/regions.json')))};`,
  `const STN=${JSON.stringify(JSON.parse(R('data/station_intelligence.json')))};`,
  `const LINEI=${JSON.stringify(JSON.parse(R('data/line_intelligence.json')))};`,
  `const DONG=${JSON.stringify(JSON.parse(R('data/dong_stations.json')))};`,
  `const RAIL_LINES=${JSON.stringify(JSON.parse(R('data/rail_network.json')).lines)};`
].join('\n');

const app = head +
  '<script>\n' + consts + '\n' + engine + '\n</script>\n' +
  '<script>\n' + ui + '\n</script>\n' +
  '</body>\n</html>\n';

fs.writeFileSync(path.join(__dirname, '..', 'app.html'), app);
console.log(`BUILD OK → app.html (${Math.round(app.length / 1024)}KB)`);
