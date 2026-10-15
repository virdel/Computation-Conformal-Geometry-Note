// REL（regular edge labeling，正则边标号）—— 矩形对偶的组合骨架。
//
// 约定（几何锚定，和矩形位置一一对应）：
//   * BLUE (u,v)：R(u) 正好在 R(v) 下面（决定 y）
//   * RED  (u,v)：R(u) 正好在 R(v) 左边（决定 x）
//   所以每条内边都带方向：blue 由下往上、red 由左往右。
//
// 内点 v 的四块：绕 v 顺时针看，出蓝(OB) → 出红(OR) → 入蓝(IB) → 入红(IR)，
// 四块都必须非空。
// 边界点：贴着哪面墙就缺哪一块（下墙缺 IB、左墙缺 IR、上墙缺 OB、右墙缺 OR），
// 剩下的块按同一个循环次序、每块连成一段 —— 外边界有 k > 4 个点时就是这样，
// 4 个角点的老情形（角点只剩两块）是它的特例。见 presenceOf / patternOk。
// 外边本身：颜色的写法由几何定死（水平墙红、竖直墙蓝，方向由小坐标指向大坐标），
// 见 outerEdgeLabels —— 4 个角点时它退化成 vS→vW 蓝、vS→vE 红、vW→vN 红、vE→vN 蓝。
//
// 标号从平直度量铺展后的「斜率为正 → 蓝」得到（见 labelBySlope）。

export const BLUE = 'B';
export const RED = 'R';

/** 确定性 RNG（重启时换种子）。*/
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 每个顶点处邻居的**逆时针**绕序 —— 由面结构（组合嵌入）算出来，不用坐标。
 *
 * 为什么不能用铺展图的 atan2 排序：铺展（discrete conformal / Ricci 流解出来的
 * 平直度量）并不保证是一个嵌入的平面图 —— 它可能自交叠（实测 nv=30 时就有 2 条
 * 非相邻边相交），那几个顶点周围的 atan2 绕序和真实绕序不一致，公理就会用错配对，
 * 于是本来有解的图被判成无解。组合绕序才是公理该用的东西。
 */
export function rotationOrder(mesh) {
  const nv = mesh.nv;
  const key = (a, b) => a * nv + b;
  const succ = new Map();
  for (const [p, q, r] of mesh.faces) {          // 内面都是逆时针三角形
    succ.set(key(p, q), r); succ.set(key(q, r), p); succ.set(key(r, p), q);
  }
  const nbrs = Array.from({ length: nv }, () => []);
  for (const [a, b] of mesh.edges) { nbrs[a].push(b); nbrs[b].push(a); }
  const out = [];
  for (let v = 0; v < nv; v++) {
    const has = (w) => succ.has(key(v, w));
    // 边界点上绕序是一条「链」：起点是那个没有前驱的邻居
    const pred = new Set();
    for (const w of nbrs[v]) if (has(w)) pred.add(succ.get(key(v, w)));
    let start = nbrs[v].find((w) => has(w) && !pred.has(w));
    if (start === undefined) start = nbrs[v].find(has);       // 内点：随便挑一个
    const order = [];
    if (start !== undefined) {
      let cur = start;
      for (let k = 0; k <= nv; k++) {
        order.push(cur);
        const nxt = succ.get(key(v, cur));
        if (nxt === undefined || nxt === start) break;
        cur = nxt;
      }
    }
    out.push(order);
  }
  return out;
}

/**
 * 由铺展后的平面坐标给内边标号。
 * 斜率为正 → 蓝（下→上），斜率为负 → 红（左→右）。
 * @returns {{edgeColor:Map<number,{color,from,to,slope,degenerate}>, degenerate:number}}
 */
export function labelBySlope(mesh, pos) {
  const edgeColor = new Map();
  let degenerate = 0;
  for (let e = 0; e < mesh.ne; e++) {
    const [a, b] = mesh.edges[e];
    if (mesh.facesOfEdge[e].length !== 2) continue;   // 只标内边
    const dx = pos[b][0] - pos[a][0];
    const dy = pos[b][1] - pos[a][1];
    const s = dx * dy;
    if (s === 0) degenerate++;
    const color = s >= 0 ? BLUE : RED;
    let from, to;
    if (color === BLUE) { from = dy > 0 ? a : b; to = dy > 0 ? b : a; }
    else { from = dx > 0 ? a : b; to = dx > 0 ? b : a; }
    edgeColor.set(e, { color, from, to, slope: dy / (dx || 1e-300), degenerate: s === 0, edge: e });
  }
  return { edgeColor, degenerate };
}

