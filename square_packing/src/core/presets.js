// 预设图（都是 PTP 图：内面三角形 + 外边界 4-圈 + 无分离三角形）。
//
// 主family：n 边形双锥删掉赤道上一个点（把「洞」留在外面，外边界正好成 4-圈）：
//   顶点 = {N, S, e_1, …, e_{n−1}}，外边界 = (N, e_1, S, e_{n−1})，
//   内部 e_2…e_{n−2} 每个度都是 4。
//   n = 4 就是 W₅（4-圈 + 中心点）。
// 随机图：从 W₅ 出发随机在内部边上插度 4 的点（细分保持 PTP），
//   再随机做若干「删一个度 4 内点 + 换个位置插回去」的洗牌。

import { comb, checkPTP } from './ptp.js';

/** 确定性 RNG（方便复现）。*/
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** n 边形双锥删一个赤道点，n ≥ 4。返回 {nv, faces}。*/
export function bipyramidPTP(n) {
  if (n < 4) throw new Error('bipyramidPTP: 需要 n ≥ 4');
  const N = 0, S = 1;
  const E = (i) => 1 + i;             // e_i，i = 1..n−1
  const faces = [];
  for (let i = 1; i <= n - 2; i++) faces.push([N, E(i), E(i + 1)]);
  for (let i = 1; i <= n - 2; i++) faces.push([S, E(i + 1), E(i)]);
  return { nv: n + 1, faces };
}

/** 内部边（两侧都有面的边）。*/
function interiorEdges(faces, nv) {
  const cnt = new Map();
  for (const t of faces) for (let i = 0; i < 3; i++) {
    const a = t[i], b = t[(i + 1) % 3];
    const k = a < b ? a * nv + b : b * nv + a;
    cnt.set(k, (cnt.get(k) || 0) + 1);
  }
  const out = [];
  for (const [k, c] of cnt) if (c === 2) out.push([Math.floor(k / nv), k % nv]);
  return out;
}

function faceWithDirectedEdge(faces, a, b) {
  for (let f = 0; f < faces.length; f++) {
    const t = faces[f];
    for (let i = 0; i < 3; i++) if (t[i] === a && t[(i + 1) % 3] === b) return f;
  }
  return -1;
}

/** 在内部边 (a,b) 上插入新点 w（度 4），保持定向一致。*/
function insertOnEdge(faces, nv, a, b, wIdx, grow = true) {
  const f1 = faceWithDirectedEdge(faces, a, b);
  const f2 = faceWithDirectedEdge(faces, b, a);
  if (f1 < 0 || f2 < 0) throw new Error('insertOnEdge: 不是内部边');
  const third = (f, x, y) => faces[f].find((v) => v !== x && v !== y);
  const c = third(f1, a, b), d = third(f2, a, b);
  const nf = faces.slice();
  nf[f1] = [a, wIdx, c]; nf.push([wIdx, b, c]);
  nf[f2] = [b, wIdx, d]; nf.push([wIdx, a, d]);
  return { nv: grow ? nv + 1 : nv, faces: nf };
}

/** 面表的定向是否自洽（每条有向边只出现一次）。*/
function orientationOK(faces) {
  const seen = new Set();
  for (const t of faces) {
    for (let i = 0; i < 3; i++) {
      const k = `${t[i]},${t[(i + 1) % 3]}`;
      if (seen.has(k)) return false;
      seen.add(k);
    }
  }
  return true;
}

/** 邻接表。*/
function adjOf(faces, nv) {
  const nb = Array.from({ length: nv }, () => new Set());
  for (const t of faces) for (let i = 0; i < 3; i++) {
    const a = t[i], b = t[(i + 1) % 3];
    nb[a].add(b); nb[b].add(a);
  }
  return nb;
}

