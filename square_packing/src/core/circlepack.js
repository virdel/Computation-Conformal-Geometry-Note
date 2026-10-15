// 圆盘填充（circle packing）：和方块填充跑**同一条流水线**，只换度量族。
//
//   方块填充：l_ij = l̄_ij · e^{(u_i+u_j)/2}   （Ricci 流的共形度量）  目标曲率：4 角 π/2、其余 0
//   圆盘填充：l_ij = e^{u_i} + e^{u_j}        （相切度量，u_i = log r_i）
//
// 两处关键事实让这条流水线原样可用：
//   · l_ij = r_i + r_j 恰好是两圆相切时的圆心距，而它**永远**严格满足三角不等式
//     （r_i + r_j > |r_i − r_j|），所以「退化三角形」这种检查在这里根本不需要；
//   · 内点曲率 0（Σθ = 2π）意味着内点周围严丝合缝，于是 unfold.js 的 develop(mesh)
//     原样就是解码器：铺出来的圆心距正好等于 r_i + r_j。
//
// 边界条件有两种（`opts.mode`），**它们不是同一个问题**：
//
//   mode:'angles'（默认）—— 与方块填充**同一套目标曲率**：K̄ = mesh.targetCurvature(corners)，
//     即 4 个角点 π/2、其余顶点 0（圆盘口径）。一步阻尼 Newton（未知量 u = log r，钉一个
//     顶点定整体缩放）就解完，实测 4–7 步到 ≤ 9e-15。解的每条含义都能在铺展后的图上量出来：
//       · 4 个角点的角度和 = π/2 ⟺ **四个角都是 90°**；
//       · 墙点（边界上非角点）角度和 = π ⟺ 边界圆心链在墙上走直线；
//       · 内点角度和 = 2π ⟺ 内部严丝合缝；
//     于是 4 条墙的圆心链围成一个**矩形**：4 个角都是直角的四边形必是矩形，而相切链给出
//     第 t 条边 = r_t + r_{t+1}，所以对边相等；k = 4 时四条边全相等 —— 必是正方形。
//     代价：边界圆**不**共外圆（极大性不成立），且边界点多、内点少时半径比被拉得更大
//     （实测美国 1.24e4，是 mode:'maximal' 那个 754 的 16 倍）。同一张三角剖分上两种边界
//     条件的真实差别，README 里两个数并排摆着。
//
//   mode:'maximal' —— 极大填充（Koebe–Andreev–Thurston：所有边界圆同时内切于一个外圆）。
//     角点角度**不受约束**（实测美国四个角 103°–146°、中国 97°–178°），所以它**不是**
//     「四个角 90°」的那个填充。三段算法：
//   ① 球面流定初值 —— 圆盘补一个顶点 ∞，用扇面 (b_i, b_{i+1}, ∞) 封口，得到一个球面
//      三角剖分。目标曲率 K̄ = 0（内点与 ∞）、K̄_b = 4π/k —— Gauss–Bonnet 保证
//      ΣK̄ = 4π，所以这组目标是自洽的。阻尼 Newton（数值 Jacobian）4–6 步收敛，
//      给出**合法但不极大**的填充（0 重叠，但边界圆不共外圆）。
//   ② 外圆打靶 —— 固定相切关系（图上每条边），只调 k 个边界半径的对数（钉住第 0 个
//      以定整体缩放），逼「每个边界圆都内切于同一个外圆」。残差取**方差形式**
//        e_i = (|o − p_i| + r_i) − mean
//      只对圆心 o（2 个参数）优化：外圆半径 R 就成了残差里的 mean 而不是参数，
//      于是 max|e| → 0 精确等价于「存在一个外圆同时内切所有边界圆」。
//      Gauss–Newton（阻尼正规方程）+ 回溯线搜索。
//   ③ 规范固定 —— 收敛后外圆已经是真圆，此时 Aut(D) 才是真正的规范变换（保相切、保外圆、
//      只改边界半径的分布）。在 Aut(D) 里挑一个把**最小边界半径最大化**的变换，
//      把边界半径的比值压到最小 —— 这个「最小比值」是三角剖分的规范量。
//      注意这一步必须放在收敛之后：外圆还只是最小二乘拟合时，Aut(D) 不是规范变换，
//      在循环里做会把收敛毁掉（实测美国残差炸到 9.5e15）。
//
// 极大性：② 收敛 ⟺ 得到的填充是极大的（Koebe–Andreev–Thurston 的意义下，没有哪颗圆
// 还能再长大）。当边界点远多于内点，极大填充天然被逼出很大的半径比 —— 那是
// 三角剖分的固有性质，不是实现问题（见 README「美国那张图的固有退化」）。

import { solveLU } from './linalg.js';
import { develop } from './unfold.js';

/* ---------- 度量：相切 ---------- */

/** 由 u = log 半径写出相切度量（并刷新角度，之后 curvature() 才是新的）。*/
export function tangencyLengths(mesh, u, out = mesh.len) {
  for (let e = 0; e < mesh.ne; e++) {
    const [a, b] = mesh.edges[e];
    out[e] = Math.exp(u[a]) + Math.exp(u[b]);
  }
  mesh.refreshAngles();
  return out;
}

const angleFromSides = (a, b, c) =>
  Math.acos(Math.min(1, Math.max(-1, (b * b + c * c - a * a) / (2 * b * c))));

const minOf = (a) => a.reduce((m, x) => Math.min(m, x), Infinity);
const maxOf = (a) => a.reduce((m, x) => Math.max(m, x), -Infinity);

