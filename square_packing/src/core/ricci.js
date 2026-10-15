// 离散 Ricci / Yamabe 流：把度量共形变形到「4 个角点 π/2、其余点曲率 0」的平直度量。
//
// 度量族：l_ij = l̄_ij · e^{(u_i + u_j)/2}   （l̄ = 输入图的边长，即背景度量）
// 曲率：  K_i = 2π − Σθ （内点） / π − Σθ （边界点）
//
// Newton 迭代：对离散 Yamabe 能量求导给出
//      dK = −½ L du        L = 余切 Laplacian (PSD)
// 于是每步解      L du = −2 (K − K̄)      （去掉一个自由度：钉住 u_pin = 0）
// 再回溯线搜索保证 max|K − K̄| 下降。
// Gauss–Bonnet 保证 ΣK = 2π = 4·(π/2)，所以目标曲率是自洽的。

import { solveLU } from './linalg.js';

/** 由 u 写出边长（并刷新角度，之后 curvature() 才是新的）。*/
export function lengthsFromU(mesh, u, out = mesh.len) {
  for (let e = 0; e < mesh.ne; e++) {
    const [a, b] = mesh.edges[e];
    out[e] = mesh.background[e] * Math.exp((u[a] + u[b]) / 2);
  }
  mesh.refreshAngles();
  return out;
}

function maxAbsDiff(x, y) {
  let m = 0;
  for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(x[i] - y[i]));
  return m;
}

/** 违反三角不等式（退化）的面数。*/
export function badTriangles(mesh) {
  let bad = 0;
  for (let f = 0; f < mesh.nf; f++) {
    const t = mesh.faces[f];
    const l = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      l[i] = mesh.len[mesh.edgeOf.get(mesh.edgeKey(t[i], t[(i + 1) % 3]))];
    }
    const eps = 1e-12 * (l[0] + l[1] + l[2]);
    if (!(l[0] + l[1] > l[2] + eps && l[1] + l[2] > l[0] + eps && l[2] + l[0] > l[1] + eps)) bad++;
  }
  return bad;
}

/**
 * 跑流。
 * @param {Mesh} mesh
 * @param {{corners:number[], tol?:number, maxIter?:number, onIter?:Function}} opts
 * @returns {{u:Float64Array, K:Float64Array, Kbar:Float64Array, err:number,
 *            iterations:number, converged:boolean, stalled:boolean, note:string,
 *            history:{iter:number,err:number,t:number,note?:string}[], pin:number}}
 */
export function ricciFlow(mesh, opts = {}) {
  const { corners, tol = 1e-11, maxIter = 200, onIter } = opts;
  if (!corners || corners.length !== 4) throw new Error('ricciFlow: 需要 4 个角点');
  const nv = mesh.nv;
  const Kbar = mesh.targetCurvature(corners);
  const pin = corners[0];

  const u = new Float64Array(nv);
  mesh.resetLengths();

  const history = [];
  let err = maxAbsDiff(mesh.curvature(), Kbar);
  let converged = err < tol;
  let note = converged ? '初始度量已经是目标度量' : '';

  const idx = [];             // 非 pin 的顶点
  for (let v = 0; v < nv; v++) if (v !== pin) idx.push(v);
  const m = idx.length;
  const pos = new Int32Array(nv).fill(-1);
  idx.forEach((v, i) => { pos[v] = i; });
  const uTrial = new Float64Array(nv);

  let iter = 0;
  let stalled = false;
  for (; iter < maxIter && !converged; iter++) {
    const K = mesh.curvature();

    // 组装 Newton 系统 L du = 2 (K̄ − K)，去掉 pin 行列
    const L = mesh.cotanLaplacian();
    const A = new Array(m);
    for (let i = 0; i < m; i++) A[i] = new Array(m).fill(0);
    const rhs = new Array(m).fill(0);
    for (let i = 0; i < m; i++) {
      const vi = idx[i];
      for (let j = 0; j < m; j++) A[i][j] = L[vi][idx[j]];
      rhs[i] = 2 * (Kbar[vi] - K[vi]);
    }
    let du;
    try {
      du = solveLU(A, rhs);
    } catch (e) {
      history.push({ iter, err, t: 0, note: '奇异' });
      note = `第 ${iter} 步：余切 Laplacian 奇异，解不出 Newton 方向`;
      stalled = true;
      break;
    }

    // 回溯线搜索
    let t = 1, accepted = false, errNew = err;
    for (let ls = 0; ls < 50; ls++) {
      uTrial.set(u);
      for (let i = 0; i < m; i++) uTrial[idx[i]] = u[idx[i]] + t * du[i];
      lengthsFromU(mesh, uTrial);
      if (badTriangles(mesh) === 0) {
        errNew = maxAbsDiff(mesh.curvature(), Kbar);
        if (errNew < err || errNew < tol) { accepted = true; break; }
      }
      t /= 2;
    }
    if (!accepted) {
      history.push({ iter, err, t: 0, note: '线搜索失败' });
      // 退回上一步的度量
      lengthsFromU(mesh, u);
      note = `第 ${iter} 步线搜索失败（max|K−K̄| = ${err.toExponential(2)}）：`
        + '沿 Newton 方向找不到下降 —— 这个剖分在当前离散共形类里到不了目标度量'
        + '（离散共形类里的平直度量可能落在需要翻边的剖分上）。';
      stalled = true;
      break;
    }
    u.set(uTrial);
    lengthsFromU(mesh, u);
    history.push({ iter, err, t, errNew });
    err = errNew;
    converged = err < tol;
    if (onIter) onIter({ iter, err, t });
  }

  mesh.refreshAngles();
  if (!converged && !stalled) note = `迭代到上限 ${maxIter} 次仍未到 tol（max|K−K̄| = ${err.toExponential(2)}）`;
  if (converged) {
    note = history.length === 0
      ? '初始度量已经满足目标曲率（流不需要动）'
      : `收敛：${history.length} 步，max|K−K̄| = ${err.toExponential(2)}`;
  }
  return {
    u, K: mesh.curvature(), Kbar, err,
    iterations: iter, converged, stalled, note, history, pin,
  };
}

/** 角点处的实际角度（应该都是 π/2）。*/
export function cornerAngles(mesh, corners) {
  const sum = mesh.angleSums();
  return corners.map((v) => sum[v]);
}