// ---------------------------------------------------------------------------
// 解 REL：这是组合问题，不是几何问题。
//
// 每条边有 4 个状态：颜色（蓝/红）× 方向。在顶点 v 看边 e：
//   v 是尾巴：蓝 → OB、红 → OR；   v 是头：蓝 → IB、红 → IR。
// 公理（把「矩形对偶」翻译成组合条件）：
//   * 绕顶点 v 逆时针走一圈，块的出现顺序必须是 OB → IR → IB → OR（循环），
//     每个出现的块连成一段 —— 相邻两条边要么同块，要么走到下一块。
//   * 贴着哪面墙就缺哪块：下墙缺 IB、左墙缺 IR、上墙缺 OB、右墙缺 OR
//     （下墙上的矩形底下不可能有邻居，以此类推）。角点因此只剩两块。
// 这两条合起来就是「每条边 4 个取值 + 一对相邻边一条二元约束」的小 CSP：
// 4×4 允许表 + 弧相容 + 回溯，几百个变量也是毫秒级。
//
// 为什么不直接看铺展图的斜率符号：斜率标号只在「每个内点四个象限都有邻居」
// 时才自动满足公理。铺展图里完全可能出现某个内点的邻居全挤在一侧（三个右上
// 加一个左下），这时斜率标号不是合法 REL，矩形对偶就建不出来。铺展图在这里
// 只用来排取值顺序（先试与斜率一致的状态），让解出来的 REL 与铺展图最贴近。
// ---------------------------------------------------------------------------

const BLOCKS = ['OB', 'IR', 'IB', 'OR'];     // 逆时针方向上的四块顺序
const reversePattern = (p) => [p[0], p[3], p[2], p[1]];
const blockBit = (t) => 1 << BLOCKS.indexOf(t);
const popcnt = (x) => { let c = 0; while (x) { c += x & 1; x >>= 1; } return c; };
const hasBlock = (mask, t) => (mask & blockBit(t)) !== 0;

/** 4 个状态：颜色 × 方向（forward = 由 mesh.edges[e] 的第一个端点指向第二个）。*/
const STATE = [
  { color: BLUE, forward: true },
  { color: BLUE, forward: false },
  { color: RED, forward: true },
  { color: RED, forward: false },
];

/** 边 a-b 在顶点 v 处、取状态 s 时的块类型。*/
function typeOf(a, b, v, s) {
  const tail = s.forward ? a : b;
  if (v === tail) return s.color === BLUE ? 'OB' : 'OR';
  return s.color === BLUE ? 'IB' : 'IR';
}

/**
 * 解出一个合法 REL。
 * @param {Mesh} mesh
 * @param {number[][]} pos 铺展后的坐标（只用来排取值顺序，不参与正确性）
 * @param {{S:number,E:number,N:number,W:number}} corners
 * @param {{maxBacktracks?:number, trace?:boolean}} opts
 * @returns {{ok:boolean, edgeColor:Map, backtracks:number, nodes:number, degenerate:number,
 *            slopeAgree:{same:number,total:number}, problems:string[]}}
 */