/** 边界半径的 最大 / 最小。*/
function boundaryRatio(r, bnd) {
  let lo = Infinity, hi = -Infinity;
  for (const v of bnd) { if (r[v] < lo) lo = r[v]; if (r[v] > hi) hi = r[v]; }
  return hi / lo;
}

/* ---------- 默认路径：相切度量 + 预定曲率（4 角 π/2，其余 0） ---------- */

/**
 * 解 K(u) = K̄，其中 K̄ = mesh.targetCurvature(corners)（4 个角点 π/2，其余顶点 0，圆盘口径）。
 * 这就是方块填充里 Ricci 流那一步的**同一个目标曲率**，只是度量族换成相切度量。
 *
 * 未知量 u = log r。u → u + c 不改任何三角形的内角（相切度量对整体缩放不变），所以钉住
 * corners[0] 是必须的，也是唯一的规范自由度。Jacobi 矩阵 dK/du 用数值差分（h = 1e-7），
 * solveLU 解，回溯线搜索。目标曲率是严格凸变分问题的梯度，从 u ≡ 0（所有半径相等）出发
 * 实测从不失败：4–7 步到 ≤ 9e-15。
 *
 * @returns {{u:Float64Array, err:number, iterations:number, converged:boolean, note:string}}
 *          err = max|K̄ − K|（对所有顶点，含钉住的那个 —— 它在 Gauss–Bonnet 下自动满足）
 */
export function solveAngles(mesh, corners, { maxIter = 100, tol = 1e-13 } = {}) {
  const nv = mesh.nv;
  const Kbar = mesh.targetCurvature(corners);
  const pin = corners[0];
  const free = [];
  for (let v = 0; v < nv; v++) if (v !== pin) free.push(v);
  const m = free.length;
  const u = new Float64Array(nv);
  const errOf = (K) => {
    let e = 0;
    for (let v = 0; v < nv; v++) e = Math.max(e, Math.abs(K[v] - Kbar[v]));
    return e;
  };
  let err = Infinity, it = 0, note = '';
  for (; it < maxIter; it++) {
    tangencyLengths(mesh, u);
    const K = mesh.curvature();
    err = errOf(K);
    if (err <= tol) break;
    const J = [];
    for (let i = 0; i < m; i++) J.push(new Array(m).fill(0));
    for (let j = 0; j < m; j++) {
      const h = 1e-7;
      u[free[j]] += h;
      tangencyLengths(mesh, u);
      const K2 = mesh.curvature();
      u[free[j]] -= h;
      for (let i = 0; i < m; i++) J[i][j] = (K2[free[i]] - K[free[i]]) / h;
    }
    let d;
    try { d = solveLU(J, free.map((v) => Kbar[v] - K[v])); }
    catch { note = 'Jacobi 奇异（解不出来）'; break; }
    let s = 1, accepted = false;
    for (let ls = 0; ls < 60; ls++) {
      const save = free.map((v) => u[v]);
      free.forEach((v, i) => { u[v] += s * d[i]; });
      tangencyLengths(mesh, u);
      const e2 = errOf(mesh.curvature());
      if (e2 < err || e2 <= tol) { err = e2; accepted = true; break; }
      free.forEach((v, i) => { u[v] = save[i]; });
      s /= 2;
    }
    if (!accepted) { note = '线搜索失败（这一步下降不了）'; break; }
  }
  tangencyLengths(mesh, u);
  if (!note && err > tol) note = `到上限 ${maxIter} 步仍未到 tol`;
  return { u, err, iterations: it, converged: err <= tol, note };
}

/**
 * 外框：把边界圆心链在 4 个角点处切成 4 段。铺展后的相邻圆心距 = 两半径之和（相切），
 * 所以每段的**折线长** = Σ(r_i + r_{i+1})，而它应当**等于**两端角点的**弦长** ——
 * 「墙是直的」就是这两者相等（墙上每个点角度和 π）。
 *
 * 顺带量矩形的另外两个特征：对边相等、4 个角转弯都是 π/2。
 *
 * @returns {{chains:number[][], chords:number[], polyline:number[], straightErr:number,
 *            oppositeErr:number, cornerTurns:number[], turnErr:number, aspect:number}}
 */
function frameOf(mesh, pos, corners) {
  const bnd = mesh.boundary, k = bnd.length;
  const at = corners.map((c) => {
    const i = bnd.indexOf(c);
    if (i < 0) throw new Error('frameOf：角点不在外边界上');
    return i;
  }).sort((x, y) => x - y);
  const chains = [];
  for (let t = 0; t < 4; t++) {
    const a = at[t], b = at[(t + 1) % 4], chain = [a];
    for (let i = a; i !== b;) { i = (i + 1) % k; chain.push(i); }
    chains.push(chain);
  }
  const at2 = (i) => pos[bnd[i]];
  const d = (i, j) => Math.hypot(at2(i)[0] - at2(j)[0], at2(i)[1] - at2(j)[1]);
  const chords = [], polyline = [], cornerTurns = [];
  for (const ch of chains) {
    chords.push(d(ch[0], ch[ch.length - 1]));
    let s = 0;
    for (let i = 0; i + 1 < ch.length; i++) s += d(ch[i], ch[i + 1]);
    polyline.push(s);
  }
  for (const ch of chains) {            // 每段的起点就是一个角点；转角 = 进来方向 → 出去方向
    const i0 = ch[0], ip = (i0 - 1 + k) % k, i1 = ch[1];
    const p = at2(i0), a = at2(ip), b = at2(i1);
    const v1 = [p[0] - a[0], p[1] - a[1]], v2 = [b[0] - p[0], b[1] - p[1]];
    const ang = Math.atan2(v1[0] * v2[1] - v1[1] * v2[0], v1[0] * v2[0] + v1[1] * v2[1]);
    cornerTurns.push(Math.abs(ang));
  }
  return {
    chains, chords, polyline,
    cornerRing: chains.map((ch) => bnd[ch[0]]),    // 4 个角点，按边界圈次序（画外框用）
    straightErr: maxOf(chords.map((x, i) => Math.abs(x - polyline[i]))),
    oppositeErr: Math.max(Math.abs(chords[0] - chords[2]), Math.abs(chords[1] - chords[3])),
    cornerTurns,
    turnErr: maxOf(cornerTurns.map((t) => Math.abs(t - Math.PI / 2))),
    aspect: Math.max(chords[0], chords[1]) / Math.min(chords[0], chords[1]),
  };
}

