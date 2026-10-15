// 用户从文件导入一张图 → 变成 pipeline 能直接吃的 preset。
//
// 两条入口：
//   parseGraphFile(text)   纯文本 → {nv, edges, faces?, boundary?, corners?, pos?, names?}
//   graphToPreset(graph)   那张图 → preset（含自动修补的账、自动选的角点）
//
// 后面的流水线（buildInputMesh / runPipeline / circlePack）只认 preset
// （{id, name, nv, faces, corners?, quad?}），所以四个视图组件一行都不用改。
//
// ---- 怎么从一张边表把「面」和「外圈」恢复出来 ----
//
// 情形 A：文件给了 JSON 的 faces —— 直接用（只把朝向传播一致）。最精确。
// 情形 B：文件声明了 # boundary: —— 按声明的外圈做调和嵌入 + 面游走，拿到面圈；
//         适合**一般平面图**（面不是三角形时也能知道哪个面是哪几个点围的）。
// 情形 C：什么都没给 —— 按 3-团法：对圆盘三角剖分，
//         「3-团 = 面（∪ 分离三角形）」、「只属于一个 3-团的边 = 外圈边」。
//         实测 10 张内建图逐条相等。
//
// 情形 B/C 之后如果还有 ≥ 4 边形，就三角化（团面加对角线；非团面插人工点），
// 一旦全是三角形，后面每一轮都可以只看 3-团 —— 修补也就变成了对**边集**的操作。
//
// ---- 修补阶梯（每一步都进 repairs[]，逐条公开）----
//
//   diagonal  团面（顶点两两相邻的 ≥ 4 边形，Four Corners 型）加对角线
//   steiner   非团面插一个**人工点**（顶点 kind='patch'，界面上是灰块）
//   merge     内点度 < 4 / 外圈上多余的度 2 点 → 并入一个邻居（不丢任何相邻关系）
//   flip      分离三角形：删掉它一条内边、换成另一条对角线（标准翻边）
//   cut       球面三角剖分：沿一个**度 4 的顶点**剪开（删掉它，它的 link 变成外圈）
//
// 修不动的明确拒绝，并说清卡在哪一条。

import {
  embedOnBoundary, triangulateFaces, orientFaces, adjacencyFromEdges, cliques3, cliqueEdgeCount,
} from './diskbuild.js';
import { checkPTP, comb } from './ptp.js';
import { buildInputMesh, runPipeline, quadForPreset } from './pipeline.js';

const INT = /^-?\d+$/;
const NUM = /^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;

function parseNums(toks) {
  const out = [];
  for (const t of toks) {
    if (!NUM.test(t)) return null;
    out.push(Number(t));
  }
  return out;
}

/* ============================== 解析 ============================== */

function splitTokens(s) {
  return s.split(/[\s,;]+/).filter(Boolean);
}

function parseInts(toks) {
  const out = [];
  for (const t of toks) {
    if (!INT.test(t)) return null;
    out.push(Number(t));
  }
  return out;
}

/**
 * 解析一个图文件。JSON（首字符是 `{`）或边表，自动判别。
 *
 * @param {string} text
 * @param {{name?:string}} opts
 * @returns {{ok:boolean, problems:string[], graph:object|null}}
 *   graph = {nv, edges:[[a,b]], faces:number[][]|null, boundary:number[]|null,
 *            corners:[S,E,N,W]|null, pos:[[x,y]]|null, names:string[]|null,
 *            base:0|1, format:'json'|'edges', headerUsed:boolean, name, notes:string[]}
 */
export function parseGraphFile(text, opts = {}) {
  const problems = [];
  const notes = [];
  const fallbackName = opts.name || '导入的图';
  if (typeof text !== 'string' || !text.trim()) {
    return { ok: false, problems: ['文件是空的（一个字都没有）'], notes, graph: null };
  }
  const head = text.replace(/^﻿/, '').trimStart();
  let out;
  if (head.startsWith('{')) out = parseJSON(head, fallbackName, problems, notes);
  else out = parseEdgeList(text.replace(/^﻿/, ''), fallbackName, problems, notes);
  return { ok: problems.length === 0 && !!out, problems, notes, graph: out };
}

/* ---------- JSON 形式 ---------- */