export function solveREL(mesh, pos, corners, opts = {}) {
  const { maxBacktracks = 200000 } = opts;
  const problems = [];
  const trace = opts.trace ? [] : null;
  const dbg = opts.debug ? [] : null;     // 诊断用（现在只占位）
  // 取值顺序：'slope' 用斜率标号当提示（铺展图不嵌入时它会指错路），
  // 'random' 随机（配重启），'none' 按状态号。
  const hintMode = opts.hintMode || 'slope';
  const rng = mulberry32(opts.seed || 12345);

  // ---- 变量 = 每条边（4 个状态：颜色 × 方向）；外边钉死的锁成单值 ----
  const ne = mesh.ne;
  const inner = [];
  for (let e = 0; e < ne; e++) if (mesh.facesOfEdge[e].length === 2) inner.push(e);
  const m = inner.length;

  // ---- 外边：颜色/方向是几何定死的，直接锁成一个状态 ----
  const pinned = new Map();               // 边 → 状态
  for (const { u, v, color } of outerEdgeLabels(mesh, corners)) {
    const e = mesh.edgeOf.get(mesh.edgeKey(u, v));
    if (e === undefined) { problems.push(`外边 ${u}-${v} 不在图里`); continue; }
    const [a] = mesh.edges[e];
    pinned.set(e, STATE.findIndex((st) => st.color === color && st.forward === (a === u)));
  }

  // ---- 贴着哪面墙 → 缺哪一块 ----
  const presence = presenceOf(mesh, corners);

  // ---- 每个顶点：入射边（含外边）按**组合**逆时针绕序排 ----
  const rotOrder = rotationOrder(mesh);
  const rankOf = rotOrder.map((list) => new Map(list.map((w, i) => [w, i])));
  const incEdges = Array.from({ length: mesh.nv }, () => []);
  for (let e = 0; e < ne; e++) { const [a, b] = mesh.edges[e]; incEdges[a].push(e); incEdges[b].push(e); }
  let degenerate = 0;
  const vpOf = new Int32Array(mesh.nv).fill(-1);   // 顶点 → 图案表下标
  const atVertex = [];
  for (let v = 0; v < mesh.nv; v++) {
    const inc = [];
    for (const e of incEdges[v]) {
      const [a, b] = mesh.edges[e];
      const isOuter = mesh.facesOfEdge[e].length !== 2;
      const w = a === v ? b : a;
      if (Math.abs(pos[w][0] - pos[v][0]) < 1e-12 || Math.abs(pos[w][1] - pos[v][1]) < 1e-12) degenerate++;
      inc.push({
        edge: e, a, b, w,
        outer: isOuter,
        var: e,                                    // 变量就是边号
        fixed: pinned.has(e) ? pinned.get(e) : -1,  // 钉死的外边在这点的块类型
        ang: Math.atan2(pos[w][1] - pos[v][1], pos[w][0] - pos[v][0]),
      });
    }
    if (inc.length < 3) continue;             // 度 1/2 的顶点没有可约束的循环
    if (rotOrder[v].length !== inc.length) problems.push(`顶点 v${v} 的绕序不完整（${rotOrder[v].length}/${inc.length}）`);
    inc.sort((p, q) => {
      const rp = rankOf[v].get(p.w), rq = rankOf[v].get(q.w);
      if (rp === undefined || rq === undefined) return p.ang - q.ang;
      return rp - rq;
    });
    vpOf[v] = atVertex.length;
    atVertex.push({ v, inc });
  }

  // 顶点的块顺序：从 OB 开始的循环，只留「该有的块」
  const nextInCycle = (mask, t) => {
    let i = BLOCKS.indexOf(t);
    for (let k = 1; k <= 4; k++) {
      const cand = BLOCKS[(i + k) % 4];
      if (hasBlock(mask, cand)) return cand;
    }
    return t;
  };
  const cycleOf = (mask) => BLOCKS.filter((t) => hasBlock(mask, t));

  // 内点：四块都得有，且每块连成一段 —— 这条公理由 buildPats 的枚举直接保证。
  // ---- 几何提示：斜率标号（只用来排取值顺序）----
  const slope = labelBySlope(mesh, pos).edgeColor;
  const hint = new Int8Array(ne).fill(-1);
  for (const e of inner) {
    const lab = slope.get(e);
    if (!lab) continue;
    const [a] = mesh.edges[e];
    hint[e] = STATE.findIndex((s) => s.color === lab.color && s.forward === (lab.from === a));
  }

  // ---- 两个候选方向（铺展图若镜像则整圈反向），先用与斜率标号更合的那个 ----
  const score = (pattern) => {
    const next = new Map(pattern.map((t, i) => [t, pattern[(i + 1) % 4]]));
    let good = 0, bad = 0;
    for (const { v, inc } of atVertex) {
      const stateOf = (it) => (it.outer ? it.fixed : (hint[it.var] >= 0 ? hint[it.var] : 0));
      for (let i = 0; i < inc.length; i++) {
        const p = inc[i], q = inc[(i + 1) % inc.length];
        const tp = typeOf(p.a, p.b, v, STATE[stateOf(p)]), tq = typeOf(q.a, q.b, v, STATE[stateOf(q)]);
        if (tq === tp) continue;
        if (tq === next.get(tp)) good++; else bad++;
      }
    }
    return good - bad;
  };
  const reversed = reversePattern(BLOCKS);
  const patterns = opts.forcePattern
    ? [opts.forcePattern]
    : (score(BLOCKS) >= score(reversed) ? [BLOCKS, reversed] : [reversed, BLOCKS]);

  // ---------------------------------------------------------------------
  // 搜索：变量是**顶点图案**，不是单条边。
  //
  // 一个顶点的图案 = 给它每条入射边指定一个块：绕顶点逆时针走一圈，块的出现次序
  // 符合循环次序、每块连成一段、该有的块都得有；钉死的外边在枚举时就把那个位置固定。
  // 边本身仍是变量（4 个状态 = 颜色 × 方向），顶点图案和边的定义域互相做弧相容：
  // 图案和某条边的定义域冲突就杀掉，边的某个取值没有活着的图案支持也削掉。
  //
  // 为什么不能只做「相邻边 4×4 允许表 + 弧相容」：deg-4 的内点要求四条边**正好各占
  // 一块**（"四条都出蓝" 在二元表里是合法的），这是顶点上的整体约束，二元表看不见，
  // 搜索就会在每个 deg-4 顶点上反复抖。随机 PTP 里四成以上是 deg-4 顶点，所以图一大
  // （nv ≥ 100）几万次回溯都搜不完；换成图案级弧相容后 240 个点也是毫秒级。
  // ---------------------------------------------------------------------
  const typeIdx = (t) => BLOCKS.indexOf(t);
  const perVertex = atVertex.map(({ v, inc }) => {
    const d = inc.length;
    // typeMask[k*4+τ] = 能让第 k 条边在 v 处成为块 τ 的状态集合
    const typeMask = new Uint8Array(d * 4);
    inc.forEach((it, k) => {
      for (let s = 0; s < 4; s++) typeMask[k * 4 + typeIdx(typeOf(it.a, it.b, v, STATE[s]))] |= 1 << s;
    });
    return { v, inc, d, typeMask, pats: null, alive: null, cnt: 0, live: 0 };
  });

  // 枚举 v 的合法图案。锚点 = 图案里第一个「该有的块」，它那一段从位置 s 开始；
  // (s, 各段长度) 唯一决定一个图案，所以既不遗漏也不重复。
  const buildPats = (vp, pattern) => {
    const { v, inc, d } = vp;
    const mask = presence[v];
    const cyc = pattern.filter((t) => hasBlock(mask, t)).map(typeIdx);
    if (cyc.length === 0) return 0;
    const K = cyc.length;
    const fixed = inc.map((it) => (it.fixed >= 0 ? typeIdx(typeOf(it.a, it.b, v, STATE[it.fixed])) : -1));
    const buf = new Int8Array(d), out = [];
    const rec = (s, off, ri, rem) => {
      const block = cyc[ri], maxLen = rem - (K - 1 - ri);
      for (let len = 1; len <= maxLen; len++) {
        let ok = true;
        for (let t = 0; t < len; t++) {
          const k = (s + off + t) % d;
          if (fixed[k] >= 0 && fixed[k] !== block) { ok = false; break; }
          buf[k] = block;
        }
        if (!ok) break;                      // 再长只会更冲突
        if (ri === K - 1) { if (len === rem) out.push(buf.slice()); }
        else if (rem > len) rec(s, off + len, ri + 1, rem - len);
      }
    };
    for (let s = 0; s < d; s++) rec(s, 0, 0, d);
    vp.pats = new Int8Array(out.length * d);
    for (let i = 0; i < out.length; i++) vp.pats.set(out[i], i * d);
    vp.cnt = out.length;
    vp.alive = new Uint8Array(out.length).fill(1);
    vp.live = out.length;
    return out.length;
  };

  const dom = new Uint8Array(ne);
  const dom0 = new Uint8Array(ne).fill(15);
  for (const [e, s] of pinned) dom0[e] = 1 << s;
  const varDeg = new Int32Array(ne);
  for (let e = 0; e < ne; e++) { const [a, b] = mesh.edges[e]; varDeg[e] = mesh.deg[a] + mesh.deg[b]; }
  const stateOfBits = (bits) => 31 - Math.clz32(bits);

  let best = null;
  let abortedAll = false;

  for (const pattern of patterns) {
    let empty = false;
    for (const vp of perVertex) {
      if (buildPats(vp, pattern) === 0) {
        empty = true;
        if (!problems.some((p) => p.startsWith('顶点没有合法块分配'))) {
          problems.push(`顶点没有合法块分配：v${vp.v} 该有块[${cycleOf(presence[vp.v])}]，`
            + `但外边钉死的块位置和 REL 公理（${pattern.join('→')}）对不上`);
        }
      }
    }
    if (empty) continue;

    dom.set(dom0);
    const trail = [];        // 撤销日志，定长三条：杀图案 [0,顶点,图案] / 削定义域 [1,边,旧值]
    const queue = [];
    const inQ = new Uint8Array(perVertex.length);
    const enqueue = (i) => { if (i >= 0 && !inQ[i]) { inQ[i] = 1; queue.push(i); } };
    let backtracks = 0, aborted = false;

    // 弧相容（顶点图案 ↔ 边定义域），改动记进 trail 以便回溯
    const propagate = () => {
      let bad = false;
      while (queue.length && !bad) {
        const vi = queue.pop(); inQ[vi] = 0;
        const vp = perVertex[vi];
        const { v, inc, d, pats, alive, typeMask } = vp;
        let live = 0;
        for (let pi = 0; pi < vp.cnt; pi++) {
          if (!alive[pi]) continue;
          let good = true;
          for (let k = 0; k < d; k++) {
            const it = inc[k];
            if (it.fixed >= 0) continue;                  // 钉死的位置枚举时已判过
            if (!(dom[it.var] & typeMask[k * 4 + pats[pi * d + k]])) { good = false; break; }
          }
          if (good) live++;
          else { alive[pi] = 0; vp.live--; trail.push(0, vi, pi); }
        }
        if (live === 0) { bad = true; break; }            // 这个顶点没有可用图案了
        for (let k = 0; k < d; k++) {
          const it = inc[k];
          if (it.fixed >= 0) continue;
          let states = 0;
          for (let pi = 0; pi < vp.cnt; pi++) if (alive[pi]) states |= typeMask[k * 4 + pats[pi * d + k]];
          const nd = dom[it.var] & states;
          if (nd === 0) { bad = true; break; }
          if (nd !== dom[it.var]) {
            trail.push(1, it.var, dom[it.var]);
            dom[it.var] = nd;
            const other = it.a === v ? it.b : it.a;
            enqueue(vpOf[other]);                         // 另一头也要重筛
          }
        }
      }
      if (bad) { queue.length = 0; inQ.fill(0); }
      return bad;
    };
    const undo = (mark) => {
      for (let i = trail.length - 3; i >= mark; i -= 3) {
        const kind = trail[i], x = trail[i + 1], y = trail[i + 2];
        if (kind === 0) { perVertex[x].alive[y] = 1; perVertex[x].live++; }
        else dom[x] = y;
      }
      trail.length = mark;
    };

    for (let i = 0; i < perVertex.length; i++) enqueue(i);
    const feasible = !propagate();

    const vals = (e) => {
      let list = [0, 1, 2, 3].filter((s) => (dom[e] >> s) & 1);
      if (hintMode === 'none') return list;
      if (hintMode === 'random') {
        for (let k = list.length - 1; k > 0; k--) {
          const j = Math.floor(rng() * (k + 1));
          const t = list[k]; list[k] = list[j]; list[j] = t;
        }
        return list;
      }
      const h = hint[e];
      if (h >= 0 && list.includes(h)) list = [h, ...list.filter((s) => s !== h)];
      return list;
    };

    const dfs = () => {
      if (backtracks > maxBacktracks) { aborted = true; return false; }
      // 最少剩余取值优先（MRV），并列时挑两端度数之和大（更受约束）的边
      let pick = -1, pickCnt = 5, pickDeg = -1;
      for (let e = 0; e < ne; e++) {
        const cnt = popcnt(dom[e]);
        if (cnt === 0) return false;
        if (cnt === 1) continue;
        if (cnt < pickCnt || (cnt === pickCnt && varDeg[e] > pickDeg)) { pick = e; pickCnt = cnt; pickDeg = varDeg[e]; }
      }
      if (pick < 0) {                        // 全成单值 = 解出来了（图案级相容已保证合法）
        for (const vp of perVertex) if (vp.live === 0) return false;
        return true;
      }
      for (const s of vals(pick)) {
        const mark = trail.length;
        trail.push(1, pick, dom[pick]);
        dom[pick] = 1 << s;
        const [a, b] = mesh.edges[pick];
        enqueue(vpOf[a]); enqueue(vpOf[b]);
        if (!propagate() && dfs()) return true;
        undo(mark);
        backtracks++;
        if (aborted) return false;
      }
      return false;
    };

    if (feasible && dfs()) { best = { pattern, backtracks, assign: dom.slice() }; break; }
    if (trace) trace.push(`pattern=${pattern.join('')} 失败 回溯=${backtracks} 放弃=${aborted} 根相容=${feasible}`);
    if (aborted) abortedAll = true;
  }

  // ---- 组装 ----
  const edgeColor = new Map();
  if (best) {
    for (const e of inner) {
      const st = STATE[stateOfBits(best.assign[e])];
      const [a, b] = mesh.edges[e];
      edgeColor.set(e, {
        color: st.color,
        from: st.forward ? a : b,
        to: st.forward ? b : a,
        edge: e,
      });
    }
  } else if (problems.length === 0) {
    problems.push(abortedAll
      ? `回溯超限（${maxBacktracks}）没搜完 —— 是无解还是难搜不好说`
      : '找不到满足 REL 公理的标号（约束不可满足）');
  }

  // ---- 和斜率标号对比（一般位置下应当完全一致）----
  let same = 0, total = 0;
  if (best) {
    for (const [e, lab] of slope) {
      const mine = edgeColor.get(e);
      if (!mine) continue;
      total++;
      if (mine.color === lab.color && mine.from === lab.from) same++;
    }
  }

  return {
    ok: !!best && problems.length === 0,
    edgeColor,
    pattern: best ? best.pattern.join('') : null,
    backtracks: best ? best.backtracks : 0,
    aborted: abortedAll,
    nodes: m, degenerate,
    slopeAgree: { same, total },
    problems,
    trace,
    debug: dbg,
  };
}