/**
 * 默认的圆盘填充：相切度量 + 预定曲率（角点 π/2、其余 0），一步 Newton 解完，
 * 再用**同一个** develop(mesh) 铺展成圆心 —— 与方块填充完全同一条流水线。
 *
 * 会改 mesh.len（结束时留下与返回的 pos/r 一致的相切度量，所以之后自己调 develop(mesh)
 * 也能得到同一个填充，只差一个刚体运动）。
 *
 * @param {Mesh} mesh 圆盘三角剖分（2-连通、内面全是三角形）
 * @param {{corners?:number[], tol?:number, maxIter?:number}} opts corners 省略时，若外边界
 *        恰好 4 个点就取整条边界（老预设的情形）
 */
export function circlePackAngles(mesh, opts = {}) {
  const { corners = null, tol = 1e-13, maxIter = 100 } = opts;
  const t0 = Date.now();
  const bnd = mesh.boundary, k = bnd.length, nv = mesh.nv;
  const cor = corners ? corners.slice() : (k === 4 ? bnd.slice() : null);
  if (!cor || cor.length !== 4) {
    throw new Error(`圆盘填充（四角 90°）需要 4 个角点：外边界有 ${k} 个点，请传 opts.corners`);
  }
  const sol = solveAngles(mesh, cor, { tol, maxIter });
  const { pos } = develop(mesh);
  const r = new Float64Array(nv);
  for (let v = 0; v < nv; v++) r[v] = Math.exp(sol.u[v]);

  // 逐类顶点的角度：这部分是纯度量量（只看 mesh.len），与 pos 无关
  const sums = mesh.angleSums();
  const Kbar = mesh.targetCurvature(cor);
  const K = mesh.curvature();
  const isCorner = new Set(cor);
  const wall = bnd.filter((v) => !isCorner.has(v));
  const interior = [];
  for (let v = 0; v < nv; v++) if (!mesh.isBoundaryVert[v]) interior.push(v);
  const maxAbs = (arr, f) => arr.reduce((m, v) => Math.max(m, Math.abs(f(v))), 0);
  const angles = {
    cornerSums: cor.map((v) => sums[v]),
    cornerErr: maxAbs(cor, (v) => K[v] - Kbar[v]),
    wallMin: wall.length ? minOf(wall.map((v) => sums[v])) : Math.PI,
    wallMax: wall.length ? maxOf(wall.map((v) => sums[v])) : Math.PI,
    wallErr: maxAbs(wall, (v) => K[v]),
    nWall: wall.length,
    intMin: interior.length ? minOf(interior.map((v) => sums[v])) : 2 * Math.PI,
    intMax: interior.length ? maxOf(interior.map((v) => sums[v])) : 2 * Math.PI,
    intErr: maxAbs(interior, (v) => K[v]),
    nInt: interior.length,
    err: sol.err,
  };
  const frame = frameOf(mesh, pos, cor);
  const note = sol.converged
    ? `角点角度和 = 90°、墙 = 180°、内点 = 360°：max|K̄−K| = ${sol.err.toExponential(2)}，${sol.iterations} 步`
    : `未到 tol：max|K̄−K| = ${sol.err.toExponential(2)}（${sol.iterations} 步，${sol.note}）`;

  return {
    mode: 'angles', corners: cor, pos, r, u: Float64Array.from(r, Math.log),
    angles, frame,
    ratio: maxOf(r) / minOf(r),
    ratioBoundary: boundaryRatio(r, bnd),
    ratioInterior: interior.length
      ? maxOf(interior.map((v) => r[v])) / minOf(interior.map((v) => r[v])) : 1,
    iterations: sol.iterations, err: sol.err, converged: sol.converged,
    ms: Date.now() - t0,
    note,
  };
}

/* ---------- ① 球面流 ---------- */

/** 给圆盘补上顶点 ∞ 变成球面三角剖分（外面那条 k 边形墙拆成 k 个扇面）。*/
function sphereSetup(nv, faces, boundaryCCW) {
  const inf = nv, N = nv + 1;
  const all = faces.map((f) => f.slice());
  const k = boundaryCCW.length;
  for (let i = 0; i < k; i++) all.push([boundaryCCW[i], boundaryCCW[(i + 1) % k], inf]);
  const key = (a, b) => (a < b ? a * N + b : b * N + a);
  const edgeOf = new Map(), edges = [];
  for (const t of all) {
    for (let i = 0; i < 3; i++) {
      const a = t[i], b = t[(i + 1) % 3], kk = key(a, b);
      if (!edgeOf.has(kk)) { edgeOf.set(kk, edges.length); edges.push([a, b]); }
    }
  }
  return { N, inf, faces: all, edges, edgeOf, key };
}

