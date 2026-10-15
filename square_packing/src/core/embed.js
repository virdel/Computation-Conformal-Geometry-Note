// 初始平面嵌入：外边界钉成正方形 + Tutte（重心）线性系统，再做几轮
// 均值坐标 (mean value coordinates) 细化 —— MVC 权重全正，3-连通图的
// Tutte 定理仍然保证结果无翻转。
//
// 这个嵌入有两个作用：
//   1) 界面上「输入图」的坐标；
//   2) Ricci 流的初始度量 g（离散共形结构因此由它决定 —— 见 README）。

import { zeros, solveLU } from './linalg.js';

/**
 * 由面表求出外边界的顶点循环序（不需要坐标、不需要定向）。
 * 边界半边 = 反向半边不出现的半边；它们首尾相接成圈。
 */
export function boundaryCycle(faces, nv) {
  const dir = new Set();
  for (const t of faces) for (let i = 0; i < 3; i++) dir.add(t[i] * nv + t[(i + 1) % 3]);
  const nextOf = new Map(); // 边界半边起点 -> 终点
  for (const t of faces) {
    for (let i = 0; i < 3; i++) {
      const a = t[i], b = t[(i + 1) % 3];
      if (dir.has(b * nv + a)) continue;   // 内部边
      if (nextOf.has(a)) throw new Error('boundaryCycle: 一个点有两条出边（边界被捏住）');
      nextOf.set(a, b);
    }
  }
  if (nextOf.size === 0) throw new Error('boundaryCycle: 没有边界');
  const start = nextOf.keys().next().value;
  const cyc = [];
  let cur = start;
  for (;;) {
    if (cyc.length > nv) throw new Error('boundaryCycle: 走不出圈');
    cyc.push(cur);
    const nxt = nextOf.get(cur);
    if (nxt === undefined) throw new Error('boundaryCycle: 边界断裂');
    if (nxt === start) return cyc;
    if (cyc.includes(nxt)) throw new Error('boundaryCycle: 边界提前闭合（有悬挂部分）');
    cur = nxt;
  }
}

/** 三角形有向面积。*/
function triArea(p, q, r) {
  return ((q[0] - p[0]) * (r[1] - p[1]) - (r[0] - p[0]) * (q[1] - p[1])) / 2;
}

/** 所有三角形的有向面积（含符号 —— 用来判断定向 / 翻转）。*/
export function signedAreas(verts, faces) {
  return faces.map((t) => triArea(verts[t[0]], verts[t[1]], verts[t[2]]));
}

/** 总面积带符号；< 0 说明整张面表是顺时针的。*/
export function totalSignedArea(verts, faces) {
  return signedAreas(verts, faces).reduce((a, b) => a + b, 0);
}

/** 若面表整体是 CW，就逐面反向，返回 CCW 的面表。*/
export function orientCCW(verts, faces) {
  if (totalSignedArea(verts, faces) < 0) return faces.map((t) => [t[2], t[1], t[0]]);
  return faces.map((t) => t.slice());
}

/** 正面积面数与最小面积（无翻转自检）。*/
export function planarity(verts, faces) {
  const a = signedAreas(verts, faces);
  let bad = 0, min = Infinity;
  for (const x of a) { if (!(x > 0)) bad++; min = Math.min(min, x); }
  return { bad, minArea: min };
}

/** 由面表造无向邻接表（每个点是 Set）。*/
export function adjacencyOf(faces, nv) {
  const nb = Array.from({ length: nv }, () => new Set());
  for (const t of faces) {
    for (let i = 0; i < 3; i++) {
      const a = t[i], b = t[(i + 1) % 3];
      nb[a].add(b); nb[b].add(a);
    }
  }
  return nb;
}

/**
 * 解一个调和系统：边界点固定在 pos 上（pos[v] !== null），内点满足
 * Σ_j w_ij (x_i − x_j) = 0。
 *
 * 邻接直接给（不一定要有面表）—— mapgraph.js 要在**还没有面**的时候先嵌入一次。
 * @param {Set<number>[]} nb 无向邻接
 * @param {(v:number,w:number)=>number} weightOf
 */