function parseJSON(text, fallbackName, problems, notes) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    problems.push(`JSON 语法错：${e.message}`);
    return null;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    problems.push('JSON 的顶层必须是一个对象 {...}');
    return null;
  }
  const facesIn = obj.faces ?? null;
  const edgesIn = obj.edges ?? null;
  if (!facesIn && !edgesIn) problems.push('JSON 里既没有 faces 也没有 edges');

  let faces = null, edges = null;
  if (facesIn) {
    if (!Array.isArray(facesIn)) problems.push('faces 必须是数组');
    else {
      faces = [];
      facesIn.forEach((f, i) => {
        if (!Array.isArray(f) || f.length !== 3) {
          problems.push(`faces[${i}] 不是 3 个点：[${JSON.stringify(f)}]（faces 里只放**三角形内面**）`);
          return;
        }
        const v = parseInts(f.map(String));
        if (!v) { problems.push(`faces[${i}] 里有不是整数的东西：[${JSON.stringify(f)}]`); return; }
        faces.push(v);
      });
      if (!faces.length) faces = null;
    }
  }
  if (edgesIn) {
    if (!Array.isArray(edgesIn)) problems.push('edges 必须是数组');
    else {
      edges = [];
      edgesIn.forEach((e, i) => {
        if (!Array.isArray(e) || e.length !== 2) {
          problems.push(`edges[${i}] 不是一对点：[${JSON.stringify(e)}]`);
          return;
        }
        const v = parseInts(e.map(String));
        if (!v) { problems.push(`edges[${i}] 里有不是整数的东西：[${JSON.stringify(e)}]`); return; }
        edges.push(v);
      });
      if (!edges.length) edges = null;
    }
  }

  let boundary = null;
  if (obj.boundary != null) {
    const v = Array.isArray(obj.boundary) ? parseInts(obj.boundary.map(String)) : null;
    if (!v) problems.push('boundary 必须是整数数组');
    else if (v.length < 4) problems.push(`boundary 至少 4 个点（给了 ${v.length} 个）`);
    else boundary = v;
  }

  let corners = null;
  if (obj.corners != null) {
    const c = obj.corners;
    const arr = Array.isArray(c) ? parseInts(c.map(String))
      : (c && typeof c === 'object' && ['S', 'E', 'N', 'W'].every((k) => INT.test(String(c[k]))))
        ? ['S', 'E', 'N', 'W'].map((k) => Number(c[k])) : null;
    if (!arr) problems.push('corners 要么是 {S,E,N,W}，要么是 4 个整数的数组');
    else if (arr.length !== 4) problems.push(`corners 要 4 个点（给了 ${arr.length} 个）`);
    else corners = arr;
  }

  // 顶点数 + 下标基
  const refs = [...(edges || []), ...(faces || []), ...(boundary || []), ...(corners || [])].flat();
  const maxIdx = refs.length ? Math.max(...refs) : -1;
  let nv, base = 0;
  if (Number.isInteger(obj.nv)) {
    nv = obj.nv;
    if (maxIdx === nv) { base = 1; notes.push('下标看起来是 1 基（出现了等于 nv 的下标），已整体减 1'); }
    else if (maxIdx > nv) problems.push(`有下标 ${maxIdx} ≥ nv=${nv}（下标必须在 0 … nv−1）`);
  } else {
    nv = maxIdx + 1;
    if (!Number.isInteger(nv) || nv < 1) { problems.push('既没有 nv，也推算不出顶点数'); nv = 0; }
  }
  if (base === 1) {
    const sh = (v) => v - 1;
    if (edges) edges = edges.map(([a, b]) => [sh(a), sh(b)]);
    if (faces) faces = faces.map((f) => f.map(sh));
    if (boundary) boundary = boundary.map(sh);
    if (corners) corners = corners.map(sh);
  }

  // 坐标 / 名字（都只用于显示）
  let pos = null;
  if (obj.pos != null) {
    if (!Array.isArray(obj.pos) || obj.pos.length !== nv) {
      problems.push(`pos 要是 nv=${nv} 个 [x, y]`);
    } else if (!obj.pos.every((p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]))) {
      problems.push('pos 里有不是 [x, y] 的项');
    } else pos = obj.pos.map((p) => [p[0], p[1]]);
  }
  let names = null;
  if (obj.names != null) {
    if (!Array.isArray(obj.names) || obj.names.length !== nv) problems.push(`names 要是 nv=${nv} 个字符串`);
    else names = obj.names.map(String);
  }

  const name = typeof obj.name === 'string' && obj.name.trim() ? obj.name.trim() : fallbackName;
  if (base === 0 && refs.length && maxIdx >= 0 && nv === maxIdx + 1) notes.push('下标按 0 基解释');

  const graph = edges
    ? { nv, edges, faces, boundary, corners, pos, names, base, format: 'json', headerUsed: false, name, notes }
    : null;
  if (!edges) {
    // 只给了 faces：边从面里推
    const e = new Map();
    for (const f of faces || []) {
      for (let i = 0; i < 3; i++) {
        const a = f[i], b = f[(i + 1) % 3];
        e.set(a < b ? `${a},${b}` : `${b},${a}`, a < b ? [a, b] : [b, a]);
      }
    }
    return { nv, edges: [...e.values()], faces, boundary, corners, pos, names, base, format: 'json', headerUsed: false, name, notes };
  }
  return graph;
}

/* ---------- 边表形式 ---------- */

function parseEdgeList(text, fallbackName, problems, notes) {
  const dir = { corners: null, boundary: null, posSeq: [], posByV: new Map(), base: null, nvHdr: null, name: null };
  const raw = [];                                   // 数据行，每行一个 token 数组

  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith('#')) {
      const body = t.replace(/^#+\s*/, '');
      const m = /^([A-Za-z_][A-Za-z_0-9]*)\s*[:=]\s*(.*)$/.exec(body);
      if (!m) continue;                             // 纯注释
      const key = m[1].toLowerCase();
      const rest = m[2].trim();
      if (key === 'name') { dir.name = rest; continue; }
      if (key === 'pos') {
        // 坐标是实数（`# pos: v x y` 或 `# pos: x y`）—— 在走整数解析之前先接住
        const f = parseNums(splitTokens(rest));
        if (!f || (f.length !== 3 && f.length !== 2)) {
          problems.push(`# pos: 要「顶点 x y」或「x y」（写的是「${rest}」）`);
        } else if (f.length === 3) dir.posByV.set(f[0], [f[1], f[2]]);
        else dir.posSeq.push([f[0], f[1]]);
        continue;
      }
      if (key === 'base') {
        const v = parseInts(splitTokens(rest));
        if (!v || v.length !== 1 || (v[0] !== 0 && v[0] !== 1)) problems.push(`# base: 只能是 0 或 1（写的是「${rest}」）`);
        else dir.base = v[0];
        continue;
      }
      const v = parseInts(splitTokens(rest));
      if (!v) { problems.push(`# ${key}: 后面得是整数（写的是「${rest}」）`); continue; }
      if (key === 'corners') {
        if (v.length !== 4) problems.push(`# corners: 要 4 个点（写了 ${v.length} 个）`);
        else dir.corners = v;
      } else if (key === 'boundary') {
        if (v.length < 4) problems.push(`# boundary: 至少 4 个点（写了 ${v.length} 个）`);
        else dir.boundary = v;
      } else if (key === 'nv') {
        if (v.length !== 1 || v[0] < 1) problems.push(`# nv: 要一个正整数（写的是「${rest}」）`);
        else dir.nvHdr = v[0];
      }
      // 其它 `# 词: …` 当注释
      continue;
    }
    raw.push(splitTokens(t));
  }

  // 表头 `n m`：只在「第一行是两个整数、且第二个数正好等于剩下几行、且剩下的下标都放得进 n」时才认。
  let header = null, rest = raw;
  if (raw.length >= 2 && raw[0].length === 2) {
    const a = parseInts(raw[0]);
    if (a && rest2OK(raw.slice(1), a[0])) {
      const body = raw.slice(1);
      if (a[0] >= 3 && a[1] === body.length) { header = { n: a[0], m: a[1] }; rest = body; }
    }
  }

  const edges = [];
  rest.forEach((toks, i) => {
    const v = parseInts(toks);
    if (!v) { problems.push(`第 ${i + 1} 行不是整数：${toks.join(' ')}`); return; }
    if (v.length !== 2) { problems.push(`第 ${i + 1} 行不是一条边（要「u v」两个数）：${toks.join(' ')}`); return; }
    edges.push(v);
  });

  if (!edges.length) problems.push('文件里没有边（每行一条「u v」）');

  // 下标基
  const refs = [...edges.flat(), ...(dir.boundary || []), ...(dir.corners || [])];
  const maxIdx = refs.length ? Math.max(...refs) : -1;
  let nv, base;
  if (dir.base !== null) {
    base = dir.base;
    nv = dir.nvHdr ?? (header ? header.n : maxIdx + (base === 1 ? 0 : 1));
  } else if (dir.nvHdr) {
    nv = dir.nvHdr;
    base = (maxIdx === nv) ? 1 : 0;
  } else if (header) {
    nv = header.n;
    base = (maxIdx === nv) ? 1 : 0;               // PACE .gr 惯例：出现 n 就是 1 基
  } else {
    base = 0;
    nv = maxIdx + 1;
  }
  notes.push(base === 1 ? '下标按 1 基解释（出现了等于 nv 的下标），已整体减 1'
    : `下标按 0 基解释，nv = ${nv}${header ? '（首行 n m 当表头）' : ''}`);

  const lo = base === 1 ? 1 : 0;
  const hi = base === 1 ? nv : nv - 1;
  const bad = refs.filter((x) => x < lo || x > hi);
  if (bad.length) problems.push(`下标越界：${[...new Set(bad)].slice(0, 4).join(', ')} 不在 [${lo}, ${hi}] 里`);

  const sh = (v) => v - base;
  const e0 = edges.map(([a, b]) => [sh(a), sh(b)]);
  const boundary = dir.boundary ? dir.boundary.map(sh) : null;
  const corners = dir.corners ? dir.corners.map(sh) : null;

  // 坐标：优先「# pos: 顶点 x y」，其次按出现顺序的「# pos: x y」
  let pos = null;
  if (dir.posByV.size) {
    pos = new Array(nv).fill(null);
    for (const [v, p] of dir.posByV) if (v - base >= 0 && v - base < nv) pos[v - base] = p;
    if (pos.some((p) => p === null)) {
      notes.push('# pos 只给了一部分顶点 → 坐标只用来画 ①，缺的那个点用邻居的重心补上');
      const adj = adjacencyFromEdges(nv, e0);
      for (let v = 0; v < nv; v++) {
        if (pos[v]) continue;
        const list = [...adj[v]].filter((w) => pos[w]);
        pos[v] = list.length
          ? [list.reduce((s, w) => s + pos[w][0], 0) / list.length, list.reduce((s, w) => s + pos[w][1], 0) / list.length]
          : null;
      }
      if (pos.some((p) => p === null)) pos = null;
    }
  } else if (dir.posSeq.length) {
    if (dir.posSeq.length !== nv) {
      notes.push(`# pos 有 ${dir.posSeq.length} 行、顶点有 ${nv} 个 —— 对不上，坐标忽略了`);
    } else pos = dir.posSeq.map((p) => p.slice());
  }

  return {
    nv, edges: e0, faces: null, boundary, corners, pos, names: null,
    base, format: 'edges', headerUsed: !!header, name: dir.name || fallbackName, notes,
  };
}