/** 球面上每个顶点的曲率 K = 2π − Σθ（所有顶点一视同仁；边界的「转折角」被扇面吃掉了）。*/
function sphereCurvature(S, u) {
  const { faces, edges, edgeOf, key, N } = S;
  const len = new Float64Array(edges.length);
  for (let e = 0; e < edges.length; e++) {
    const [a, b] = edges[e];
    len[e] = Math.exp(u[a]) + Math.exp(u[b]);
  }
  const sum = new Float64Array(N);
  for (const t of faces) {
    const l = [0, 0, 0];
    for (let i = 0; i < 3; i++) l[i] = len[edgeOf.get(key(t[i], t[(i + 1) % 3]))];
    for (let i = 0; i < 3; i++) sum[t[i]] += angleFromSides(l[(i + 1) % 3], l[i], l[(i + 2) % 3]);
  }
  return Float64Array.from(sum, (x) => 2 * Math.PI - x);
}

/**
 * 球面流：把曲率推到 K̄（u[∞] 钉成 1 —— 球面上只剩缩放 + 一个整体自由度）。
 * @returns {{u:Float64Array, err:number, iterations:number, converged:boolean}}
 */
export function solveSphere(S, target, { maxIter = 100, tol = 1e-13 } = {}) {
  const { N, inf } = S;
  const free = [];
  for (let v = 0; v < N; v++) if (v !== inf) free.push(v);
  const m = free.length;
  const u = new Float64Array(N);
  const errOf = () => {
    const K = sphereCurvature(S, u);
    let e = 0;
    for (let v = 0; v < N; v++) e = Math.max(e, Math.abs(target[v] - K[v]));
    return e;
  };
  let err = errOf(), it = 0;
  for (; it < maxIter && err > tol; it++) {
    const K = sphereCurvature(S, u);
    const J = [];
    for (let i = 0; i < m; i++) J.push(new Array(m).fill(0));
    for (let j = 0; j < m; j++) {
      const h = 1e-7 * Math.max(1, Math.abs(u[free[j]]));
      u[free[j]] += h;
      const K2 = sphereCurvature(S, u);
      u[free[j]] -= h;
      for (let i = 0; i < m; i++) J[i][j] = (K2[free[i]] - K[free[i]]) / h;
    }
    let d;
    try {
      d = solveLU(J, free.map((v) => target[v] - K[v]));
    } catch { break; }
    let s = 1, ok = false;
    for (let ls = 0; ls < 60; ls++) {
      const save = free.map((v) => u[v]);
      free.forEach((v, i) => { u[v] += s * d[i]; });
      const e2 = errOf();
      if (e2 < err || e2 <= tol) { err = e2; ok = true; break; }
      free.forEach((v, i) => { u[v] = save[i]; });
      s /= 2;
    }
    if (!ok) break;
  }
  return { u, err, iterations: it, converged: err <= tol };
}

/* ---------- ② 内点流 + 外圆拟合 ---------- */

/**
 * 边界半径（u 里的边界分量）固定，只调内点，把内点曲率压到 0。
 * u 原地修改 —— 上一次的解就是这一次的初值（打靶每步只挪一点点，热启动快很多）。
 * @returns {{iterations:number, err:number}}
 */
function solveInterior(mesh, u, interior, { maxIter = 300, tol = 1e-14 } = {}) {
  tangencyLengths(mesh, u);
  const m = interior.length;
  if (!m) return { iterations: 0, err: 0 };
  const Kint = () => { const K = mesh.curvature(); return interior.map((v) => K[v]); };
  const errOf = () => Math.max(...Kint().map(Math.abs));
  let err = errOf(), it = 0;
  for (; it < maxIter && err > tol; it++) {
    const K = Kint();
    const J = [];
    for (let i = 0; i < m; i++) J.push(new Array(m).fill(0));
    for (let j = 0; j < m; j++) {
      const h = 1e-7;
      u[interior[j]] += h;
      tangencyLengths(mesh, u);
      const K2 = Kint();
      u[interior[j]] -= h;
      for (let i = 0; i < m; i++) J[i][j] = (K2[i] - K[i]) / h;
    }
    tangencyLengths(mesh, u);
    let d;
    try {
      d = solveLU(J, K.map((x) => -x));
    } catch { break; }
    let s = 1, ok = false;
    for (let ls = 0; ls < 40; ls++) {
      const save = interior.map((v) => u[v]);
      interior.forEach((v, i) => { u[v] += s * d[i]; });
      tangencyLengths(mesh, u);
      const e2 = errOf();
      if (e2 < err || e2 <= tol) { err = e2; ok = true; break; }
      interior.forEach((v, i) => { u[v] = save[i]; });
      tangencyLengths(mesh, u);
      s /= 2;
    }
    if (!ok) break;
  }
  tangencyLengths(mesh, u);
  return { iterations: it, err };
}

/**
 * 纯几何：给定一组边界圆 [[x, y, r]]，求圆心 o 使 h_i = |o − p_i| + r_i 的**方差**最小。
 * 外圆半径 R = mean(h)，残差 e_i = h_i − R。
 * max|e| = 0 ⟺ 所有边界圆内切于同一个外圆（这就是「极大」的判据）。
 */
