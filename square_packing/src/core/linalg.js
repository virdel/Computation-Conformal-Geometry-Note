// 稠密线性代数：够用就好（n 很小，几十到几百）。
// 整个项目只用两处：Tutte 初始嵌入、Ricci 流的 Newton 步。

/** 部分主元高斯消元解 A x = b。A: number[][] (n×n)，b: number[] (n)。*/
export function solveLU(A, b) {
  const n = A.length;
  const M = new Array(n);
  for (let i = 0; i < n; i++) M[i] = A[i].slice().concat([b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-300) throw new Error('solveLU: 矩阵奇异');
    if (p !== c) { const t = M[p]; M[p] = M[c]; M[c] = t; }
    const piv = M[c][c];
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / piv;
      if (f === 0) continue;
      const Mr = M[r], Mc = M[c];
      for (let k = c; k <= n; k++) Mr[k] -= f * Mc[k];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x;
}

/** 生成 n×n 零矩阵（行优先数组的数组）。*/
export function zeros(n, m = n) {
  const A = new Array(n);
  for (let i = 0; i < n; i++) A[i] = new Array(m).fill(0);
  return A;
}

/** 把稀疏三元组累加进稠密矩阵。*/
export function addTo(A, i, j, v) { A[i][j] += v; }

export const norm2 = (x) => Math.hypot(x[0], x[1]);
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
export const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
export const mul = (a, s) => [a[0] * s, a[1] * s];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
export const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