/** 表头候选行之后，剩下的行是不是都能当边、且下标放得进 n。*/
function rest2OK(body, n) {
  if (n < 3) return false;
  for (const toks of body) {
    const v = parseInts(toks);
    if (!v || v.length !== 2) return false;
    if (v[0] < 0 || v[1] < 0) return false;
    if (v[0] > n || v[1] > n) return false;
  }
  return true;
}

/* ============================== 组装 preset ============================== */

/**
 * 3-团 t 是不是**分离三角形**（围住了一块不含外圈点的内区）。
 *
 * 教科书判据是「删掉 t 图就断开 = 分离」，但那只对**非面**成立：两张手写地图里
 * 就有真面（「亚拉巴马-佐治亚+南卡-田纳西」「康涅狄格-纽约州-大西洋」…）一删
 * 就把一小块孤立出去 —— 因为图上还有割点，割点切下来的碎块照样带着外圈点。
 * 所以这里的判据是分离三角形的**定义本身**：删掉之后有没有一整块不碰外圈。
 */
function enclosesInner(t, nb, bVerts) {
  const gone = new Set(t);
  const seen = new Set();
  for (let v = 0; v < nb.length; v++) {
    if (gone.has(v) || seen.has(v)) continue;
    let touchesB = false;
    const st = [v];
    seen.add(v);
    while (st.length) {
      const u = st.pop();
      if (bVerts.has(u)) touchesB = true;
      for (const w of nb[u]) if (!gone.has(w) && !seen.has(w)) { seen.add(w); st.push(w); }
    }
    if (!touchesB) return true;                      // 有一块整个躲在外圈里面
  }
  return false;
}

function components(nv, nb) {
  const seen = new Uint8Array(nv);
  const sizes = [];
  for (let v = 0; v < nv; v++) {
    if (seen[v]) continue;
    let n = 0;
    const st = [v]; seen[v] = 1;
    while (st.length) { const u = st.pop(); n++; for (const w of nb[u]) if (!seen[w]) { seen[w] = 1; st.push(w); } }
    sizes.push(n);
  }
  return sizes;
}

/** 由有向三角形算外圈（外圈边 = 反向半边不存在的那些）。*/
function boundaryOfTri(nv, tri) {
  const dir = new Set();
  for (const t of tri) for (let i = 0; i < 3; i++) dir.add(t[i] * nv + t[(i + 1) % 3]);
  const nxt = new Map();
  for (const t of tri) {
    for (let i = 0; i < 3; i++) {
      const a = t[i], b = t[(i + 1) % 3];
      if (dir.has(b * nv + a)) continue;
      if (nxt.has(a)) return null;                    // 一个点两条出边 → 边界被捏住
      nxt.set(a, b);
    }
  }
  if (!nxt.size) return null;
  const start = nxt.keys().next().value;
  const cyc = [start];
  let cur = nxt.get(start);
  while (cur !== start) {
    if (cyc.length > nv) return null;
    cyc.push(cur);
    cur = nxt.get(cur);
    if (cur === undefined) return null;
  }
  return cyc.length === nxt.size ? cyc : null;
}

/** 由绕序把一条无序外圈边集连成圈。*/
function cycleFromBoundaryVertices(verts, edges) {
  const adj = new Map();
  for (const [a, b] of edges) {
    if (!adj.has(a)) adj.set(a, []);
    if (!adj.has(b)) adj.set(b, []);
    adj.get(a).push(b); adj.get(b).push(a);
  }
  if (!adj.size) return null;
  for (const [, list] of adj) if (list.length !== 2) return null;
  const start = edges[0][0];
  const cyc = [start];
  let prev = null, cur = start;
  for (;;) {
    const nxtList = adj.get(cur).filter((w) => w !== prev);
    const nxt = nxtList.length ? nxtList[0] : prev;
    if (nxt === start) break;
    if (cyc.length > adj.size) return null;
    cyc.push(nxt); prev = cur; cur = nxt;
    if (cyc.length > adj.size) return null;
  }
  return cyc.length === adj.size ? cyc : null;
}

/**
 * 一张图 → preset（必要时自动修补）。
 *
 * @param {object} graph parseGraphFile 的输出
 * @param {{maxRounds?:number, maxCornerTries?:number, dryRun?:boolean}} opts
 * @returns {{ok:boolean, problems:string[], notes:string[], repairs:object[],
 *            repairLog:object[], preset:object|null}}
 */
