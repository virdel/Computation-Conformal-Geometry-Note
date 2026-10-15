// PTP（properly triangulated planar）校验 —— 矩形对偶存在的充要条件。
//   (a) 每个内面都是三角形；
//   (b) 外边界是简单圈，且被 4 个角点分成 4 段非空链（不给 corners 时 = 外边界
//       恰好是 4-圈）；
//   (c) 没有分离三角形（不是面、但删掉就把图断开的 3-圈）。
// 对圆盘三角剖分，(c) 等价于 4-连通，且蕴含所有内点度 ≥ 4；
// 边界上非角点的度数必须 ≥ 3（它的 presence 有 3 块，deg 2 的墙点只摆得下 2 块）。

import { Mesh } from './mesh.js';
import { boundaryCycle } from './embed.js';

/**
 * 纯组合信息（不需要坐标）：给 checkPTP / 生成器用。
 * 返回对象与 Mesh 在 checkPTP 需要的字段上同形。
 */
export function comb(faces, nv) {
  const seen = new Map();
  const edges = [];
  const deg = new Int32Array(nv);
  for (const t of faces) {
    for (let i = 0; i < 3; i++) {
      const a = t[i], b = t[(i + 1) % 3];
      const k = a < b ? a * nv + b : b * nv + a;
      if (!seen.has(k)) { seen.set(k, true); edges.push(a < b ? [a, b] : [b, a]); deg[a]++; deg[b]++; }
    }
  }
  const boundary = boundaryCycle(faces, nv);
  const isBoundaryVert = new Uint8Array(nv);
  for (const v of boundary) isBoundaryVert[v] = 1;
  return { nv, faces, edges, boundary, isBoundaryVert, deg };
}

/** 3-圈枚举：返回所有两两相邻的三元组 [u,v,w]（u<v<w）。*/
function triangles(mesh) {
  const out = [];
  const adj = Array.from({ length: mesh.nv }, () => new Set());
  for (const [a, b] of mesh.edges) { adj[a].add(b); adj[b].add(a); }
  for (let u = 0; u < mesh.nv; u++) {
    for (const v of adj[u]) {
      if (v <= u) continue;
      for (const w of adj[u]) {
        if (w <= v) continue;
        if (adj[v].has(w)) out.push([u, v, w]);
      }
    }
  }
  return out;
}

function faceKey(t) { return [...t].sort((a, b) => a - b).join(','); }

/** 去掉 vertices 里的点之后，剩下的点是否连通（BFS）。*/
function connectedAfterRemoval(mesh, removed) {
  const gone = new Set(removed);
  const adj = Array.from({ length: mesh.nv }, () => []);
  for (const [a, b] of mesh.edges) {
    if (gone.has(a) || gone.has(b)) continue;
    adj[a].push(b); adj[b].push(a);
  }
  let start = -1, total = 0;
  for (let v = 0; v < mesh.nv; v++) if (!gone.has(v)) { total++; if (start < 0) start = v; }
  if (total <= 1) return true;
  const seen = new Set([start]); const st = [start];
  while (st.length) {
    const v = st.pop();
    for (const w of adj[v]) if (!seen.has(w)) { seen.add(w); st.push(w); }
  }
  return seen.size === total;
}

/**
 * 完整 PTP 校验。mesh 可以是 Mesh，也可以是 comb() 的返回值。
 * @param {object} mesh
 * @param {{corners?:number[]}} opts
 *   corners：外边界有 k > 4 个点时**必须**给，声明 4 个角点沿外边界的逆时针次序。
 * @returns {{ok:boolean, reasons:string[], numSepTri:number, minInteriorDeg:number,
 *            boundaryLen:number, numTris:number, corners:number[]|null,
 *            segLens:number[]|null, minWallDeg:number}}
 */
export function checkPTP(mesh, opts = {}) {
  const reasons = [];
  const faceKeys = new Set(mesh.faces.map(faceKey));

  const numTris = mesh.faces.length;

  // (b) 外边界
  const boundaryLen = mesh.boundary.length;
  const uniq = new Set(mesh.boundary);
  const corners = opts.corners ? opts.corners.slice() : null;
  let segLens = null, minWallDeg = Infinity;
  if (uniq.size !== boundaryLen) {
    reasons.push(`外边界不是简单圈（长度 ${boundaryLen}，不同顶点 ${uniq.size} —— 有点被走了两遍）`);
  } else if (!corners) {
    if (boundaryLen !== 4) reasons.push(`外边界不是 4-圈（长度 ${boundaryLen}，不同顶点 ${uniq.size}）`);
  } else if (corners.length !== 4 || new Set(corners).size !== 4
      || corners.some((v) => !uniq.has(v))) {
    reasons.push(`corners 必须是外边界上的 4 个不同顶点（给了 [${corners.join(', ')}]）`);
  } else {
    const at = new Map(mesh.boundary.map((v, i) => [v, i]));
    segLens = [];
    for (let i = 0; i < 4; i++) {
      const from = at.get(corners[i]), to = at.get(corners[(i + 1) % 4]);
      segLens.push((to - from + boundaryLen) % boundaryLen);
    }
    if (segLens.some((m) => m < 1)) {
      reasons.push(`4 个角点没把外边界分成 4 段非空链（各段边数 ${segLens.join('/')}）`);
    }
    const start = at.get(corners[0]);
    const seen = [corners[0]];
    for (let t = 1; t < boundaryLen; t++) {
      const v = mesh.boundary[(start + t) % boundaryLen];
      if (v !== corners[0] && corners.includes(v)) seen.push(v);
    }
    if (seen.length === 4 && seen.join(',') !== corners.join(',')) {
      reasons.push(`角点沿外边界的逆时针次序 [${seen.join(', ')}] 与声明的 [${corners.join(', ')}] 不一致`);
    }
    for (const v of mesh.boundary) if (!corners.includes(v)) minWallDeg = Math.min(minWallDeg, mesh.deg[v]);
    if (minWallDeg < 3 && Number.isFinite(minWallDeg)) {
      reasons.push(`边界上非角点的度数 ${minWallDeg} < 3`);
    }
  }

  // (c) 分离三角形
  const sep = [];
  for (const t of triangles(mesh)) {
    if (faceKeys.has(faceKey(t))) continue;
    if (!connectedAfterRemoval(mesh, t)) sep.push(t);
  }
  if (sep.length) reasons.push(`存在 ${sep.length} 个分离三角形`);

  // 内点最小度（PTP 下应 ≥ 4）
  let minInteriorDeg = Infinity;
  for (let v = 0; v < mesh.nv; v++) {
    if (mesh.isBoundaryVert[v]) continue;
    minInteriorDeg = Math.min(minInteriorDeg, mesh.deg[v]);
  }
  if (minInteriorDeg < 4 && Number.isFinite(minInteriorDeg)) {
    reasons.push(`有内点度数 ${minInteriorDeg} < 4`);
  }

  return {
    ok: reasons.length === 0,
    reasons,
    numSepTri: sep.length,
    minInteriorDeg: Number.isFinite(minInteriorDeg) ? minInteriorDeg : 0,
    boundaryLen,
    numTris,
    corners,
    segLens,
    minWallDeg: Number.isFinite(minWallDeg) ? minWallDeg : 0,
  };
}

/** 由 (verts, faces) 造 Mesh。*/
export function meshFrom(verts, faces) {
  return new Mesh(verts, faces);
}
