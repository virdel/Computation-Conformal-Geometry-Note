// 由 REL 造出矩形对偶（铺满整块大矩形的一组矩形）。
//
// 关键是把每条边的约束变成「等号」，再用 union-find 把坐标合并成若干个「层」：
//   * red  (u,v):  x2(u) = x1(v)
//   * blue (u,v):  y2(u) = y1(v)
//   * 左墙（没有入红边的点）x1 都相等 = 0；右墙（没有出红边）x2 都相等 = W
//   * 下墙（没有入蓝边）y1 都相等 = 0；上墙（没有出蓝边）y2 都相等 = H
// 每个顶点再给一条 x1(v) → x2(v)、y1(v) → y2(v) 的 DAG 边（权重 1，表示
// 「至少要有一格宽」），层坐标 = 从源点出发的最长路径。
// 各段宽度本来是自由的（可以用单调函数重新分配），这里取最小整数解。

const X1 = 0, X2 = 1, Y1 = 2, Y2 = 3;

class DSU {
  constructor(n) { this.p = Int32Array.from({ length: n }, (_, i) => i); this.r = new Int32Array(n); }
  find(x) { while (this.p[x] !== x) { this.p[x] = this.p[this.p[x]]; x = this.p[x]; } return x; }
  union(a, b) {
    let ra = this.find(a), rb = this.find(b);
    if (ra === rb) return false;
    if (this.r[ra] < this.r[rb]) { const t = ra; ra = rb; rb = t; }
    this.p[rb] = ra;
    if (this.r[ra] === this.r[rb]) this.r[ra]++;
    return true;
  }
}

function longestPath(nNodes, edges) {
  const indeg = new Int32Array(nNodes);
  const adj = Array.from({ length: nNodes }, () => []);
  for (const [u, v, w] of edges) { adj[u].push([v, w]); indeg[v]++; }
  const q = [];
  for (let i = 0; i < nNodes; i++) if (indeg[i] === 0) q.push(i);
  const level = new Float64Array(nNodes);
  let seen = 0;
  for (let qi = 0; qi < q.length; qi++) {
    const u = q[qi]; seen++;
    for (const [v, w] of adj[u]) {
      if (level[u] + w > level[v]) level[v] = level[u] + w;
      if (--indeg[v] === 0) q.push(v);
    }
  }
  const sources = [];
  const indeg0 = new Int32Array(nNodes);
  for (const [, v] of edges) indeg0[v]++;
  for (let i = 0; i < nNodes; i++) if (indeg0[i] === 0 && adj[i].length > 0) sources.push(i);
  return { cycle: seen !== nNodes, level, edges, nNodes, sources };
}

/**
 * @param {Mesh} mesh
 * @param {Map} edgeColor 含内边（labelBySlope/ addOuterEdges 的结果）
 * @returns {{rects:{x1,x2,y1,y2}[], W, H, xLevels:number[], yLevels:number[],
 *            stats:{cycle:boolean, xSources:number, ySources:number,
 *                   rightWallSame:boolean, topWallSame:boolean}}}
 */