export function graphToPreset(graph, opts = {}) {
  const maxRounds = opts.maxRounds ?? 8;
  const maxCornerTries = opts.maxCornerTries ?? 6;
  const dryRun = opts.dryRun !== false;
  const problems = [];
  const notes = [...(graph.notes || [])];
  const repairs = [];

  /* ---------- 状态：顶点表 + 边集（带标记） ---------- */
  let nv = graph.nv;
  const kind = new Array(nv).fill('real');
  const names = new Array(nv).fill(null).map((_, v) => (graph.names && graph.names[v] != null ? String(graph.names[v]) : `v${v}`));
  let pos = graph.pos ? graph.pos.map((p) => (p ? p.slice() : null)) : null;
  const tagOf = new Map();                          // "a,b" -> {tag, why}
  const key = (a, b) => (a < b ? `${a},${b}` : `${b},${a}`);
  const nbOf = () => {
    const nb = Array.from({ length: nv }, () => new Set());
    for (const k of tagOf.keys()) {
      const i = k.indexOf(',');
      const a = Number(k.slice(0, i)), b = Number(k.slice(i + 1));
      nb[a].add(b); nb[b].add(a);
    }
    return nb;
  };
  const label = (v) => (v >= 0 && v < names.length ? names[v] : `v${v}`);

  // 原始边
  for (const [a, b] of graph.edges) {
    if (a === b) { problems.push(`自环：${label(a)}–${label(a)}`); continue; }
    if (a < 0 || a >= nv || b < 0 || b >= nv) { problems.push(`下标越界：${a}–${b}（nv=${nv}）`); continue; }
    const k = key(a, b);
    if (tagOf.has(k)) { problems.push(`重复的边：${label(a)}–${label(b)}`); continue; }
    tagOf.set(k, { tag: 'real', why: '' });
  }
  if (problems.length) return { ok: false, problems, notes, repairs, repairLog: repairs, preset: null };
  if (!tagOf.size) return { ok: false, problems: ['这张图一条边都没有'], notes, repairs, repairLog: repairs, preset: null };

  /* ---------- 1. 连通性 ---------- */
  {
    const nb = nbOf();
    const sizes = components(nv, nb);
    if (sizes.length > 1) {
      return {
        ok: false, repairs, repairLog: repairs, notes, preset: null,
        problems: [`图不连通：分成 ${sizes.length} 块，大小 ${sizes.slice().sort((a, b) => b - a).join(' / ')}`
          + '（整套框架算的是单连通盘，断开的两块没法铺在同一张矩形里）'],
      };
    }
  }

  /* ---------- 2. 先拿到一份三角剖分 ---------- */
  const addEdgesFromTri = (tri) => {
    for (const t of tri) for (let i = 0; i < 3; i++) {
      const k = key(t[i], t[(i + 1) % 3]);
      if (!tagOf.has(k)) tagOf.set(k, { tag: 'artificial', why: '三角化时加的' });
    }
  };

  let seedTri = null;
  let declaredBoundary = graph.boundary ? graph.boundary.slice() : null;

  if (graph.faces && graph.faces.length) {
    // ---- 情形 A：JSON 给了 faces ----
    const or = orientFaces(graph.faces, { label: (v) => label(v) });
    for (const c of or.conflicts) problems.push(c);
    if (problems.length) return { ok: false, problems, notes, repairs, repairLog: repairs, preset: null };
    const nb = nbOf();
    const tz = triangulateFaces(nv, nb, or.faces, -1, { label: (v) => label(v), nonCliqueHint: 'faces 里只能放三角形' });
    for (const m of tz.problems) problems.push(m);
    for (const r of tz.repairs) repairs.push(r);
    if (problems.length) return { ok: false, problems, notes, repairs, repairLog: repairs, preset: null };
    addEdgesFromTri(tz.tri);
    seedTri = tz.tri;
  } else if (declaredBoundary) {
    // ---- 情形 B：声明了外圈 ----
    const bset = new Set(declaredBoundary);
    if (bset.size !== declaredBoundary.length) {
      return { ok: false, repairs, repairLog: repairs, notes, preset: null,
        problems: ['# boundary 上有重复顶点（说明它是割点，去掉它图就断开）—— 外圈必须是简单圈'] };
    }
    const nb = nbOf();
    for (let i = 0; i < declaredBoundary.length; i++) {
      const a = declaredBoundary[i], b = declaredBoundary[(i + 1) % declaredBoundary.length];
      if (!nb[a].has(b)) {
        return { ok: false, repairs, repairLog: repairs, notes, preset: null,
          problems: [`# boundary 上相邻的 ${label(a)} 和 ${label(b)} 之间没有边`] };
      }
    }
    let emb;
    try {
      emb = embedOnBoundary(nv, nb, declaredBoundary, { label: (v) => label(v), what: '导入的图' });
    } catch (e) {
      return { ok: false, repairs, repairLog: repairs, notes, preset: null,
        problems: [`按声明的 # boundary 嵌入失败：${e.message}`] };
    }
    for (const m of emb.problems) problems.push(m);
    if (problems.length) return { ok: false, problems, notes, repairs, repairLog: repairs, preset: null };
    const tz = triangulateFaces(nv, nb, emb.faces, emb.outerIdx, {
      label: (v) => label(v),
      nonCliqueHint: '这个面不是团 —— 已插人工点把它星形三角化',
    });
    for (const m of tz.problems) problems.push(m);          // 非团面在这里 → 由下面的 steiner 补
    for (const r of tz.repairs) repairs.push(r);
    for (const cyc of tz.nonClique) {
      const w = addSteiner(cyc);
      repairs.push({ kind: 'steiner', face: cyc.map(label), why: `面 ${cyc.map(label).join('-')} 的顶点不两两相邻（不是团），插一个人工点 ${label(w)} 星形三角化` });
    }
    if (problems.length) {
      // 只有「非团面」这一类问题会被 steiner 修掉，其余都是硬伤
      const hard = tz.problems.filter((m) => !m.includes('顶点不两两相邻'));
      if (hard.length) return { ok: false, problems, notes, repairs, repairLog: repairs, preset: null };
      problems.length = 0;
    }
    addEdgesFromTriFromCliques();
    seedTri = null;
  }

  function addSteiner(cyc) {
    const w = nv;
    nv += 1;
    kind.push('patch');
    names.push(`w${w}`);
    if (pos) {
      const good = cyc.filter((v) => pos[v]);
      pos.push(good.length
        ? [good.reduce((s, v) => s + pos[v][0], 0) / good.length, good.reduce((s, v) => s + pos[v][1], 0) / good.length]
        : null);
    }
    for (const v of cyc) tagOf.set(key(w, v), { tag: 'patch', why: `人工点 ${label(w)} 的辐条` });
    return w;
  }

  /** steiner 之后把所有团面补进边集（非团面已经被 star 掉了）。*/
  function addEdgesFromTriFromCliques() {
    const nb = nbOf();
    for (const t of cliques3(nv, nb)) addEdgesFromTri([t]);
  }

  if (seedTri) addEdgesFromTri(seedTri);

  /* ---------- 3. 每一轮都只看 3-团 ---------- */

  // 外圈边的计数里要剔掉的 3-团（顶点集写成 "a,b,c"）—— 见 fixLeakyBoundary。
  let leakyTri = null;
  const triKey = (t) => t.join(',');

  /** 由当前边集算面（3-团里的面）、分离三角形、外圈点、度。*/
  const analyze = () => {
    const nb = nbOf();
    const cl = cliques3(nv, nb);
    const E = tagOf.size;
    const F = E - nv + 1;                            // 欧拉：这张盘该有几个内面
    const cnt = cliqueEdgeCount(nv, nb, cl);
    // 一个**贴着外圈**的分离三角形会让它那条外圈边多出一个 3-团（那条边本来是 1 个面，
    // 现在是 1 个面 + 这个分离三角形），于是「只属一个 3-团的边」就漏掉它 ——
    // leakyTri 就是「把哪条边上的这个多出来的 3-团剔掉」（只在它还在时生效）。
    let skip = null;
    if (leakyTri) {
      const t = cl.find((x) => triKey(x) === leakyTri);
      if (t) skip = new Set([key(t[0], t[1]), key(t[0], t[2]), key(t[1], t[2])]);
    }
    const bVerts = new Set();                        // 外圈点 = 只属于一个 3-团的边的端点
    for (const [k, c] of cnt) {
      const n = c - (skip && c > 1 && skip.has(k) ? 1 : 0);
      if (n !== 1) continue;
      const i = k.indexOf(',');
      bVerts.add(Number(k.slice(0, i)));
      bVerts.add(Number(k.slice(i + 1)));
    }
    // 3-团的个数正好等于欧拉说的面数时，一个多余的 3-团都没有 ⟹ 全是面（十张内建图都是这样，
    // 也省掉了下面的判据）。多出来才需要一条条分辨谁是分离三角形。
    const faces = [], sep = [];
    if (cl.length === F) faces.push(...cl);
    else for (const t of cl) (enclosesInner(t, nb, bVerts) ? sep : faces).push(t);
    const deg = new Int32Array(nv);
    for (const k of tagOf.keys()) {
      const i = k.indexOf(',');
      deg[Number(k.slice(0, i))]++; deg[Number(k.slice(i + 1))]++;
    }
    return { nb, cl, cnt, bVerts, faces, sep, deg, E, F };
  };

  // 有外圈边 ⟹ 这是要当盘算的；一条外圈边都没有 ⟹ 闭合曲面 / 外面是三角形 / 非平面，三选一
  {
    const st = analyze();
    const tally = [...st.cnt.values()];
    const openEdges = tally.filter((c) => c === 1).length;

    if (!st.cl.length) {
      return { ok: false, repairs, repairLog: repairs, notes, preset: null,
        problems: ['这张图里一个三角形都没有（每条边都不属于任何三角形）—— 3-团法恢复不出面，'
          + '请用 # boundary: 声明外圈，或改用 JSON 直接给 faces'] };
    }

    if (openEdges) {
      // 平面图里每条**面**边至多属于 2 个面。这里必须数「面」而不是数「3-团」：
      // 分离三角形的边可能同时被 2 个真面用到，于是 3-团的计数会到 3 —— 那是合法平面图
      // （整套 flip 修补就是为它准备的），不是 K₅。
      const hit = new Map();
      for (const t of st.faces) {
        for (let i = 0; i < 3; i++) {
          const k = key(t[i], t[(i + 1) % 3]);
          hit.set(k, (hit.get(k) || 0) + 1);
        }
      }
      const over = [...hit.values()].filter((c) => c >= 3).length;
      if (over) {
        return { ok: false, repairs, repairLog: repairs, notes, preset: null,
          problems: [`这张图不是平面三角剖分：有 ${over} 条边同时属于 ≥ 3 个面`
            + `（平面图里每条边至多属于 2 个面）—— 多半是 K₅ 这类非平面图；`
            + '如果它确实是平面的，请用 # boundary: 声明外圈，或改用 JSON 给 faces'] };
      }
    } else {
      // 闭合曲面：每条边恰好夹在两个三角形之间（外圈本身是三角形时也是这样 ——
      // 那种图组合上就是一个球面，沿度 4 的顶点剪开照样得到一张盘）。
      const closed = tally.every((c) => c === 2);
      const chi = nv - st.E + st.cl.length;          // 每条边都在两个 3-团之间时 3-团就是全部面
      const deg4 = [];
      for (let v = 0; v < nv; v++) if (st.nb[v].size === 4) deg4.push(v);
      if (!(closed && chi === 2 && deg4.length)) {
        const why = closed
          ? `这张图是闭合曲面（每条边恰好属于两个三角形，欧拉 V−E+F = ${chi}`
            + (chi === 2 ? ' = 球面，但没有度 4 的顶点可剪' : '，不是球面（球面是 2）') + '）'
          : `这张图的每条边都夹在 ≥ 2 个三角形之间，找不到一条外圈边（欧拉按 3-团算 V−E+F = ${chi}）`;
        return { ok: false, repairs, repairLog: repairs, notes, preset: null,
          problems: [`${why} —— 可能是闭合曲面、外圈本身就是三角形、或者 K₅ 那样的非平面图。`
            + '整套框架算的是**一张盘**（有外圈，且外圈至少 4 个点），'
            + '请补 # boundary: 声明外圈，或改用 JSON 给 faces'] };
      }
      const v = deg4[0];
      const vName = label(v);                        // 删之前先记名字：删完下标就重排了
      removeVertex(v);
      repairs.push({
        kind: 'cut', face: [vName],
        why: `这是一张闭合曲面（欧拉 V−E+F = ${chi} = 球面）；沿度 4 的顶点 ${vName} 剪开成一张盘`
          + '（删掉它，它的 link 就是新的外圈）',
      });
      notes.push(`球面沿 ${vName} 剪开；被删掉的顶点是文件里原有的`);
    }
  }

  /* ---------- 顶点增删 ---------- */

  function removeVertex(v) {
    const keep = [];
    for (let i = 0; i < nv; i++) if (i !== v) keep.push(i);
    const to = new Map(keep.map((o, i) => [o, i]));
    const nk = new Map();
    for (const [k, meta] of tagOf) {
      const i = k.indexOf(',');
      const a = Number(k.slice(0, i)), b = Number(k.slice(i + 1));
      if (a === v || b === v) continue;
      nk.set(key(to.get(a), to.get(b)), meta);
    }
    tagOf.clear();
    for (const [k, meta] of nk) tagOf.set(k, meta);
    const keepKind = keep.map((o) => kind[o]);
    const keepNames = keep.map((o) => names[o]);
    kind.length = 0; kind.push(...keepKind);
    names.length = 0; names.push(...keepNames);
    if (pos) {
      const keepPos = keep.map((o) => pos[o]);
      pos.length = 0; pos.push(...keepPos);
    }
    nv = keep.length;
  }

  /** 把 v 并进 w（v 的相邻关系全部转给 w，不丢任何一条）。*/
  function mergeInto(v, w) {
    const adj = new Set(nbOf()[v]);
    for (const u of adj) {
      if (u === w) continue;
      const k = key(u, w);
      if (!tagOf.has(k)) tagOf.set(k, { tag: 'real', why: '' });
    }
    removeVertex(v);
    return w > v ? w - 1 : w;
  }

  /* ---------- 修补阶梯 ---------- */
  let stuck = null;
  let leakyTried = false;
  for (let round = 0; round < maxRounds; round++) {
    const st = analyze();

    // 面数对不对得上欧拉 —— 对不上说明 3-团法没认出面
    if (st.faces.length !== st.E - nv + 1) {
      // 先试一种**已知**的骗法：分离三角形贴着外圈时，它的外圈边被多算了一个 3-团，
      // 于是那几个外圈点认不出来、面的分类跟着错。剔掉它再算一遍就能对上（下面会翻掉它）。
      if (!leakyTried && st.cl.length > st.E - nv + 1) {
        leakyTried = true;
        const msg = fixLeakyBoundary(st);
        if (msg) { notes.push(msg); continue; }
      }
      const F = st.E - nv + 1;
      const why = st.cl.length > F
        ? `3-团比面数多 ${st.cl.length - F} 个（多出来的本该是分离三角形，但认不出外圈）`
        : `3-团比面数少 ${F - st.cl.length} 个（有面是 ≥ 4 边形）`;
      stuck = `面数对不上欧拉公式：3-团里数出 ${st.faces.length} 个面，欧拉说该有 ${F} 个`
        + `（V=${nv} E=${st.E}，${why}）—— 3-团法恢复不出面，`
        + '请补 # boundary: 声明的外圈，或改用 JSON 给出 faces';
      break;
    }

    // (1) 分离三角形 → 翻边：删掉它一条**内边**、换成另一条对角线。
    // 注意「内边」不能用「另一条对角线不存在」以外的本地判据：分离三角形的三条边在
    // 3-团里都是 3 个（它自己 + 两侧的两个真面），所以这里数的是**除它以外**穿过这条边的
    // 面 —— 恰好 2 个才说明这条边内部、两侧都有面，可以翻。
    // （贴外圈的边只有 1 个面，翻它会把外圈拆坏，直接跳过。）
    if (st.sep.length) {
      let done = false;
      for (const t of st.sep) {
        const cand = [];
        for (let i = 0; i < 3; i++) {
          const a = t[i], b = t[(i + 1) % 3];
          cand.push({ a, b, sum: st.deg[a] + st.deg[b] });
        }
        cand.sort((x, y) => x.sum - y.sum);
        for (const { a, b } of cand) {
          const thirds = [];
          for (const f of st.cl) {
            if (triKey(f) === triKey(t)) continue;     // 自己不算「穿过这条边的面」
            if (!f.includes(a) || !f.includes(b)) continue;
            const c = f.find((v) => v !== a && v !== b);
            if (!thirds.includes(c)) thirds.push(c);
          }
          if (thirds.length !== 2) continue;
          const [x, y] = thirds;
          if (tagOf.has(key(x, y))) continue;          // 另一条对角线已经有了 → 换一条边试
          tagOf.delete(key(a, b));
          tagOf.set(key(x, y), { tag: 'artificial', why: '分离三角形翻边' });
          repairs.push({
            kind: 'flip', face: t.map(label),
            why: `分离三角形 ${t.map(label).join('-')}：删掉边 ${label(a)}–${label(b)}、`
              + `换成对角线 ${label(x)}–${label(y)}（两侧的面 ${label(x)} 和 ${label(y)} 重新三角化）`,
          });
          done = true;
          break;
        }
        if (done) break;
      }
      if (done) continue;
      stuck = `有 ${st.sep.length} 个分离三角形（例如 ${st.sep[0].map(label).join('-')}），`
        + '但一条内边都翻不动：外圈边不能翻，其余边的另一条对角线又都已经存在'
        + ` —— 这张图的分离三角形拆不掉（V=${nv} E=${st.E}）`;
      break;
    }

    // (2) 外圈上度为 2 的点 > 4 → 多出来的并入邻居
    const bnd = boundaryOfTri(nv, triFromFaces(st));
    const onB = new Set(bnd || []);
    const deg2 = (bnd || []).filter((v) => st.deg[v] === 2);
    if (deg2.length > 4) {
      const v = deg2[4];
      const vName = label(v);                        // 并入之后下标会重排，名字要先记下来
      const prev = bnd[(bnd.indexOf(v) - 1 + bnd.length) % bnd.length];
      const w = mergeInto(v, prev);
      repairs.push({
        kind: 'merge', face: [vName, label(w)],
        why: `外圈上有 ${deg2.length} 个度 2 的点（度 2 的外圈点必须当角点，最多 4 个），`
          + `把 ${vName} 并入邻居 ${label(w)}（它的相邻关系全部转过去，不丢任何一条）`,
      });
      continue;
    }

    // (3) 内点度 < 4 → 并入度数最大的邻居
    let low = -1;
    for (let v = 0; v < nv; v++) {
      if (onB.has(v)) continue;
      if (st.deg[v] < 4 && (low < 0 || st.deg[v] < st.deg[low])) low = v;
    }
    if (low >= 0) {
      let w = -1;
      for (const u of st.nb[low]) if (w < 0 || st.deg[u] > st.deg[w]) w = u;
      const lowName = label(low);                    // 并入之后下标会重排，名字要先记下来
      const degLow = st.deg[low];
      const nw = mergeInto(low, w);
      repairs.push({
        kind: 'merge', face: [lowName, label(nw)],
        why: `内点 ${lowName} 的度只有 ${degLow}（PTP 要求内点度 ≥ 4），`
          + `把它并入度数最大的邻居 ${label(nw)}（相邻关系全部转过去，不丢任何一条）`,
      });
      continue;
    }

    break;
  }

  function triFromFaces(st) {
    // 面（不分离的 3-团）本身没有朝向信息，这里只需要它的边集来走外圈；
    // 朝向用 orientFaces 传播一次。
    const or = orientFaces(st.faces, { label: (v) => label(v) });
    return or.faces;
  }

  /**
   * 「贴着外圈的分离三角形」：沿着外圈摆的一个分离三角形（比如正方形里画一条对角线，
   * 半个三角形内部又被细分过）会让它靠外圈那条边在 3-团计数里变成 2 —— 那条边明明是
   * 外圈边（只有 1 个面）。于是「只属一个 3-团的边 = 外圈边」少了几个点，面的分类就跟着错。
   *
   * 这里逐条试「把哪个 3-团从外圈边计数里剔掉」，能同时满足
   *   ① 面数对得上欧拉（必要）；
   *   ② 剔掉的那个 3-团确实被认成分离三角形（它就是罪魁祸首）；
   *   ③ 剩下的面能走出一条简单外圈（≥ 4 个点、无重复）
   * 才算数，取第一组。全部都对不上就返回 null（调用方按原样拒绝并说清）。
   *
   * 这是组合上的猜测，验证是下游的 PTP + 干跑；猜错了会在那里被拦住。
   * @returns {string|null} 一句要写进 notes 的说明
   */
  function fixLeakyBoundary(st) {
    const F = st.E - nv + 1;
    const cands = [];
    for (const t of st.cl) {
      // 罪魁祸首的外圈边上会多出这一个 3-团 → 那条边的计数是 2
      let hit = false;
      for (let i = 0; i < 3; i++) if (st.cnt.get(key(t[i], t[(i + 1) % 3])) === 2) hit = true;
      if (hit) cands.push(t);
      if (cands.length >= 200) break;                  // 兜住极端输入（正常图里候选很少）
    }
    const oks = [];
    for (const t of cands) {
      leakyTri = triKey(t);
      const s2 = analyze();
      if (s2.faces.length !== F) continue;
      if (!s2.sep.some((x) => triKey(x) === leakyTri)) continue;
      let bnd = null;
      try { bnd = boundaryOfTri(nv, orientFaces(s2.faces, { label: (v) => label(v) }).faces); } catch (e) { bnd = null; }
      if (!bnd || bnd.length < 4 || new Set(bnd).size !== bnd.length) continue;
      oks.push(t);
    }
    if (!oks.length) { leakyTri = null; return null; }
    leakyTri = triKey(oks[0]);
    return `有一处要说明：分离三角形 [${oks[0].map(label).join(', ')}] 贴着外圈，`
      + '它让靠外圈那条边在 3-团里多算了一次，外圈点认不全；'
      + '已按「剔掉它」之后的外圈边还原（下面会把它翻边修掉）'
      + (oks.length > 1 ? ` —— 能对上的候选有 ${oks.length} 组，取的是第一组` : '');
  }

  if (stuck) return { ok: false, problems: [stuck], notes, repairs, repairLog: repairs, preset: null };

  /* ---------- 4. 三角剖分定稿 ---------- */
  const st = analyze();
  if (st.faces.length !== st.E - nv + 1) {
    return { ok: false, repairs, repairLog: repairs, notes, preset: null,
      problems: [`面数对不上欧拉公式（3-团里 ${st.faces.length} 个面，欧拉说 ${st.E - nv + 1} 个）`
        + ' —— 这张图不是三角剖分；请补 # boundary: 声明的外圈，或改用 JSON 给出 faces'] };
  }
  const oriTri = orientFaces(st.faces, { label: (v) => label(v) }).faces;
  const bnd0 = boundaryOfTri(nv, oriTri);
  if (!bnd0) {
    return { ok: false, repairs, repairLog: repairs, notes, preset: null,
      problems: ['外圈走不成一个简单圈（多半图里有割点，或外面被捏在一处）'] };
  }
  if (bnd0.length < 4) {
    return { ok: false, repairs, repairLog: repairs, notes, preset: null,
      problems: [`外圈只有 ${bnd0.length} 个点（要 ≥ 4 才钉得成四边形）`] };
  }
  // 外面朝向：orientFaces 给的是「一致」，不保证逆时针 —— 由下面的翻转候选兜住。

  /* ---------- 5. 4 个角点 ---------- */
  // 每一组候选 = {corners, flip}：flip 表示把这套三角形整体反向。
  // 朝向是 coin flip（纯组合地看不出逆时针），所以两种都试 —— 干跑会告诉我们哪个对。
  const reverse4 = (c) => [c[0], c[3], c[2], c[1]];
  const cornerTries = [];
  const declared = graph.corners ? graph.corners.slice() : null;

  if (bnd0.length === 4) {
    // k = 4：外圈就是那 4 个角点，不需要声明；朝向由 buildInputMesh 里的 orientCCW 兜住
    cornerTries.push({ corners: null, flip: false });
  } else if (declared) {
    if (!declared.every((v) => bnd0.includes(v))) {
      return { ok: false, repairs, repairLog: repairs, notes, preset: null,
        problems: [`# corners 里的点不都在外圈上：[${declared.map(label).join(', ')}]`] };
    }
    const at = new Map(bnd0.map((v, i) => [v, i]));
    const diffs = [];
    for (let i = 0; i < 4; i++) {
      const from = at.get(declared[i]), to = at.get(declared[(i + 1) % 4]);
      diffs.push((to - from + bnd0.length) % bnd0.length);
    }
    if (diffs.some((d) => d < 1)) {
      return { ok: false, repairs, repairLog: repairs, notes, preset: null,
        problems: [`# corners 没把外圈分成 4 段非空链（各段 ${diffs.join('/')} 条边）`] };
    }
    notes.push(`角点用文件里声明的 [${declared.map(label).join(', ')}]`);
    cornerTries.push({ corners: declared, flip: false });
    cornerTries.push({ corners: reverse4(declared), flip: true });
  } else {
    const cands = autoCornerCandidates(bnd0, st.deg, maxCornerTries);
    if (!cands.length) {
      return { ok: false, repairs, repairLog: repairs, notes, preset: null,
        problems: ['外圈上度为 2 的点超过 4 个，选不出 4 个合法角点'] };
    }
    for (const c of cands) cornerTries.push({ corners: c, flip: false });
    for (const c of cands) cornerTries.push({ corners: reverse4(c), flip: true });
    notes.push(`角点自动选的：[${cands[0].map(label).join(', ')}]`
      + (cands.length > 1 ? `（另有 ${cands.length - 1} 组备选）` : ''));
  }

  /* ---------- 6. 组装 + 干跑 ---------- */
  const mkPreset = (corners, flip) => {
    const faces = flip ? oriTri.map((t) => [t[2], t[1], t[0]]) : oriTri.map((t) => t.slice());
    const edgeKind = new Map();
    const edgeWhy = new Map();
    const counts = { real: 0, water: 0, patch: 0, artificial: 0, point: 0 };
    for (const k of tagOf.keys()) {
      const i = k.indexOf(',');
      const a = Number(k.slice(0, i)), b = Number(k.slice(i + 1));
      const meta = tagOf.get(k);
      counts[meta.tag] = (counts[meta.tag] || 0) + 1;
      edgeKind.set(a * nv + b, meta.tag);
      edgeWhy.set(a * nv + b, meta.why || '');
    }
    const p = {
      id: `file-${(graph.name || 'graph').replace(/\s+/g, '-')}`,
      name: graph.name || '导入的图',
      note: `从文件导入：${nv} 点 / ${tagOf.size} 边 / 外圈 ${bnd0.length} 点`
        + (repairs.length ? `，自动修补 ${repairs.length} 条` : '，无需修补'),
      nv,
      faces,
      ids: [...Array(nv).keys()],
      names: names.slice(),
      kind: kind.slice(),
      geo: pos && pos.every((q) => q) ? pos.map((q) => q.slice()) : null,
      geoKind: 'xy',
      edgeKind,
      edgeWhy,
      repairs: repairs.map((r) => ({ kind: r.kind, face: r.face.slice(), why: r.why })),
      faceCycles: [],
      extra: [...edgeKind.keys()].filter((k) => edgeKind.get(k) !== 'real').map((k) => ({
        a: Math.floor(k / nv), b: k % nv, kind: edgeKind.get(k), why: edgeWhy.get(k),
      })),
      dummies: [],
      merges: repairs.filter((r) => r.kind === 'merge').map((r) => ({ name: r.face[0], into: r.face[1] || '', why: r.why })),
      excluded: repairs.filter((r) => r.kind === 'cut').map((r) => ({ name: r.face[0], why: r.why })),
    };
    if (corners) p.corners = { S: corners[0], E: corners[1], N: corners[2], W: corners[3] };
    p.report = {
      id: p.id, name: p.name,
      nv, ne: tagOf.size, nf: faces.length, chi: nv - tagOf.size + faces.length,
      boundaryLen: bnd0.length,
      facesBefore: faces.length,
      cornerNames: corners ? { S: names[corners[0]], E: names[corners[1]], N: names[corners[2]], W: names[corners[3]] } : null,
      counts,
      repairs: repairs.length,
      minInteriorDeg: 0, minWallDeg: 0,
      ptpOk: true, embedAttempt: 0,
      facingInversions: { maxDeg: 0, at: '' },
      source: 'file',
    };
    return p;
  };

  const desc = (corners) => (corners ? `角点 [${corners.map(label).join(', ')}]` : '外圈 4 点');
  const failures = [];
  let preset = null;
  for (const { corners, flip } of cornerTries) {
    const p = mkPreset(corners, flip);
    let gate;
    try {
      gate = checkPTP(comb(p.faces, p.nv), corners ? { corners } : undefined);
    } catch (e) {
      failures.push(`${desc(corners)}${flip ? '（反向）' : ''}：${e.message}`);
      continue;
    }
    if (!gate.ok) {
      failures.push(`${desc(corners)}${flip ? '（反向）' : ''}：${gate.reasons.join('；')}`);
      continue;
    }
    let used = corners;
    try {
      if (dryRun) used = runPipeline(p, { quad: quadForPreset(p, 1) }).corners;
      else used = buildInputMesh(p).corners;
    } catch (e) {
      failures.push(`${desc(corners)}${flip ? '（反向）' : ''}：${e.message}`);
      continue;
    }
    // k = 4 时不声明角点（外圈就是那 4 个点，朝向由 buildInputMesh 的 orientCCW 兜）——
    // 但面板上还是要说清哪 4 个顶点是 S/E/N/W，所以在干跑之后照实记下来。
    if (!p.report.cornerNames && used && used.length === 4) {
      p.report.cornerNames = { S: names[used[0]], E: names[used[1]], N: names[used[2]], W: names[used[3]] };
      notes.push(`角点（外圈 4 个点，次序由铺展定下来）：[${used.map(label).join(', ')}]`);
    }
    preset = p;
    if (flip) notes.push('三角形整体反向才跑通（组合上分不出逆时针，干跑定下来的）');
    break;
  }
  if (!preset) {
    return { ok: false, repairs, repairLog: repairs, notes, preset: null,
      problems: [`角点选不出来：试了 ${failures.length} 组都不行`, ...failures.slice(0, 4)] };
  }

  if (repairs.length) notes.push(`自动修补 ${repairs.length} 条，逐条列在右边的「修补账」里`);
  return { ok: true, problems: [], notes, repairs, repairLog: repairs, preset };
}