/**
 * 把**外边界上的每条边**补进标号（外边不参与斜率，颜色/方向由几何定死）。
 * @returns 新的 Map（含外边）
 */
export function addOuterEdges(mesh, edgeColor, c) {
  const out = new Map(edgeColor);
  for (const { u, v, color } of outerEdgeLabels(mesh, c)) {
    const e = mesh.edgeOf.get(mesh.edgeKey(u, v));
    out.set(e, { color, from: u, to: v, outer: true, edge: e });
  }
  return out;
}

/** 某个顶点的四个块（只算内边）。*/
export function blocksAt(mesh, edgeColor, v) {
  const inRed = [], outRed = [], inBlue = [], outBlue = [];
  const cyc = [];     // 逆时针的 (edge, kind)
  for (let e = 0; e < mesh.ne; e++) {
    if (mesh.facesOfEdge[e].length !== 2) continue;
    const [a, b] = mesh.edges[e];
    if (a !== v && b !== v) continue;
    const lab = edgeColor.get(e);
    if (!lab) continue;
    const isOut = lab.from === v;
    if (lab.color === BLUE) { (isOut ? outBlue : inBlue).push(e); }
    else { (isOut ? outRed : inRed).push(e); }
    cyc.push({ e, isOut, color: lab.color, other: a === v ? b : a });
  }
  // 绕 v 的逆时针顺序：用 mesh.rot（按嵌入定向排好的出半边）
  const order = [];
  const rot = mesh.rot[v];
  for (const h of rot) {
    const e = mesh.edgeOfHe(h);
    const lab = edgeColor.get(e);
    if (!lab || mesh.facesOfEdge[e].length !== 2) continue;
    order.push({ e, isOut: lab.from === v, color: lab.color, other: mesh.heTarget(h) });
  }
  return { inRed, outRed, inBlue, outBlue, order };
}

