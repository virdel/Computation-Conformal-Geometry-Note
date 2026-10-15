// 「导入自己的图」浮层：选文件 / 拖到窗口任意处 / 粘贴文本。
//
// 解析和修补全在 graphfile.js 里，这里只负责把结果**逐条**摆出来 ——
// 这个界面的立场和两张手写地图一样：偏离（自动修补）不藏起来，
// 修不掉的明说卡在哪一条。
import { useEffect, useRef, useState } from 'react';
import { EXAMPLES } from '../core/examples.js';
import { parseGraphFile, graphToPreset } from '../core/graphfile.js';

const REPAIR_LABEL = {
  point: '补对角线（只交于一点）',
  diagonal: '补对角线（四边形是团）',
  steiner: '插人工点（面不是团）',
  merge: '并入邻点（度不够）',
  flip: '翻边（分离三角形）',
  cut: '剪开（球面沿度 4 顶点）',
};

const EDGE_DOC = `# 边表：每行一条「u v」；# 是注释
# corners: 0 3 7 4     ← 可选：外圈上逆时针的 4 个角点 S E N W
# boundary: 0 1 2 3    ← 可选：外圈（一般平面图必须给；三角剖分不用）
# pos: 0 0.1 0.2       ← 可选：顶点坐标（只用来画 ①）
8 13
0 1
1 2`;

const JSON_DOC = `{ "name": "hex7", "nv": 7,
  "faces": [[0,1,6],[1,2,6],[2,3,6],
            [3,4,6],[4,5,6],[5,0,6]],
  "corners": {"S":4,"E":0,"N":2,"W":3},
  "pos": [[1,0],[0.5,0.866],[-0.5,0.866],
          [-1,0],[-0.5,-0.866],[0.5,-0.866],[0,0]],
  "names": ["东","东北","西北","西","西南","东南","心"] }`;