/* ---------- 自动选角点 ---------- */

/**
 * 外圈上**度为 2 的点强制当角点**（PTP 要求非角点外圈点度 ≥ 3），
 * 剩下的名额按「贪心最大化最小间隔」补满。
 *
 * @returns {number[][]} 候选组（第一组最好，后面是备选）
 */
export function autoCornerCandidates(bnd, deg, want = 1) {
  const k = bnd.length;
  const out = [];
  if (k === 4) return [bnd.slice()];
  const forced = [];
  for (let i = 0; i < k; i++) if (deg[bnd[i]] === 2) forced.push(i);
  if (forced.length > 4) return out;                 // 修不掉（调用方会去合并）

  const gaps = (set) => {
    const s = [...set].sort((a, b) => a - b);
    let m = Infinity;
    for (let i = 0; i < s.length; i++) m = Math.min(m, (s[(i + 1) % s.length] - s[i] + k) % k);
    return m;
  };

  const build = (chosen) => {
    const s = [...chosen].sort((a, b) => a - b);
    return s.map((i) => bnd[i]);
  };

  const first = new Set(forced);
  // 度 2 的点全当角点时，如果已经 4 个就直接用
  if (first.size > 4) return out;
  while (first.size < 4) {
    let best = -1, bestGap = -1;
    for (let i = 0; i < k; i++) {
      if (first.has(i)) continue;
      if (deg[bnd[i]] < 3) continue;                 // 非角点的外圈点度必须 ≥ 3
      const g = gaps(new Set([...first, i]));
      if (g > bestGap) { bestGap = g; best = i; }
    }
    if (best < 0) break;
    first.add(best);
  }
  if (first.size !== 4) return out;
  out.push(build(first));

  // 备选：把「非强制」的那几个名额换成次优的
  const pool = [];
  for (let i = 0; i < k; i++) if (!forced.includes(i) && deg[bnd[i]] >= 3) pool.push(i);
  const free = 4 - forced.length;
  if (free > 0 && pool.length > free) {
    // 按「离最近强制点的距离」从大到小取若干组合，简单点：轮流替换
    const base = [...first].filter((i) => !forced.includes(i));
    for (const p of pool) {
      if (base.includes(p)) continue;
      const s = new Set([...forced, ...base.slice(1), p]);
      if (s.size === 4) {
        const c = build(s);
        if (!out.some((x) => x.join(',') === c.join(','))) out.push(c);
        if (out.length >= want) break;
      }
    }
  }
  return out.slice(0, Math.max(1, want));
}