export function solveHarmonicAdj(nv, nb, pos, weightOf) {
  const interior = [];
  const idx = new Int32Array(nv).fill(-1);
  for (let v = 0; v < nv; v++) if (pos[v] === null) { idx[v] = interior.length; interior.push(v); }
  const ni = interior.length;
  if (ni === 0) return pos;
  const A = zeros(ni);
  const bx = new Array(ni).fill(0), by = new Array(ni).fill(0);
  for (let r = 0; r < ni; r++) {
    const v = interior[r];
    let sum = 0;
    for (const w of nb[v]) {
      const wt = weightOf(v, w);
      sum += wt;
      if (pos[w] === null) A[r][idx[w]] -= wt;
      else { bx[r] += wt * pos[w][0]; by[r] += wt * pos[w][1]; }
    }
    A[r][r] += sum;
  }
  const x = solveLU(A, bx), y = solveLU(A, by);
  const out = pos.map((p) => (p ? p.slice() : null));
  interior.forEach((v, r) => { out[v] = [x[r], y[r]]; });
  return out;
}

/** 角点正方形（按外边界循环序 CCW 摆放）。*/
export function squareCorners(w = 1, h = 1) {
  return [[0, 0], [w, 0], [w, h], [0, h]];
}

/** 均值坐标权重表：w_vw = (tan(α/2) + tan(β/2)) / |vw|。*/
function mvcWeights(faces, nv, pos) {
  const W = new Map();
  const key = (a, b) => (a < b ? a * nv + b : b * nv + a);
  for (const t of faces) {
    for (let i = 0; i < 3; i++) {
      const v = t[i], p = t[(i + 1) % 3], q = t[(i + 2) % 3];
      const pv = pos[v], pp = pos[p], pq = pos[q];
      if (!pv || !pp || !pq) continue;
      const u = [pp[0] - pv[0], pp[1] - pv[1]];
      const w = [pq[0] - pv[0], pq[1] - pv[1]];
      const nu = Math.hypot(u[0], u[1]), nw = Math.hypot(w[0], w[1]);
      if (nu < 1e-14 || nw < 1e-14) continue;
      const cos = Math.max(-1, Math.min(1, (u[0] * w[0] + u[1] * w[1]) / (nu * nw)));
      const ang = Math.acos(cos);
      const tanHalf = Math.tan(ang / 2);
      for (const nb of [p, q]) {
        const k = key(v, nb);
        const len = Math.hypot(pos[nb][0] - pv[0], pos[nb][1] - pv[1]);
        if (len < 1e-14) continue;
        W.set(k, (W.get(k) || 0) + tanHalf / len);
      }
    }
  }
  return W;
}

/**
 * 把外边界按 4 个角点切成 4 段，整段（含两端）铺到四边形的 4 条边上。
 *
 * 允许外边界有 k > 4 个点：从 corners[i] 沿外边界走到 corners[i+1] 的那一段
 * （有 m 条边）里，第 t 个点放在 quad[i] + (quad[i+1] − quad[i]) · t/m。
 * 段内点按**序号等分**（不是按地理弧长）：等分后墙上的点初始共线、Σθ = π、
 * 曲率恰好是目标值 0，Ricci 流只需处理 4 个角点，收敛更稳。
 *
 * boundary 是**逆时针**序（与输入的逆时针面表一致），所以角点在它上面也必须按
 * corners[0] → corners[1] → corners[2] → corners[3] 的循环顺序出现 —— 顺序写错
 * 会在这里直接报错（这是地图数据的第一道检查）。
 */
function pinCornersToQuad(boundary, corners, quad, pos) {
  const k = boundary.length;
  if (corners.length !== 4) throw new Error(`tutteEmbed: corners 要 4 个顶点，给了 ${corners.length}`);
  const cset = new Set(corners);
  if (cset.size !== 4) throw new Error('tutteEmbed: corners 里有重复顶点');
  const at = new Map(boundary.map((v, i) => [v, i]));
  for (const v of corners) if (!at.has(v)) throw new Error(`tutteEmbed: 角点 v${v} 不在外边界上`);
  for (const v of boundary) if (pos[v] !== null) throw new Error('tutteEmbed: 边界点被重复钉');

  // 沿外边界逆时针走一圈，记下遇到角点的先后
  const start = at.get(corners[0]);
  const seen = [corners[0]];
  for (let t = 1; t < k; t++) {
    const v = boundary[(start + t) % k];
    if (v !== corners[0] && cset.has(v)) seen.push(v);
  }
  if (seen.join(',') !== corners.join(',')) {
    throw new Error('tutteEmbed: 角点的循环顺序不对 —— 沿外边界逆时针遇到的是 '
      + `[${seen.join(', ')}]，但 quad 声明的顺序是 [${corners.join(', ')}]`
      + '（要么角点选错，要么外边界圈的走向反了）');
  }

  for (let i = 0; i < 4; i++) {
    const from = at.get(corners[i]), to = at.get(corners[(i + 1) % 4]);
    const m = (to - from + k) % k;            // 这一段有几条边（≥ 1）
    const a = quad[i], b = quad[(i + 1) % 4];
    for (let t = 0; t <= m; t++) {
      const v = boundary[(from + t) % k];
      pos[v] = [a[0] + (b[0] - a[0]) * (t / m), a[1] + (b[1] - a[1]) * (t / m)];
    }
  }
}

