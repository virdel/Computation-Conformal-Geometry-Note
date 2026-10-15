// 圆盘三角剖分的通用件 —— 「一张图 + 一个邻接表」就能做的事。
//
// 这些函数原先长在 mapgraph.js 里（只给两张手写地图用），现在抽出来，
// 地图和「用户从文件导入的图」共用同一份：两条路径的差别只在数据来源，
// 之后的嵌入 / 三角化 / 自检必须逐字一致，否则「地图能跑、导入的同构图不能跑」
// 就会变成两个各自维护的 bug 源。
//
// 这里没有一个函数需要坐标以外的几何知识：
//   rotFromCoords  —— 由坐标算逆时针绕序
//   walkFaces      —— 由绕序走面（内面逆时针、外面顺时针）
//   embedOnBoundary—— 把声明的外边界钉在凸位置上，内点解调和方程
//   triangulateFaces —— 三角形不动；≥ 4 边形的团面加对角线（Four Corners 型）
//   checkDisk      —— comb + checkPTP + 欧拉数，异常接住变理由
//   orientFaces    —— 只有「顶点集合」时把朝向传播一致（相邻面反着走公共边）

import { solveHarmonicAdj } from './embed.js';
import { polygonArea } from './mesh.js';
import { checkPTP, comb } from './ptp.js';

const TAU = Math.PI * 2;

/** 默认的三种边界形状（圆 / 圆 + 3 次谐波 / 圆 + 7 次谐波）。*/
export const DEFAULT_SHAPES = [
  (i, m) => [Math.cos(TAU * i / m), Math.sin(TAU * i / m)],
  (i, m) => { const t = TAU * i / m; const r = 1 + 0.2 * Math.cos(3 * t); return [r * Math.cos(t), r * Math.sin(t)]; },
  (i, m) => { const t = TAU * i / m; const r = 1 + 0.1 * Math.sin(7 * t); return [r * Math.cos(t), r * Math.sin(t)]; },
];

const defLabel = (v) => String(v);

/** 由坐标 + 邻接算逆时针绕序（和 mesh.js 的 rot 同一条规则：atan2 升序）。*/
export function rotFromCoords(pos, nb) {
  return nb.map((set, v) => {
    const p = pos[v];
    return [...set].sort((a, b) => Math.atan2(pos[a][1] - p[1], pos[a][0] - p[0])
      - Math.atan2(pos[b][1] - p[1], pos[b][0] - p[0]));
  });
}

/**
 * 面游走：next(v→w) = w →（w 的逆时针绕序里 v 的前一个）。
 * 这样每个面的内部在行进方向的左侧：内面逆时针（正面积）、外面顺时针（负面积）。
 */
export function walkFaces(nv, rot) {
  const rank = rot.map((list) => new Map(list.map((w, i) => [w, i])));
  const seen = new Set();
  const faces = [];
  for (let v = 0; v < nv; v++) {
    for (const w0 of rot[v]) {
      if (seen.has(v * nv + w0)) continue;
      const cyc = [];
      let a = v, b = w0;
      for (;;) {
        seen.add(a * nv + b);
        cyc.push(a);
        const list = rot[b];
        const i = rank[b].get(a);
        if (i === undefined) throw new Error(`walkFaces: ${a}-${b} 不是边`);
        const c = list[(i - 1 + list.length) % list.length];
        a = b; b = c;
        if (a === v && b === w0) break;
        if (cyc.length > 4 * nv) throw new Error('walkFaces: 走不出圈');
      }
      faces.push(cyc);
    }
  }
  return faces;
}

/** 圈 c 与圈 d 是否同一个（允许整体旋转）。*/
export function sameCycle(a, b) {
  if (a.length !== b.length) return false;
  const k = b.indexOf(a[0]);
  if (k < 0) return false;
  return a.every((v, i) => v === b[(k + i) % b.length]);
}