function fitCircle(circles, oInit = null) {
  const k = circles.length;
  const hOf = (o) => circles.map((p) => Math.hypot(o[0] - p[0], o[1] - p[1]) + p[2]);
  const V = (o) => {
    const h = hOf(o);
    const m = h.reduce((s, x) => s + x, 0) / k;
    return h.reduce((s, x) => s + (x - m) * (x - m), 0) / k;
  };
  let o = oInit ? [oInit[0], oInit[1]]
    : [circles.reduce((s, p) => s + p[0], 0) / k, circles.reduce((s, p) => s + p[1], 0) / k];
  for (let it = 0; it < 120; it++) {
    const s0 = 1e-7 * Math.max(1, Math.abs(o[0]) + Math.abs(o[1]));
    const g = [0, 0], H = [[0, 0], [0, 0]];
    for (let i = 0; i < 2; i++) {
      const fp = [o[0], o[1]], fm = [o[0], o[1]];
      fp[i] += s0; fm[i] -= s0;
      g[i] = (V(fp) - V(fm)) / (2 * s0);
      for (let j = 0; j < 2; j++) {
        const pp = [o[0], o[1]], pm = [o[0], o[1]], mp = [o[0], o[1]], mm = [o[0], o[1]];
        pp[i] += s0; pp[j] += s0; pm[i] += s0; pm[j] -= s0;
        mp[i] -= s0; mp[j] += s0; mm[i] -= s0; mm[j] -= s0;
        H[i][j] = (V(pp) - V(pm) - V(mp) + V(mm)) / (4 * s0 * s0);
      }
    }
    const det = H[0][0] * H[1][1] - H[0][1] * H[1][0];
    if (!Number.isFinite(det) || Math.abs(det) < 1e-300) break;
    const d = [-(H[1][1] * g[0] - H[0][1] * g[1]) / det, -(-H[1][0] * g[0] + H[0][0] * g[1]) / det];
    let st = 1, moved = false;
    for (let ls = 0; ls < 40; ls++) {
      const o2 = [o[0] + st * d[0], o[1] + st * d[1]];
      if (V(o2) < V(o)) { o = o2; moved = true; break; }
      st /= 2;
    }
    if (!moved) break;
  }
  const h = hOf(o);
  const R = h.reduce((s, x) => s + x, 0) / k;
  const e = h.map((x) => x - R);
  return { o, R, e, dev: Math.max(...e.map(Math.abs)) };
}

/* ---------- ③ Aut(D) 规范固定 ---------- */

/**
 * 圆在 Möbius 变换 w = (z − a)/(1 − ā z) 下的像。
 *
 * 注意：Möbius 变换**不**把圆心映到圆心（圆心像 ≠ 像的圆心），必须用完整的「圆 → 圆」公式：
 *   圆 |z − c| = ρ 的像满足 A|w|² + E w + Ē w̄ + C = 0，
 *   A = |1 − ā c|² − ρ²|a|²，E 见下（共轭项很容易写错正负号），Δ = |c|² − ρ²。
 *   圆心 c' = −Ē/A；半径用稳定式 ρ' = ρ(1 − |a|²)/A（避开 |c'|² − C/A 的相消）。
 *
 * 这个公式拿「三点定圆」做过独立验证：30 万组随机构型下圆心/半径最大绝对误差 1.2e-10。
 */
export function imageCircle(c, rho, a) {
  const sa = a[0] * a[0] + a[1] * a[1];                 // |a|²
  const re_ac = a[0] * c[0] + a[1] * c[1];              // Re(ā c)
  const A = 1 - 2 * re_ac + sa * (c[0] * c[0] + c[1] * c[1]) - rho * rho * sa;
  const D = c[0] * c[0] + c[1] * c[1] - rho * rho;      // Δ
  const a2 = [a[0] * a[0] - a[1] * a[1], 2 * a[0] * a[1]];
  const cba2 = [c[0] * a2[0] + c[1] * a2[1], c[0] * a2[1] - c[1] * a2[0]];   // c̄·a²
  const s = 1 + D;
  return {
    c: [(cba2[0] - s * a[0] + c[0]) / A, (cba2[1] - s * a[1] + c[1]) / A],
    rho: rho * (1 - sa) / A,
  };
}

/**
 * 边界半径的极差比 max/min（对整体缩放不变；用对数算，数值上更稳）。
 * 这就是规范固定的目标：在 Aut(D) 里把它压到最小。
 */
function boundarySpread(rho, bnd, z, a) {
  let lo = Infinity, hi = -Infinity;
  for (const i of bnd) {
    const t = Math.log(imageCircle(z[i], rho[i], a).rho);
    if (t < lo) lo = t;
    if (t > hi) hi = t;
  }
  return hi - lo;
}

/**
 * 在 Aut(D)（w = (z − a)/(1 − ā z)）里挑一个把**边界半径的极差比压到最小**的变换。
 *
 * 先用极坐标网格（半径 40 档 × 角 120 档）撒一遍，再以最优点为中心逐轮缩小窗口
 * （每轮 21 × 31 点，共 3 轮）细扫，最后坐标下降 + 步长减半 —— 目标函数是一族
 * 圆周的 min/max，不光滑（最小半径会在不同的圆之间跳），粗网格 + 局部搜索容易停在
 * 假的平台上（实测：只做粗网格，美国的最小半径比停在 817 而真值约 762）。
 *
 * @param {number[][]} pos 圆心（用 o、R 归一到单位圆）
 * @returns {{a:number[], spread0:number, spread1:number, min0:number, min1:number,
 *            ratio0:number, ratio1:number}}
 */