/**
 * 每个顶点「该有的块」掩码：贴着哪面墙，就缺哪一块。
 * （下墙上的矩形底下不可能有邻居 → 缺 IB；左墙缺 IR；上墙缺 OB；右墙缺 OR。）
 * @returns {Uint8Array} 每位对应 BLOCKS 里的一个块；内点是 15
 */
export function presenceOf(mesh, c, pos = null) {
  const walls = wallChains(mesh, c, pos);
  const presence = new Uint8Array(mesh.nv).fill(15);
  for (const v of walls.bottomWall) presence[v] &= ~blockBit('IB');
  for (const v of walls.leftWall) presence[v] &= ~blockBit('IR');
  for (const v of walls.topWall) presence[v] &= ~blockBit('OB');
  for (const v of walls.rightWall) presence[v] &= ~blockBit('OR');
  return presence;
}

/**
 * 顶点 v 处、按**组合**逆时针序的块序列（**含外边**）。
 * @returns {string[]|null} 有边没有标号时返回 null
 */
export function blockSeqCCW(mesh, edgeColor, v, rot = null) {
  const list = rot || rotationOrder(mesh)[v];
  const seq = [];
  for (const w of list) {
    const lab = edgeColor.get(mesh.edgeOf.get(mesh.edgeKey(v, w)));
    if (!lab) return null;
    const isOut = lab.from === v;
    seq.push(lab.color === BLUE ? (isOut ? 'OB' : 'IB') : (isOut ? 'OR' : 'IR'));
  }
  return seq;
}