export default function ImportPanel({ onClose, onLoad, current }) {
  const [text, setText] = useState('');
  const [res, setRes] = useState(null);
  const [drag, setDrag] = useState(false);
  const [fileName, setFileName] = useState('');
  const fileRef = useRef(null);

  /** 一条路径：文本 → 解析 → 修补 → preset（成功就交给 App 去算）。*/
  const take = (src, name) => {
    const pa = parseGraphFile(src, { name: name || '导入的图' });
    if (!pa.ok) {
      setRes({ ok: false, name, problems: pa.problems, notes: pa.notes, repairs: [] });
      return;
    }
    const g = graphToPreset(pa.graph);
    const r = g.preset ? g.preset.report : null;
    setRes({
      ok: g.ok, name: g.preset ? g.preset.name : name,
      problems: g.problems, notes: g.notes, repairs: g.repairs,
      summary: r ? `V=${r.nv} E=${r.ne} F=${r.nf}，外圈 ${r.boundaryLen} 点`
        + (r.cornerNames ? `，角点 ${r.cornerNames.S} / ${r.cornerNames.E} / ${r.cornerNames.N} / ${r.cornerNames.W}` : '')
        + `，自动修补 ${r.repairs} 条` : '',
    });
    if (g.ok) onLoad(g.preset);
  };

  const readFile = (file) => {
    if (!file) return;
    setFileName(file.name);
    file.text().then((t) => take(t, file.name.replace(/\.[^.]+$/, '')))
      .catch((e) => setRes({ ok: false, name: file.name, problems: [`读不出来：${e.message}`], notes: [], repairs: [] }));
  };

  // 拖到窗口**任意处**都算（不只是这个浮层）—— 拖进来时整个浮层给一层高亮
  useEffect(() => {
    const stop = (ev) => { ev.preventDefault(); ev.stopPropagation(); };
    const over = (ev) => { stop(ev); setDrag(true); };
    const leave = (ev) => { stop(ev); if (!ev.relatedTarget) setDrag(false); };
    const drop = (ev) => {
      stop(ev);
      setDrag(false);
      const f = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
      if (f) readFile(f);
    };
    window.addEventListener('dragover', over);
    window.addEventListener('dragenter', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragenter', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  }, []);

  return (
    <div className="help-mask" onClick={onClose}>
      <div className={`help imp${drag ? ' imp-drag' : ''}`} onClick={(ev) => ev.stopPropagation()}>
        <h2>导入自己的图</h2>
        <p>
          丢进来一张**平面三角剖分**（或者一张声明了外圈的一般平面图），
          它会走和上面那些例子完全相同的流水线：① 输入图 → ② Ricci 流平直铺展 →
          ③ 方块填充 → ④ 圆盘填充。文件里的坐标只用来画 ①，②③④ 只由拓扑决定。
        </p>

        <div className="imp-drop">
          {drag ? '松手就导入' : '把文件拖到窗口任意处 · 或者'}
          {' '}
          <button className="btn tiny" onClick={() => fileRef.current && fileRef.current.click()}>选一个文件…</button>
          <input ref={fileRef} type="file" accept=".txt,.json,.gr,.edges,text/plain,application/json"
            style={{ display: 'none' }}
            onChange={(ev) => { readFile(ev.target.files && ev.target.files[0]); ev.target.value = ''; }} />
          {fileName ? <span className="hint-sub">（刚读的是 {fileName}）</span> : null}
        </div>

        <textarea className="imp-text" value={text} spellCheck={false}
          placeholder="也可以把内容直接粘在这里（边表或 JSON 都行）"
          onChange={(ev) => setText(ev.target.value)} />
        <div className="imp-row">
          <button className="btn" disabled={!text.trim()} onClick={() => take(text, '粘贴的文本')}>导入这段文本</button>
          <button className="btn tiny" onClick={() => { setText(EDGE_DOC); }}>填入边表范例</button>
          <button className="btn tiny" onClick={() => { setText(JSON_DOC); }}>填入 JSON 范例</button>
        </div>

        <h2>示例（点一下就走同一条解析路径）</h2>
        <div className="chips">
          {EXAMPLES.map((ex) => (
            <button key={ex.id} className="chip imp" onClick={() => { setText(ex.text); setFileName(ex.id); take(ex.text, ex.id); }}>
              {ex.id}
            </button>
          ))}
        </div>
        <div className="hint">
          {EXAMPLES.map((ex) => <div key={ex.id}><b>{ex.title}</b> — {ex.note}</div>)}
        </div>

        {res ? (
          <div className={`imp-res${res.ok ? ' ok' : ' bad'}`}>
            <div className="imp-head">
              {res.ok ? '✓ 载入成功' : '✗ 拒绝'}：{res.name || '（没名字）'}
            </div>
            {res.ok ? <div className="stat-note">{res.summary}</div> : null}
            {res.problems.length ? (
              <div className="imp-list">
                {res.problems.map((p, i) => <div key={`p${i}`} className="imp-bad">· {p}</div>)}
              </div>
            ) : null}
            {res.notes.length ? (
              <div className="imp-list">
                {res.notes.map((n, i) => <div key={`n${i}`}>{n}</div>)}
              </div>
            ) : null}
            {res.repairs.length ? (
              <>
                <div className="imp-head">自动修补（{res.repairs.length} 条，每条都改动了图的组合结构）</div>
                <div className="imp-list">
                  {res.repairs.map((r, i) => (
                    <div key={`r${i}`}><b>{REPAIR_LABEL[r.kind] || r.kind}</b> <span className="stat-why">{r.why}</span></div>
                  ))}
                </div>
              </>
            ) : (res.ok ? <div className="stat-note">没有做任何修补 —— 这张图本来就是合格的圆盘三角剖分。</div> : null)}
          </div>
        ) : null}

        <h2>两种格式</h2>
        <p className="help-note">
          首字符是 <b>{'{'}</b> 就按 JSON 读，否则按边表读。下标默认 0 基；
          出现等于 nv 的下标（或「n m」表头里出现 n）就按 1 基读，界面上会说明用了哪个基。
        </p>
        <pre className="imp-code">{EDGE_DOC}</pre>
        <pre className="imp-code">{JSON_DOC}</pre>
        <div className="hint">
          JSON 里 <b>faces 只放三角形内面</b>（外面不要放），边会自动从面里推出来；
          也可以给 <b>edges</b> 代替 faces。corners / pos / names 都可省。
          什么都不给时，面和 4 个角点都自动算 —— 只要外圈上度 2 的点不超过 4 个。
        </div>

        {current ? <div className="hint-sub">当前看的是导入的「{current}」（左边的 chip 可以切回内置图）</div> : null}
        <button className="btn" onClick={onClose}>{res && res.ok ? '看结果' : '关闭'}</button>
      </div>
    </div>
  );
}