export function rebalanceDisk(pos, r, o, R, bnd, { maxA = 0.999 } = {}) {
  const z = pos.map((p) => [(p[0] - o[0]) / R, (p[1] - o[1]) / R]);
  const rho = r.map((x) => x / R);
  const minRho = (a) => {
    let mn = Infinity;
    for (const i of bnd) mn = Math.min(mn, imageCircle(z[i], rho[i], a).rho);
    return mn;
  };
  let best = { a: [0, 0], v: boundarySpread(rho, bnd, z, [0, 0]), s: 0, th: 0 };
  // 逐轮细扫：每一轮扫完，把窗口中心挪到该轮最优点，窗口尺寸缩到 1/12
  let sC = 0, thC = 0, sSpan = maxA, thSpan = Math.PI;
  for (let rd = 0; rd < 3; rd++) {
    const nS = rd === 0 ? 40 : 20, nT = rd === 0 ? 120 : 30;
    for (let si = -nS; si <= nS; si++) {
      const s = sC + sSpan * si / nS;
      if (s < 0 || s >= maxA) continue;
      for (let ai = 0; ai < nT; ai++) {
        const th = thC + thSpan * (2 * ai / nT - 1);
        const a = [s * Math.cos(th), s * Math.sin(th)];
        const v = boundarySpread(rho, bnd, z, a);
        if (v < best.v) best = { a, v, s, th };
      }
    }
    sC = best.s; thC = best.th;
    sSpan /= 12; thSpan /= 12;
  }
  let step = 0.01;
  for (let it = 0; it < 600; it++) {
    let improved = false;
    for (const d of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const a = [best.a[0] + step * d[0], best.a[1] + step * d[1]];
      if (Math.hypot(a[0], a[1]) >= maxA) continue;
      const v = boundarySpread(rho, bnd, z, a);
      if (v < best.v) { best = { a, v }; improved = true; }
    }
    if (!improved) { step /= 2; if (step < 1e-12) break; }
  }
  return {
    a: best.a,
    spread0: boundarySpread(rho, bnd, z, [0, 0]), spread1: best.v,
    min0: minRho([0, 0]), min1: minRho(best.a),
    ratio0: Math.exp(boundarySpread(rho, bnd, z, [0, 0])),
    ratio1: Math.exp(best.v),
  };
}

/* ---------- 主入口 ---------- */

/**
 * 圆盘填充。两种边界条件（见文件头的长注释），默认的是与方块填充同一套目标曲率的那个。
 *
 * @param {Mesh} mesh
 * @param {{mode?:'angles'|'maximal'}} opts
 *        'angles'（默认）= 4 个角点各 90°、墙点各 180°、内点各 360°，外框是矩形；
 *        'maximal'       = 极大填充（所有边界圆内切于同一个外圆），角点角度不受约束。
 *        其余选项原样透传给对应的实现。
 */
export function circlePack(mesh, opts = {}) {
  const mode = opts.mode || 'angles';
  if (mode === 'maximal') return circlePackMaximal(mesh, opts);
  if (mode === 'angles') return circlePackAngles(mesh, opts);
  throw new Error(`circlePack：未知 mode「${mode}」`);
}

/**
 * 极大填充（Koebe–Andreev–Thurston 边界条件）：外圆 + 球面流 + 外圆打靶 + 规范固定。
 *
 * 会改 mesh.len（结束时留下与返回的 pos/r 一致的相切度量，所以之后自己调 develop(mesh)
 * 也能得到同一个填充，只差一个刚体运动）。
 *
 * @param {Mesh} mesh 圆盘三角剖分（2-连通、内面全是三角形）
 * @param {{maxOuter?:number, tol?:number, gauge?:boolean, sphereTol?:number}} opts
 * @returns {{pos:number[][], r:Float64Array, u:Float64Array, o:number[], R:number,
 *            e:number[], dev:number, steps:number, obj:number, stages:object,
 *            ratio:number, ratio0:number, gauge:object|null, ms:number, note:string}}
 */
