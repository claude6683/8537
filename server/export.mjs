/* GitHub Actions 에서 5분마다 실행: 시세·브리핑을 계산해 data/<함수>/<인자>.json 으로 저장.
   페이지(shim.js)는 이 정적 파일만 읽는다. 키·토큰은 쓰지 않는다. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { FN, jobs } from './api.mjs';

const FORCE = process.env.FORCE || '';
const TX = ['QQQM', 'NVDA', 'TQQQ'];
const QSYM = ['QQQ', 'QLD', 'TQQQ', 'SGOV'];
const log = (m) => console.log(m);

async function readJson(f, d) { try { return JSON.parse(await fs.readFile(f, 'utf8')); } catch (e) { return d; } }
const meta = await readJson('store/meta.json', {});
const now = Date.now();
const age = (k) => (now - (meta[k] || 0)) / 60000;

async function put(fn, args, val) {
  if (val === null || val === undefined) return;
  const k = args.map((a) => (a == null ? '' : String(a))).join('_') || 'x';
  const f = path.join('data', fn, k + '.json');
  await fs.mkdir(path.dirname(f), { recursive: true });
  await fs.writeFile(f, JSON.stringify(val));
}
async function run(label, fn) { try { await fn(); log('ok   ' + label); } catch (e) { log('FAIL ' + label + ': ' + ((e && e.message) || e)); } }
const call = (fn, args) => run(fn + '(' + args.join(',') + ')', async () => put(fn, args, await FN[fn].apply(null, args)));

// 1) 5분마다: 공포탐욕 기록, 현재가, 분봉
await run('fagRecord', async () => log(await jobs.fagRecord()));
await call('tx_quotes', []);
for (const t of ['1m', '5m', '15m']) await call('fag_getLive', [t]);
for (const t of ['1m', '5m', '15m', '1h']) await call('fag_getQ', [t]);
for (const id of TX) await call('tx_candles', [id, '15m']);

// 2) 1시간마다: 일·주봉, VIX, 시그널 차트
if (FORCE || age('mid') >= 55) {
  await call('fag_getData', []);
  for (const t of ['1d', '1w']) await call('fag_getQ', [t]);
  for (const id of TX) for (const t of ['1h', '1d', '1w']) await call('tx_candles', [id, t]);
  await call('gongdu_vix', []);
  for (const s of QSYM) for (const t of ['1m', '5m', '15m', '1h', '1d', '1w']) await call('sim_getQ', [s, t]);
  meta.mid = now;
}

// 3) 3시간마다: Tripod 시뮬, 공두일보
if (FORCE || age('slow') >= 175) {
  await run('simRefresh', async () => log(await jobs.simRefresh()));
  await call('sim_get', ['T']);
  await call('sim_marks', []);
  const ymd = new Date(now).toISOString().slice(0, 10), h = new Date(now).getUTCHours();
  if (FORCE === 'build' || (h >= 22 && meta.build !== ymd)) { await run('gongduBuild', async () => { await jobs.gongduBuild(); meta.build = ymd; }); }
  else await run('gongduExtras', async () => { await jobs.gongduExtras(); });
  await run('gongdu_getData', async () => {
    const d = await FN.gongdu_getData('');
    await put('gongdu_getData', [''], d);
    for (const dt of d.dates || []) await put('gongdu_getData', [dt], await FN.gongdu_getData(dt));
  });
  meta.slow = now;
}

await fs.mkdir('store', { recursive: true });
await fs.writeFile('store/meta.json', JSON.stringify(meta));