/**
 * 初始嵌入。
 * @param {{refine?:number, rect?:[number,number], shape?:'square'|'circle'|'quad',
 *          quad?:number[][], corners?:number[]}} opts
 *   shape='square'：把外边界（4-圈）钉成正方形的四个角（默认）；
 *   shape='quad'：把外边界钉在凸四边形 quad 上。给了 corners（4 个顶点，按
 *     quad[0..3] 的逆时针顺序）时外边界可以是任意 k-圈，见 pinCornersToQuad；
 *     不给 corners 时要求外边界正好 4 个点（老行为，boundary[i] ↔ quad[i]）。
 *   shape='circle'：把边界顶点均匀钉在一个圆上（四边形「圆内画图」的样子，
 *     这样边界上每个点的 Σθ ≠ π，曲率非零 —— Ricci 流有活干）。
 * @returns {{verts:number[][], boundary:number[], planarity:{bad:number,minArea:number},
 *            usedRefine:boolean, cornersCCW:number[]}} cornersCCW[k] = 被钉到 quad[k] 的顶点
 */
export function tutteEmbed(faces, nv, opts = {}) {
  const { refine = 3, rect = [1, 1], shape = 'square', quad = null, corners = null } = opts;
  const boundary = boundaryCycle(faces, nv);
  let pos = new Array(nv).fill(null);
  let cornersCCW = null;
  if (shape === 'quad') {
    if (!quad || quad.length !== 4) throw new Error('tutteEmbed: shape=quad 需要 4 个角点');
    if (corners) {
      pinCornersToQuad(boundary, corners, quad, pos);
      cornersCCW = corners.slice();
    } else {
      if (boundary.length !== 4) {
        throw new Error(`tutteEmbed: 外边界长度 ${boundary.length} ≠ 4，钉不成四边形`
          + '（要 k > 4 的边界请显式给 corners）');
      }
      boundary.forEach((v, i) => { pos[v] = [quad[i][0], quad[i][1]]; });
      cornersCCW = boundary.slice();
    }
  } else if (shape === 'square') {
    if (boundary.length !== 4) {
      throw new Error(`tutteEmbed: 外边界长度 ${boundary.length} ≠ 4，无法钉成矩形`);
    }
    const sq = squareCorners(rect[0], rect[1]);
    boundary.forEach((v, i) => { pos[v] = sq[i % 4].slice(); });
  } else {
    const m = boundary.length, R = Math.max(rect[0], rect[1]) / 2;
    boundary.forEach((v, i) => {
      const a = 2 * Math.PI * (i / m);
      pos[v] = [R + R * Math.cos(a), R + R * Math.sin(a)];
    });
  }

  // 第一轮：均匀权重（Tutte 定理保证无翻转）
  pos = solveHarmonicAdj(nv, adjacencyOf(faces, nv), pos, () => 1);
  let usedRefine = false;

  // 后续：MVC 权重（正权重，定理仍成立），图形更好看
  for (let it = 0; it < refine; it++) {
    const W = mvcWeights(faces, nv, pos);
    const key = (a, b) => (a < b ? a * nv + b : b * nv + a);
    const nb = adjacencyOf(faces, nv);
    // 缺权重（退化三角形）时退回 1，保证矩阵连通
    const wt = (v, w) => {
      const k = key(v, w);
      const x = W.get(k);
      return x !== undefined && x > 0 ? x : 1e-6;
    };
    let next;
    try { next = solveHarmonicAdj(nv, nb, pos, wt); } catch { break; }
    if (planarity(next, faces).bad > 0) break;  // 细化把图形弄翻了，保留上一版
    pos = next;
    usedRefine = true;
  }

  // cornersCCW = 被钉到 quad[0..3] 的顶点。k > 4 时 pinCornersToQuad 已经断言过
  // 声明的顺序与边界圈的逆时针走向一致，所以这里就是传进来的那 4 个。
  return { verts: pos, boundary, planarity: planarity(pos, faces), usedRefine, cornersCCW };
}