/** 删掉度 4 内点 w（把它的 4 个邻居四边形换个对角线三角化）。失败返回 null。*/
function deleteDegree4(faces, nv, w) {
  const nb = adjOf(faces, nv);
  const ring = [...nb[w]];
  if (ring.length !== 4) return null;
  // 邻居在环里是不是一个 4-圈（每个在集合内恰好 2 个邻居）
  for (const v of ring) {
    let cnt = 0;
    for (const u of nb[v]) if (ring.includes(u)) cnt++;
    if (cnt !== 2) return null;
  }
  // 走一圈拿到顺序 a,b,c,d
  const order = [ring[0]];
  let prev = null, cur = ring[0];
  for (let i = 0; i < 3; i++) {
    const nxt = [...nb[cur]].find((u) => ring.includes(u) && u !== prev && !order.includes(u))
      ?? [...nb[cur]].find((u) => ring.includes(u) && u !== prev);
    if (nxt === undefined) return null;
    order.push(nxt); prev = cur; cur = nxt;
  }
  const [a, b, c, d] = order;
  const hasEdge = (x, y) => nb[x].has(y);
  let tri = null;
  if (!hasEdge(a, c)) tri = [[a, b, c], [a, c, d]];
  else if (!hasEdge(b, d)) tri = [[a, b, d], [b, c, d]];
  else return null;
  const kept = faces.filter((t) => !t.includes(w));
  if (kept.length !== faces.length - 4) return null;
  // 环的走法可能和面的定向相反，两种都试一次
  const flip = tri.map((t) => [t[2], t[1], t[0]]);
  if (orientationOK(kept.concat(tri))) return { nv, faces: kept.concat(tri) };
  if (orientationOK(kept.concat(flip))) return { nv, faces: kept.concat(flip) };
  return null;
}

/** 随机 PTP 图：从 W₅ 插点到 targetV，再做几次洗牌。*/
export function randomPTP(targetV = 12, seed = 1) {
  const rng = mulberry32(seed);
  let { nv, faces } = bipyramidPTP(4);
  while (nv < targetV) {
    const ie = interiorEdges(faces, nv);
    const [a, b] = ie[Math.floor(rng() * ie.length)];
    ({ nv, faces } = insertOnEdge(faces, nv, a, b, nv));
  }
  // 洗牌：删一个度 4 内点，再在别的边上插回去（复用编号，nv 不变）
  for (let k = 0; k < 8; k++) {
    const nb = adjOf(faces, nv);
    const cand = [];
    for (let v = 0; v < nv; v++) if (nb[v].size === 4 && !isBoundary(faces, nv, v)) cand.push(v);
    if (!cand.length) break;
    const w = cand[Math.floor(rng() * cand.length)];
    const del = deleteDegree4(faces, nv, w);
    if (!del) continue;
    if (!checkPTP(comb(del.faces, nv)).ok) continue;
    const ie = interiorEdges(del.faces, nv);
    const [a, b] = ie[Math.floor(rng() * ie.length)];
    if (a === w || b === w) continue;   // 别马上插回同一条边附近
    const ins = insertOnEdge(del.faces, nv, a, b, w, false); // 复用编号，nv 不变
    if (!checkPTP(comb(ins.faces, nv)).ok) continue;
    faces = ins.faces;
  }
  const info = checkPTP(comb(faces, nv));
  if (!info.ok) throw new Error(`randomPTP(seed=${seed}): ${info.reasons.join('; ')}`);
  return { nv, faces };
}

function isBoundary(faces, nv, v) {
  const cnt = new Map();
  for (const t of faces) for (let i = 0; i < 3; i++) {
    const a = t[i], b = t[(i + 1) % 3];
    const k = a < b ? a * nv + b : b * nv + a;
    cnt.set(k, (cnt.get(k) || 0) + 1);
  }
  for (const [k, c] of cnt) {
    if (c === 1 && (Math.floor(k / nv) === v || k % nv === v)) return true;
  }
  return false;
}

/** 所有预设。每个 = {id, name, nv, faces, note}。*/
export const PRESETS = (() => {
  const list = [
    { id: 'w5', name: 'W₅（4-圈 + 中心）', ...bipyramidPTP(4), note: '双锥族 n=4；唯一一个内点' },
    { id: 'bi5', name: '双锥 n=5', ...bipyramidPTP(5), note: '内点 2 个' },
    { id: 'bi6', name: '双锥 n=6', ...bipyramidPTP(6), note: '内点 3 个' },
    { id: 'bi7', name: '双锥 n=7', ...bipyramidPTP(7), note: '内点 4 个' },
    { id: 'bi8', name: '双锥 n=8', ...bipyramidPTP(8), note: '内点 5 个' },
  ];
  for (const [seed, tv] of [[1, 10], [2, 14], [3, 18]]) {
    list.push({
      id: `rnd${seed}`, name: `随机 PTP #${seed}`,
      ...randomPTP(tv, seed), note: `${tv} 个顶点`,
    });
  }
  return list;
})();

export { mulberry32 };
