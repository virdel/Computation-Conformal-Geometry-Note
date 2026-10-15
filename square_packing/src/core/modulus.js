// 独立的共形模交叉验证：不用 Ricci 流，直接解一次 Laplace 方程。
//
// 四边形 (D; c0,c1,c2,c3) 的共形模 M = W/H，等于调和函数 u（在 (c0,c1) 上 0、
// 在 (c3,c2) 上 1）的 Dirichlet 能量：M = ∫_D |∇u|²。
// 做法：把参数正方形细分成 N×N 网格，经双线性映射铺到四边形上（四边形是
// 直边，双线性映射正好铺满），固定 u（t=0 上 0、t=1 上 1），解 FEM 系统，
// 用余切 Laplacian 算能量。N→∞ 时收敛到真正的共形模。
//
// 这条路径和主体流程（Ricci 流 + 铺展）完全不同，所以是有意义的交叉验证。

import { Mesh } from './mesh.js';
import { solveLU, zeros } from './linalg.js';

/** 双线性映射：单位正方形 (s,t) → 四边形。*/
function bilinear(quad, s, t) {
  const [c0, c1, c2, c3] = quad;
  const w00 = (1 - s) * (1 - t), w10 = s * (1 - t), w11 = s * t, w01 = (1 - s) * t;
  return [
    w00 * c0[0] + w10 * c1[0] + w11 * c2[0] + w01 * c3[0],
    w00 * c0[1] + w10 * c1[1] + w11 * c2[1] + w01 * c3[1],
  ];
}

/**
 * @param {number[][]} quad 4 个角点（凸、逆时针）
 * @param {number} N 每边细分数
 * @returns {{modulus:number, energy:number, nv:number, nf:number, h:number}}
 */
export function quadModulus(quad, N = 40) {
  const idx = (i, j) => i * (N + 1) + j;
  const nv = (N + 1) * (N + 1);
  const verts = new Array(nv);
  for (let i = 0; i <= N; i++) {
    for (let j = 0; j <= N; j++) {
      verts[idx(i, j)] = bilinear(quad, i / N, j / N);
    }
  }
  const faces = [];
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      faces.push([idx(i, j), idx(i + 1, j), idx(i + 1, j + 1)]);
      faces.push([idx(i, j), idx(i + 1, j + 1), idx(i, j + 1)]);
    }
  }
  const mesh = new Mesh(verts, faces);

  // 固定值：t=0 → 0，t=1 → 1
  const fixed = new Float64Array(nv).fill(NaN);
  for (let i = 0; i <= N; i++) { fixed[idx(i, 0)] = 0; fixed[idx(i, N)] = 1; }

  const free = [], pos = new Int32Array(nv).fill(-1);
  for (let v = 0; v < nv; v++) if (Number.isNaN(fixed[v])) { pos[v] = free.length; free.push(v); }
  const n = free.length;

  const L = mesh.cotanLaplacian();
  const A = zeros(n);
  const b = new Array(n).fill(0);
  for (let r = 0; r < n; r++) {
    const v = free[r];
    for (let w = 0; w < nv; w++) {
      if (w === v || L[v][w] === 0) continue;
      if (Number.isNaN(fixed[w])) A[r][pos[w]] += L[v][w];   // L 里已经是负权重
      else b[r] -= L[v][w] * fixed[w];
    }
    A[r][r] = L[v][v];
  }
  const uf = solveLU(A, b);
  const u = Float64Array.from(fixed);
  free.forEach((v, r) => { u[v] = uf[r]; });

  // Dirichlet 能量 ½ uᵀLu = ½ Σ_{i,j} L_ij u_i u_j（L_ij = −w_ij，i≠j）
  let E = 0;
  for (let v = 0; v < nv; v++) {
    for (let w = v + 1; w < nv; w++) {
      const a = L[v][w];
      if (a === 0) continue;
      E += -a * (u[v] - u[w]) * (u[v] - u[w]);
    }
  }
  E /= 2;

  return { modulus: E, energy: E, nv, nf: faces.length, h: 1 / N };
}

/** 网格细化序列，用来看收敛（应稳定）。*/
export function modulusSequence(quad, sizes = [10, 20, 40, 80]) {
  return sizes.map((N) => ({ N, M: quadModulus(quad, N).modulus }));
}

/**
 * 和铺展框架对齐：把四边形旋转到「u=0 那一边 = (order[0], order[1])」，仍是逆时针。
 * cornersCCW[k] ↔ quad[k]（钉边界时的配对），order 是铺展用的角点逆时针圈
 * （两者方向一致，互为循环移位）。这样 quadModulus 给出的模才能和铺展出的 W/H 直接比。
 */
export function alignedQuad(quad, cornersCCW, order) {
  const at = new Map(cornersCCW.map((v, i) => [v, i]));
  const j0 = at.get(order[0]), j1 = at.get(order[1]);
  if (j0 === undefined || j1 === undefined) {
    throw new Error('alignedQuad: order 里有不在 cornersCCW 里的顶点');
  }
  const start = (j1 === (j0 + 1) % 4) ? j0 : j1;   // 取逆时针的那一段
  return [0, 1, 2, 3].map((k) => quad[(start + k) % 4]);
}

/** 直接给出和某次铺展可比的模。*/
export function modulusOfOrder(quad, cornersCCW, order, N = 60) {
  return quadModulus(alignedQuad(quad, cornersCCW, order), N).modulus;
}