export function circlePackMaximal(mesh, opts = {}) {
  const { maxOuter = 60, tol = 1e-12, gauge = true, sphereTol = 1e-13, diagnostics = false } = opts;
  const diag = diagnostics;
  const t0 = Date.now();
  const nv = mesh.nv;
  const bnd = mesh.boundary;              // 外面走的是 CW —— 画图、出数都用这个次序
  const ccw = bnd.slice().reverse();      // 扇面要用 CCW 圈
  const k = ccw.length;

  // ---- ① 球面流：k 个边界点均分 4π ----
  const S = sphereSetup(nv, mesh.faces, ccw);
  const target = new Float64Array(S.N);
  for (const v of ccw) target[v] = 4 * Math.PI / k;
  target[S.inf] = 0;
  const stage1 = solveSphere(S, target, { tol: sphereTol });
  const t1 = Date.now();

  const u = new Float64Array(nv);
  const interior = [];
  for (let v = 0; v < nv; v++) if (!mesh.isBoundaryVert[v]) interior.push(v);
  for (const v of bnd) u[v] = stage1.u[v];
  const ubar = bnd.reduce((s, v) => s + u[v], 0) / k;
  for (const v of interior) u[v] = ubar;   // 内点初值：取边界平均半径

  // ---- ② 外圆打靶 ----
  // evalRho：给定边界 log 半径，把内点流到 K = 0，再铺展 + 拟合外圆。
  // 拟合**每次**都从边界圆心的重心出发（不用上一次的解热启动）：半径跨度很大时 V(o)
  // 有多个局部极小，热启动会让不同调用落进不同的坑里，打靶就停在假解上
  // （实测美国会停在外圆残差 1.7e-3 不动）。
  const evalRho = (p) => {
    for (let i = 0; i < k; i++) u[bnd[i]] = p[i];
    const inner = solveInterior(mesh, u, interior);
    const { pos } = develop(mesh);
    const r = new Float64Array(nv);
    for (let v = 0; v < nv; v++) r[v] = Math.exp(u[v]);
    const fit = fitCircle(bnd.map((v) => [pos[v][0], pos[v][1], r[v]]));
    return { u: u.slice(), pos, r, fit, inner };
  };

  const rho = new Float64Array(k);
  bnd.forEach((v, i) => { rho[i] = u[v]; });
  let cur = evalRho(rho.slice());
  let res = cur.fit.e;
  let obj = Math.max(...res.map(Math.abs));
  const innerIters = [cur.inner.iterations];
  let steps = 0;
  for (; steps < maxOuter && obj > tol; steps++) {
    // Gauss–Newton：残差对「边界 log 半径」的 Jacobian；第 0 个分量当整体缩放，钉住不动。
    const m = k - 1;
    const J = [];
    for (let i = 0; i < k; i++) J.push(new Array(m).fill(0));
    const h = 1e-6;
    for (let j = 1; j < k; j++) {
      const p = rho.slice();
      p[j] += h;
      const { fit, inner } = evalRho(p);
      innerIters.push(inner.iterations);
      for (let i = 0; i < k; i++) J[i][j - 1] = (fit.e[i] - res[i]) / h;
    }
    const G = new Array(m).fill(0);
    const H = [];
    for (let a = 0; a < m; a++) H.push(new Array(m).fill(0));
    for (let i = 0; i < k; i++) {
      for (let a = 0; a < m; a++) {
        G[a] += J[i][a] * res[i];
        for (let b = 0; b < m; b++) H[a][b] += J[i][a] * J[i][b];
      }
    }
    for (let a = 0; a < m; a++) H[a][a] += 1e-10 * (H[a][a] || 1);   // Tikhonov
    let d;
    try {
      d = solveLU(H, G.map((x) => -x));
    } catch { break; }
    let s = 1, ok = false;
    for (let ls = 0; ls < 40; ls++) {
      const p = rho.slice();
      for (let j = 1; j < k; j++) p[j] += s * d[j - 1];
      const cand = evalRho(p);
      innerIters.push(cand.inner.iterations);
      const o2 = Math.max(...cand.fit.e.map(Math.abs));
      if (o2 < obj) { rho.set(p); res = cand.fit.e; cur = cand; obj = o2; ok = true; break; }
      s /= 2;
    }
    if (!ok) break;      // 线搜索失败：外圆残差到了它在这个相切类里的下限
  }
  const t2 = Date.now();

  // ---- 诊断（可选）：解处「外圆残差对边界 log 半径」的 Jacobian 的奇异值 ----
  // 残差在 Aut(D) 轨道上不变，所以零空间至少包含「会改半径」的那 2 维（旋转不改半径）。
  // 实测零空间维数**恰好是 2** ⟹ 过这个解的极大填充族就是它的 Aut(D) 轨道，
  // 于是「轨道上最小的边界半径比」是这张三角剖分的规范量（README 里美国那个 754 就是它）。
  let svs = null;
  if (diag && k > 5) {
    const m = k - 1;
    const J = [];
    for (let i = 0; i < k; i++) J.push(new Array(m).fill(0));
    for (let j = 1; j < k; j++) {
      const p = rho.slice();
      p[j] += 1e-6;
      const { fit } = evalRho(p);
      for (let i = 0; i < k; i++) J[i][j - 1] = (fit.e[i] - res[i]) / 1e-6;
    }
    const M = [];
    for (let a = 0; a < m; a++) M.push(new Array(m).fill(0));
    for (let a = 0; a < m; a++) {
      for (let b = 0; b < m; b++) {
        let s = 0;
        for (let i = 0; i < k; i++) s += J[i][a] * J[i][b];
        M[a][b] = s;
      }
    }
    svs = jacobiEigenvalues(M).map((x) => Math.sqrt(Math.max(0, x))).sort((x, y) => y - x);
    const back = evalRho(rho.slice());      // 诊断会动 u / mesh.len，恢复收敛态
    cur = back; res = back.fit.e;
  }

  // ---- ③ 收敛后规范固定 ----
  const ratio0 = boundaryRatio(cur.r, bnd);
  let out = {
    pos: cur.pos, r: cur.r, u: cur.u, o: cur.fit.o, R: cur.fit.R, e: cur.fit.e, dev: cur.fit.dev,
  };
  let gaugeInfo = null;
  // 只有外圆确实是真圆时（残差够小），Aut(D) 才真的是规范变换 —— 否则不做。
  if (gauge && obj <= 1e-9) {
    const g = rebalanceDisk(cur.pos, cur.r, cur.fit.o, cur.fit.R, bnd);
    const moved = moveCircles(cur.pos, cur.r, cur.fit.o, cur.fit.R, g.a);
    // Aut(D) 保外圆，所以搬完之后边界圆仍内切于同一个外圆（这里重拟合一次拿回 o/R）
    const fit2 = fitCircle(bnd.map((v) => [moved.pos[v][0], moved.pos[v][1], moved.r[v]]), cur.fit.o);
    out = { pos: moved.pos, r: moved.r, o: fit2.o, R: fit2.R, e: fit2.e, dev: fit2.dev };
    gaugeInfo = {
      a: g.a, absA: Math.hypot(g.a[0], g.a[1]),
      minBefore: g.min0, minAfter: g.min1,
      ratioBefore: ratio0, ratioAfter: boundaryRatio(moved.r, bnd),
    };
  }
  const t3 = Date.now();

  // 留下与最终 pos/r 一致的相切度量（规范固定后仍是同一个相切类，故 develop(mesh) 同样成立）。
  out.u = Float64Array.from(out.r, Math.log);
  tangencyLengths(mesh, out.u);
  const ratio = maxOf(out.r) / minOf(out.r);

  const note = obj <= tol
    ? `极大填充：外圆残差 ${obj.toExponential(2)}（= 0 ⟺ 所有边界圆内切于同一个外圆）`
    : steps >= maxOuter
      ? `外圆打靶到上限 ${maxOuter} 步仍未到 tol（残差 ${obj.toExponential(2)}）`
      : `外圆打靶停在残差 ${obj.toExponential(2)}（第 ${steps} 步线搜索失败）`;

  return {
    mode: 'maximal',
    pos: out.pos, r: out.r, u: out.u, o: out.o, R: out.R, e: out.e, dev: out.dev,
    steps, obj, ratio, ratio0, ratioBoundary: boundaryRatio(out.r, bnd),
    gauge: gaugeInfo, svs,
    stages: {
      sphere: { iterations: stage1.iterations, err: stage1.err, converged: stage1.converged, ms: t1 - t0 },
      shoot: { steps, ms: t2 - t1, configs: innerIters.length },
      gaugeMs: t3 - t2,
    },
    ms: t3 - t0,
    note,
  };
}