/**
 * 逆时针块序列折叠成「段」之后，必须正好是该点掩码允许的那些块，且按
 * OB → IR → IB → OR 的循环次序各连成一段（K 个块就正好 K 段）。
 * 这和 buildPats 枚举图案的规则是同一件事 —— 求解与校验必须共用同一个判定。
 */
function patternOk(seq, mask) {
  const want = BLOCKS.filter((t) => hasBlock(mask, t));
  const runs = [];
  for (const t of seq) if (runs.length === 0 || runs[runs.length - 1] !== t) runs.push(t);
  // 段可以跨过数组接缝（首尾同类算一段），所以不能先 rotate 再切
  if (runs.length > 1 && runs[0] === runs[runs.length - 1]) runs.pop();
  const extra = runs.filter((t) => !hasBlock(mask, t));
  const missing = want.filter((t) => !runs.includes(t));
  if (extra.length || missing.length || runs.length !== want.length) {
    return { ok: false, runs, want, extra, missing };
  }
  const k = want.indexOf(runs[0]);
  const rot = want.slice(k).concat(want.slice(0, k));
  return { ok: rot.join(' ') === runs.join(' '), runs, want, extra, missing };
}

/**
 * REL 公理校验。
 * @param {Mesh} mesh
 * @param {Map} edgeColor 含外边
 * @param {{S:number,E:number,N:number,W:number}} c
 * @param {{pos?:number[][]}} opts
 * @returns {{ok:boolean, problems:string[], numbers:object}}
 */