export function buildRectangles(mesh, edgeColor, wallsIn) {
  if (!wallsIn) throw new Error('buildRectangles: 需要四面墙（见 rel.wallChains）');
  const nv = mesh.nv;
  const ZX = 4 * nv, ZW = 4 * nv + 1, ZY = 4 * nv + 2, ZH = 4 * nv + 3;
  const dsu = new DSU(4 * nv + 4);
  const key = (k, v) => 4 * v + k;

  // 红/蓝边的等号约束（外边也要算 —— 它们同样是「R(u) 正贴着 R(v)」）
  for (const lab of edgeColor.values()) {
    if (lab.color === 'R') dsu.union(key(X2, lab.from), key(X1, lab.to));
    else dsu.union(key(Y2, lab.from), key(Y1, lab.to));
  }

  // 四面墙 = 四段边界链（外边已经把每个角点的 x1/x2 串起来了）
  const { leftWall = [], rightWall = [], bottomWall = [], topWall = [] } = wallsIn;
  for (const v of leftWall) dsu.union(key(X1, v), ZX);
  for (const v of rightWall) dsu.union(key(X2, v), ZW);
  for (const v of bottomWall) dsu.union(key(Y1, v), ZY);
  for (const v of topWall) dsu.union(key(Y2, v), ZH);

  // 每个顶点一条「宽/高至少 1」的 DAG 边
  const xEdges = [], yEdges = [];
  const seenX = new Set(), seenY = new Set();
  for (let v = 0; v < nv; v++) {
    const a = dsu.find(key(X1, v)), b = dsu.find(key(X2, v));
    const ka = `${a},${b}`;
    if (!seenX.has(ka)) { seenX.add(ka); xEdges.push([a, b, 1]); }
    const c = dsu.find(key(Y1, v)), d = dsu.find(key(Y2, v));
    const kc = `${c},${d}`;
    if (!seenY.has(kc)) { seenY.add(kc); yEdges.push([c, d, 1]); }
  }

  // 「贴住」不能只是坐标相等 —— 两个矩形必须真的有一段正长度的公共边。
  // 红边 (u,v)：y 区间要有正重叠 → y2(u) > y1(v) 且 y2(v) > y1(u)：两条 DAG 边。
  // 蓝边 (u,v)：x 区间要有正重叠 → 同理加两条。
  // 这两条正是「按相等关系合并 + 最长路」最容易漏掉的东西：漏了就会得到
  // 一堆只在一个点相碰的矩形（面积对不上、该接触的边没接触）。
  let overlapConflict = 0;
  for (const lab of edgeColor.values()) {
    const { from: u, to: v, color } = lab;
    const push = (arr, seen, a, b) => {
      const ra = dsu.find(a), rb = dsu.find(b);
      if (ra === rb) { overlapConflict++; return; }   // 合并成同一层却还要求严格大于 → 无解
      const k = `${ra},${rb}`;
      if (!seen.has(k)) { seen.add(k); arr.push([ra, rb, 1]); }
    };
    if (color === 'R') {
      push(yEdges, seenY, key(Y1, u), key(Y2, v));
      push(yEdges, seenY, key(Y1, v), key(Y2, u));
    } else {
      push(xEdges, seenX, key(X1, u), key(X2, v));
      push(xEdges, seenX, key(X1, v), key(X2, u));
    }
  }

  const nNodes = 4 * nv + 4;
  const Lx = longestPath(nNodes, xEdges);
  const Ly = longestPath(nNodes, yEdges);

  const fx = (k, v) => Lx.level[dsu.find(key(k, v))];
  const fy = (k, v) => Ly.level[dsu.find(key(k, v))];

  const rects = [];
  for (let v = 0; v < nv; v++) {
    rects.push({
      v,
      x1: fx(X1, v), x2: fx(X2, v),
      y1: fy(Y1, v), y2: fy(Y2, v),
    });
  }
  const W = Lx.level[dsu.find(ZW)];
  const H = Ly.level[dsu.find(ZH)];
  const xLevels = [...new Set(rects.flatMap((r) => [r.x1, r.x2]))].sort((a, b) => a - b);
  const yLevels = [...new Set(rects.flatMap((r) => [r.y1, r.y2]))].sort((a, b) => a - b);

  return {
    rects, W, H, xLevels, yLevels,
    walls: { leftWall, rightWall, bottomWall, topWall },
    stats: {
      cycle: Lx.cycle || Ly.cycle,
      overlapConflict,
      xSources: Lx.sources.length, ySources: Ly.sources.length,
      xMaxIsW: Math.max(...rects.map((r) => r.x2)) === W,
      yMaxIsH: Math.max(...rects.map((r) => r.y2)) === H,
      leftWallHasZero: Math.min(...rects.map((r) => r.x1)) === 0,
      bottomWallHasZero: Math.min(...rects.map((r) => r.y1)) === 0,
    },
    levels: { dsu, Lx, Ly, ZX, ZW, ZY, ZH, key },
  };
}

/**
 * 把每个层映射到一个单调递增的位置 —— 用来滑动长宽比（REL 允许任意单调重排）。
 * @param {number[]} levels 所有层值（升序）
 * @param {(t:number)=>number} f t ∈ [0,1] → 新位置
 */
export function remapLevels(rects, xLevels, yLevels, f) {
  const mx = new Map(xLevels.map((L, i) => [L, f(xLevels.length === 1 ? 0 : i / (xLevels.length - 1))]));
  const my = new Map(yLevels.map((L, i) => [L, f(yLevels.length === 1 ? 0 : i / (yLevels.length - 1))]));
  return rects.map((r) => ({ v: r.v, x1: mx.get(r.x1), x2: mx.get(r.x2), y1: my.get(r.y1), y2: my.get(r.y2) }));
}
