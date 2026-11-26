/* Netlify Blobs 대신 파일로 저장하는 간단한 저장소. name='cache' 는 실행 중에만 쓰는 임시, 그 외는 store/<name>/ 에 영구 저장(깃에 커밋) */
import fs from 'node:fs/promises';
import path from 'node:path';

const safe = (k) => { if (String(k).split('/').some((x) => x === '..' || x === '')) throw new Error('bad key'); return String(k); };

export function getStore(o) {
  const name = (o && o.name) || 'data';
  const base = name === 'cache' ? '.cache' : path.join('store', name);
  const file = (k) => path.join(base, safe(k) + '.json');
  async function walk(dir, pre, out) {
    let ents = []; try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      if (e.isDirectory()) await walk(path.join(dir, e.name), pre + e.name + '/', out);
      else if (e.name.endsWith('.json')) out.push(pre + e.name.slice(0, -5));
    }
  }
  return {
    async get(k) { try { return JSON.parse(await fs.readFile(file(k), 'utf8')); } catch (e) { return null; } },
    async setJSON(k, v) { const f = file(k); await fs.mkdir(path.dirname(f), { recursive: true }); await fs.writeFile(f, JSON.stringify(v)); },
    async set(k, v) { return this.setJSON(k, typeof v === 'string' ? JSON.parse(v) : v); },
    async list(q) {
      const keys = []; await walk(base, '', keys);
      const p = (q && q.prefix) || '';
      return { blobs: keys.filter((x) => x.startsWith(p)).map((key) => ({ key })) };
    }
  };
}