export function checkREL(mesh, edgeColor, c, opts = {}) {
  const problems = [];
  const nums = { interior: 0, blockViolations: 0, boundaryViolations: 0, outerViolations: 0 };
  const pos = opts.pos ?? null;
  const presence = presenceOf(mesh, c, pos);
  const rot = rotationOrder(mesh);

  for (let v = 0; v < mesh.nv; v++) {
    const seq = blockSeqCCW(mesh, edgeColor, v, rot[v]);
    if (!seq) { nums.blockViolations++; problems.push(`v${v} 有边没有标号`); continue; }
    const r = patternOk(seq, presence[v]);
    if (mesh.isBoundaryVert[v]) {
      // 边界点：贴着墙的块必须是空的，其余块按循环次序连成段
      if (!r.ok) {
        nums.boundaryViolations++;
        problems.push(`边界点 v${v} 的块序列不合法: 逆时针 [${seq.join(' ')}]`
          + `（该有 [${r.want.join(' ')}]${r.missing.length ? `，缺 [${r.missing.join(' ')}]` : ''}`
          + `${r.extra.length ? `，多出 [${r.extra.join(' ')}]` : ''}）`);
      }
      continue;
    }
    nums.interior++;
    if (!r.ok) {
      nums.blockViolations++;
      problems.push(`内点 v${v} 的块序列不合法: 逆时针 [${seq.join(' ')}]`
        + `（应为 [${r.want.join(' ')}] 的循环移位，每块连成一段）`);
    }
  }

  // 外边：颜色与方向都是几何定死的
  for (const { u, v, color, side } of outerEdgeLabels(mesh, c, pos)) {
    const lab = edgeColor.get(mesh.edgeOf.get(mesh.edgeKey(u, v)));
    if (!lab || lab.color !== color || lab.from !== u) {
      nums.outerViolations++;
      problems.push(`外边 ${u}-${v}（${side} 墙）应为 ${color}、from=${u}，实际 `
        + (lab ? `${lab.color}、from=${lab.from}` : '没有标号'));
    }
  }

  return { ok: problems.length === 0, problems, numbers: nums };
}