/**
 * 嵌入：把声明的外边界按顺序钉在凸位置（圆上），内点解调和方程。
 * 2-连通平面图 + 指定外面 ⟹ Tutte 定理：无翻转、无交叉。
 *
 * 试几种边界形状，留下最好的一次（面积 ≤ 0 的内面最少）——
 * 边界点太少时（比如 4 个点）某种形状可能正好退化。
 *
 * @param {number} nv
 * @param {Set<number>[]} nb
 * @param {number[]} boundary 外边界，逆时针
 * @param {{label?:Function, shapes?:Function[], what?:string}} opts
 * @returns {{pos, rot, faces, areas, outerIdx, attempt, badFaces, problems:string[]}}
 */
export function embedOnBoundary(nv, nb, boundary, opts = {}) {
  const label = opts.label || defLabel;
  const shapes = opts.shapes || DEFAULT_SHAPES;
  const what = opts.what || '图';
  const problems = [];
  const k = boundary.length;

  let pos = null, rot = null, faces = null, areas = null, outerIdx = -1, attempt = -1, badFaces = -1;
  for (let s = 0; s < shapes.length; s++) {
    const start = new Array(nv).fill(null);
    boundary.forEach((v, i) => { start[v] = shapes[s](i, k); });
    const p = solveHarmonicAdj(nv, nb, start, () => 1);
    const r = rotFromCoords(p, nb);
    const f = walkFaces(nv, r);
    const ar = f.map((cyc) => polygonArea(cyc, p));
    const oi = ar.findIndex((x) => x < 0);
    const negs = ar.filter((x) => x < 0).length;
    const bad = (oi < 0 || negs !== 1) ? Infinity : ar.filter((x, i) => i !== oi && !(x > 0)).length;
    if (badFaces < 0 || bad < badFaces) {          // 留下最好的一次
      pos = p; rot = r; faces = f; areas = ar; outerIdx = oi; attempt = s; badFaces = bad;
    }
    if (bad === 0) break;
  }
  if (!faces) throw new Error(`embedOnBoundary(${what}): 没法嵌入`);
  if (!(badFaces === 0)) {
    problems.push(`调和嵌入不干净：${Number.isFinite(badFaces) ? `${badFaces} 个面面积 ≤ 0` : '找不到唯一的外面'}`
      + `（试了 ${shapes.length} 种边界形状）—— 图或外边界圈有问题`);
  }

  // 外面必须正好是声明的外边界（反着走：外面是顺时针的）
  if (outerIdx >= 0) {
    const outer = faces[outerIdx].slice().reverse();
    if (!sameCycle(outer, boundary)) {
      problems.push(`外面走一圈得到 [${outer.map(label).join(', ')}]，和声明的 boundary [${boundary.map(label).join(', ')}] 不一致`
        + ' —— 要么 boundary 的走向写反了，要么圈上的次序不对');
    }
  }
  for (const cyc of faces) {
    if (new Set(cyc).size !== cyc.length) {
      problems.push(`面 [${cyc.map(label).join('-')}] 里有重复顶点（外面重复 = 边界经过割点）`);
    }
  }
  return { pos, rot, faces, areas, outerIdx, attempt, badFaces, problems };
}

/**
 * 三角化每个面：三角形不动；≥ 4 边形若顶点两两相邻（团）就加对角线
 * （Four Corners 那种「只交于一点」的情形）；否则**不猜**，只报告，
 * 让人去数据里补人工边或人工块（这条不能自动修 —— 地图那边就是这个立场）。
 *
 * @param {number} nv
 * @param {Set<number>[]} nb
 * @param {number[][]} faces 面圈（内面逆时针、外面顺时针）
 * @param {number} outerIdx 外面的下标（跳过它）
 * @param {{label?:Function, edgeKind?:Map, edgeWhy?:Map, nonCliqueHint?:string}} opts
 * @returns {{tri, repairs, faceLines, problems, nonClique}}
 */