/** Jacobi 特征值（对称矩阵，只用来数零空间维数，诊断用）。*/
function jacobiEigenvalues(M) {
  const n = M.length;
  const A = M.map((r) => r.slice());
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += A[p][q] * A[p][q];
    if (off < 1e-24) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(A[p][q]) < 1e-18) continue;
        const th = 0.5 * Math.atan2(2 * A[p][q], A[q][q] - A[p][p]);
        const c = Math.cos(th), s = Math.sin(th);
        for (let i = 0; i < n; i++) {
          const a1 = A[i][p], a2 = A[i][q];
          A[i][p] = c * a1 - s * a2; A[i][q] = s * a1 + c * a2;
        }
        for (let i = 0; i < n; i++) {
          const a1 = A[p][i], a2 = A[q][i];
          A[p][i] = c * a1 - s * a2; A[q][i] = s * a1 + c * a2;
        }
      }
    }
  }
  return A.map((r, i) => r[i]);
}

/** 把整组圆（圆心 + 半径）按 w = (z − a)/(1 − ā z) 搬一次（外圆归一到单位圆再搬）。*/
function moveCircles(pos, r, o, R, a) {
  const pos2 = new Array(pos.length);
  const r2 = new Float64Array(pos.length);
  for (let i = 0; i < pos.length; i++) {
    const im = imageCircle([(pos[i][0] - o[0]) / R, (pos[i][1] - o[1]) / R], r[i] / R, a);
    pos2[i] = [o[0] + R * im.c[0], o[1] + R * im.c[1]];
    r2[i] = R * im.rho;
  }
  return { pos: pos2, r: r2 };
}

/**
 * 逐对审计：图上每条边必须**正好**相切；非边一颗都不许相切、更不许重叠。
 * @param {?{o:number[], R:number}} outer 给了就一并查「所有圆都在同一个外圆内、
 *        且所有边界圆都内切于它」（boundaryRing 是边界圆到外圆距离的极差，= 0 即全内切）
 */
export function auditPacking(mesh, pos, r, outer = null) {
  const nv = mesh.nv;
  let overlaps = 0, extraTangencies = 0, maxEdgeErr = 0;
  let minGap = Infinity, minGapPair = null;
  let tangentPairs = 0, checked = 0;
  const isEdge = (a, b) => mesh.edgeOf.has(mesh.edgeKey(a, b));
  for (let i = 0; i < nv; i++) {
    for (let j = i + 1; j < nv; j++) {
      const g = Math.hypot(pos[i][0] - pos[j][0], pos[i][1] - pos[j][1]) - (r[i] + r[j]);
      checked++;
      if (isEdge(i, j)) {
        maxEdgeErr = Math.max(maxEdgeErr, Math.abs(g));
        if (Math.abs(g) < 1e-9) tangentPairs++;
      } else {
        if (g < -1e-9) overlaps++;
        if (Math.abs(g) < 1e-9) extraTangencies++;
        if (g < minGap) { minGap = g; minGapPair = [i, j]; }
      }
    }
  }
  const out = {
    pairsChecked: checked, tangentPairs, maxEdgeErr,
    overlaps, extraTangencies, minGap, minGapPair,
  };
  if (outer) {
    let worst = -Infinity, worstV = -1;
    for (let v = 0; v < nv; v++) {
      const d = Math.hypot(pos[v][0] - outer.o[0], pos[v][1] - outer.o[1]) + r[v] - outer.R;
      if (d > worst) { worst = d; worstV = v; }
    }
    out.outsideOuter = worst;
    out.outsideOuterV = worstV;
    let lo = Infinity, hi = -Infinity;
    for (const v of mesh.boundary) {
      const t = Math.hypot(pos[v][0] - outer.o[0], pos[v][1] - outer.o[1]) + r[v];
      if (t < lo) lo = t; if (t > hi) hi = t;
    }
    out.boundaryRing = hi - lo;      // 边界圆到外圆的偏差带（= 0 ⟹ 全部内切）
  }
  return out;
}