/**
 * 四面墙 = 四段边界链。角点角色已经定死了方位：
 *   S 在左下、E 在右下、N 在右上、W 在左上，
 * 所以沿逆时针走：S →(下边) E →(右边) N →(上边) W →(左边) S。
 * 边界上有 k 个点（k ≥ 4）时，四段链的长度就是各段上边界点的个数。
 * （只有边界点的矩形会碰到外框 —— 内点四块非空，四个方向都有邻居挡住。）
 *
 * 链的走向靠边界多边形的有向面积定：这里**只需要符号**，而任何一个与面定向
 * 一致的铺展（mesh.verts0 的 Tutte 嵌入、ricci 之后的平直铺展）给出的符号都一样
 * （沿外边界面走一圈的有向面积 = −Σ内面面积 < 0），所以默认用 verts0 就够，
 * 不必依赖调用方传进来的坐标。
 *
 * @param {number[][]|null} pos 可选；不给就用 mesh.verts0
 * @returns {{leftWall:number[], rightWall:number[], bottomWall:number[], topWall:number[]}}
 */
export function wallChains(mesh, c, pos = null) {
  const b = mesh.boundary, n = b.length;
  const P = pos || mesh.verts0;
  let s = 0;
  for (let i = 0; i < n; i++) {
    const p = P[b[i]], q = P[b[(i + 1) % n]];
    s += p[0] * q[1] - q[0] * p[1];
  }
  const step = s > 0 ? 1 : -1;            // s>0 说明 boundary 这圈在铺展平面里是逆时针
  const at = new Map(b.map((v, i) => [v, i]));
  const chain = (from, to) => {
    const out = [];
    let i = at.get(from);
    for (let k = 0; k < n + 1; k++) {
      out.push(b[i]);
      if (b[i] === to) break;
      i = (i + step + n) % n;
    }
    return out;
  };
  return {
    bottomWall: chain(c.S, c.E),
    rightWall: chain(c.E, c.N),
    topWall: chain(c.N, c.W),
    leftWall: chain(c.W, c.S),
  };
}

/**
 * 外边界上**每条**边的颜色与方向 —— 由几何定死，只有一种合法标法。
 *
 * 外框是轴对齐的长方形，每个边界顶点都要贴到框上，于是：
 *   * 水平的墙（下墙、上墙）上的边只能是**红**（左右相邻），方向由左到右；
 *   * 竖直的墙（左墙、右墙）上的边只能是**蓝**（上下相邻），方向由下到上。
 * 链的走向是固定的（下墙 S→E 是左→右、右墙 E→N 是下→上、上墙 N→W 是右→左、
 * 左墙 W→S 是上→下），所以上墙/左墙要反过来取 from/to。
 * 4 个角点时正好退化成 vS→vW 蓝、vS→vE 红、vW→vN 红、vE→vN 蓝。
 *
 * @param {number[][]|null} pos 可选，见 wallChains
 * @returns {{u:number, v:number, color:'B'|'R', side:'bottom'|'right'|'top'|'left'}[]}
 */
export function outerEdgeLabels(mesh, c, pos = null) {
  const w = wallChains(mesh, c, pos);
  const out = [];
  const add = (chain, color, forward, side) => {
    for (let i = 0; i + 1 < chain.length; i++) {
      out.push(forward
        ? { u: chain[i], v: chain[i + 1], color, side }
        : { u: chain[i + 1], v: chain[i], color, side });
    }
  };
  add(w.bottomWall, RED, true, 'bottom');    // S→E 方向就是左→右
  add(w.rightWall, BLUE, true, 'right');     // E→N 方向就是下→上
  add(w.topWall, RED, false, 'top');         // N→W 是右→左，反过来
  add(w.leftWall, BLUE, false, 'left');      // W→S 是上→下，反过来
  return out;
}

/** 各点的块统计（给校验表用）。*/
export function blockSummary(mesh, edgeColor) {
  let minBlocks = Infinity, bad = 0;
  for (let v = 0; v < mesh.nv; v++) {
    if (mesh.isBoundaryVert[v]) continue;
    const B = blocksAt(mesh, edgeColor, v);
    const sizes = [B.outBlue.length, B.outRed.length, B.inBlue.length, B.inRed.length];
    minBlocks = Math.min(minBlocks, ...sizes);
    if (sizes.some((s) => s === 0)) bad++;
  }
  return { minBlocks: Number.isFinite(minBlocks) ? minBlocks : 0, vertsWithEmptyBlock: bad };
}