export function triangulateFaces(nv, nb, faces, outerIdx, opts = {}) {
  const label = opts.label || defLabel;
  const { edgeKind = null, edgeWhy = null } = opts;
  const ekey = (a, b) => (a < b ? a * nv + b : b * nv + a);
  const tri = [], repairs = [], faceLines = [], problems = [], nonClique = [];

  for (let f = 0; f < faces.length; f++) {
    if (f === outerIdx) continue;
    const cyc = faces[f];
    if (cyc.length < 3) { problems.push(`面 [${cyc.map(label).join('-')}] 只有 ${cyc.length} 条边`); continue; }
    if (cyc.length === 3) { tri.push(cyc.slice()); faceLines.push({ cyc, note: '' }); continue; }
    const clique = cyc.every((a, i) => cyc.every((b, j) => i === j || nb[a].has(b)));
    if (!clique) {
      problems.push(`面 [${cyc.map(label).join(' / ')}] 是 ${cyc.length} 边形，顶点不两两相邻 —— `
        + (opts.nonCliqueHint || '数据里要给这个面补人工边或人工块'));
      nonClique.push(cyc.slice());
      continue;
    }
    for (let i = 1; i + 1 < cyc.length; i++) tri.push([cyc[0], cyc[i], cyc[i + 1]]);
    const diag = cyc.slice(2, cyc.length - 1);
    if (edgeKind) {
      for (const v of diag) {
        const key = ekey(cyc[0], v);
        if (!edgeKind.has(key)) { edgeKind.set(key, 'point'); edgeWhy.set(key, '只交于一点'); }
      }
    }
    repairs.push({
      kind: 'point', face: cyc.map(label),
      why: `${cyc.length} 个区域只交于一点（Four Corners 型），加对角线 ${label(cyc[0])}–${diag.map(label).join('、')}`,
    });
    faceLines.push({ cyc, note: `→ 加对角线 ${diag.map(label).join('、')}（只交于一点）` });
  }
  return { tri, repairs, faceLines, problems, nonClique };
}

/**
 * 圆盘自检：comb（纯组合）+ checkPTP + 欧拉 V−E+F = 1。
 * 数据不对时 comb/checkPTP 可能直接抛（比如外边界退了两次同一个点），
 * 抛出去就没法打印面列表了，而面列表正是要修数据时最想看的东西 —— 所以接住、记成问题。
 *
 * @returns {{C, ptp, chi, problems:string[]}}
 */
export function checkDisk(nv, tri, cornersCCW, opts = {}) {
  const problems = [];
  let C, ptp, chi;
  try {
    C = comb(tri, nv);
    ptp = checkPTP(C, { corners: cornersCCW ?? undefined });
    for (const r of ptp.reasons) problems.push(`PTP 不过：${r}`);
    chi = nv - C.edges.length + tri.length;            // 圆盘三角剖分：V − E + F = 1
    if (chi !== 1) problems.push(`欧拉 V−E+F = ${chi} ≠ 1（V=${nv} E=${C.edges.length} F=${tri.length}）`);
  } catch (e) {
    problems.push(`三角剖分连不成合法圆盘：${e.message}`);
    C = { edges: [], boundary: [], deg: new Int32Array(nv), isBoundaryVert: new Uint8Array(nv) };
    ptp = { ok: false, reasons: [], minInteriorDeg: 0, minWallDeg: 0 };
    chi = NaN;
  }
  return { C, ptp, chi, problems };
}

/** 面 f 是否沿 a → b 走这条边。*/
function traverses(f, a, b) {
  for (let i = 0; i < f.length; i++) if (f[i] === a && f[(i + 1) % f.length] === b) return true;
  return false;
}

/** 把圈旋转到从 v 开始（v 不在圈里时返回 null）。*/
function rotToStart(f, v) {
  const i = f.indexOf(v);
  return i < 0 ? null : f.slice(i).concat(f.slice(0, i));
}

/**
 * 朝向传播：输入只给「顶点集合」形式的面（比如 3-团枚举的结果、或用户 JSON 里
 * 朝向写乱的面），输出朝向自洽的一份 —— 相邻两个面必须**反着**走公共边。
 *
 * 这是 3-团法的关键一步：3-团只知道「哪三个点组成一个面」，不知道绕向；
 * 朝向不对的话 comb/boundaryCycle 会直接报「一个点有两条出边（边界被捏住）」。
 *
 * @param {number[][]} faces
 * @param {{label?:Function}} opts
 * @returns {{faces:number[][], conflicts:string[]}} conflicts 非空说明朝向传播不下去
 *   （多半是图不可定向，或面表本身不是同一个曲面上的）
 */
export function orientFaces(faces, opts = {}) {
  const label = opts.label || defLabel;
  const m = faces.length;
  const conflicts = [];
  if (!m) return { faces: [], conflicts };

  const ekey = (a, b) => (a < b ? `${a},${b}` : `${b},${a}`);
  const byEdge = new Map();                    // 无向边 → 用到它的面的下标
  faces.forEach((f, i) => {
    for (let j = 0; j < f.length; j++) {
      const k = ekey(f[j], f[(j + 1) % f.length]);
      if (!byEdge.has(k)) byEdge.set(k, []);
      byEdge.get(k).push(i);
    }
  });

  const out = new Array(m).fill(null);
  const flip = (f) => [f[0], ...f.slice(1).reverse()];

  for (let s = 0; s < m; s++) {
    if (out[s]) continue;
    out[s] = faces[s].slice();
    const stack = [s];
    while (stack.length) {
      const i = stack.pop();
      const f = out[i];
      for (let j = 0; j < f.length; j++) {
        const a = f[j], b = f[(j + 1) % f.length];
        for (const g of byEdge.get(ekey(a, b)) || []) {
          if (g === i || out[g]) continue;
          // f 走了 a→b，所以 g 必须以 b→a 走这条边
          const cand = rotToStart(faces[g], b);
          if (cand && cand[1] !== a) {
            const fl = rotToStart(flip(faces[g]), b);
            if (fl && fl[1] === a) { out[g] = fl; stack.push(g); continue; }
          }
          if (!cand) { conflicts.push(`面 ${i} 与 ${g} 之间没有公共边 ${label(a)}–${label(b)}`); continue; }
          if (cand[1] === a) { out[g] = cand; stack.push(g); continue; }
          conflicts.push(`面 ${i} 与 ${g} 在公共边 ${label(a)}–${label(b)} 上的朝向传播不下去`
            + '（相邻面无法反着走同一条边 —— 图多半不可定向，或面表不属于同一个曲面）');
        }
      }
    }
  }
  return { faces: out, conflicts };
}

/** 由无向边表造邻接表（每个点是 Set）。*/
export function adjacencyFromEdges(nv, edges) {
  const nb = Array.from({ length: nv }, () => new Set());
  for (const [a, b] of edges) { nb[a].add(b); nb[b].add(a); }
  return nb;
}

/** 3-团枚举：所有两两相邻的三元组。顶点升序，去重。*/
export function cliques3(nv, nb) {
  const out = [];
  for (let u = 0; u < nv; u++) {
    const list = [...nb[u]].filter((v) => v > u).sort((a, b) => a - b);
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (nb[list[i]].has(list[j])) out.push([u, list[i], list[j]]);
      }
    }
  }
  return out;
}

/** 每条边被几个 3-团用到：`${a},${b}` → 次数。*/
export function cliqueEdgeCount(nv, nb, cliques) {
  const cnt = new Map();
  for (const t of cliques) {
    for (let i = 0; i < 3; i++) {
      const a = t[i], b = t[(i + 1) % 3];
      const k = a < b ? `${a},${b}` : `${b},${a}`;
      cnt.set(k, (cnt.get(k) || 0) + 1);
    }
  }
  return cnt;
}

export { traverses };
