// 三个内联的示例图文件 —— 导入浮层的「用示例」按钮和 check.mjs 第 9 节读的是**同一份**字面量。
//
// 故意不落成 data/*.txt 再去 fetch：那样 SSR 自检、打包、单测都得先架一个文件服务，
// 而且「界面上按的示例」和「自检里跑的文件」会变成两份可以各自飘走的东西。
//
// 三个例子分别压不同的路径：
//   hex7.json    JSON + faces + pos + names + 声明的 corners（最精确的一条）
//   grid2x4.txt  边表 + `n m` 表头 + `# corners:`（网格族，用户手上最常见的东西）
//   wheel7.txt   边表、什么都不声明 —— 面和外圈全靠 3-团法恢复，角点自动选

export const EXAMPLES = [
  {
    id: 'hex7.json',
    title: 'hex7.json — JSON 三角剖分（7 点）',
    note: 'JSON 路径：faces 给的都是**三角形内面**，pos 只用来画 ①，corners 声明了 4 个角点。',
    text: `{
  "name": "hex7",
  "nv": 7,
  "faces": [[0,1,6],[1,2,6],[2,3,6],[3,4,6],[4,5,6],[5,0,6]],
  "corners": {"S": 4, "E": 0, "N": 2, "W": 3},
  "pos": [[1,0],[0.5,0.866],[-0.5,0.866],[-1,0],[-0.5,-0.866],[0.5,-0.866],[0,0]],
  "names": ["东", "东北", "西北", "西", "西南", "东南", "心"]
}
`,
  },
  {
    id: 'grid2x4.txt',
    title: 'grid2x4.txt — 边表 + 声明角点（2×4 网格，8 点）',
    note: '边表路径：首行 `n m` 是表头，`# corners:` 按外圈逆时针声明 S/E/N/W；'
      + '面和外圈由 3-团法恢复。',
    text: `# grid2x4 —— 2 行 4 列的三角网格；顶点 i*4+j（i = 行，j = 列）
# corners: 0 3 7 4
# name: grid2x4
8 13
0 1
1 2
2 3
4 5
5 6
6 7
0 4
1 5
2 6
3 7
0 5
1 6
2 7
`,
  },
  {
    id: 'wheel7.txt',
    title: 'wheel7.txt — 边表、什么都不声明（轮子，8 点）',
    note: '0 是轮心，1…7 是轮缘。没给 corners ⟹ 角点自动选；没给坐标 ⟹ ① 用 Tutte 嵌入画。',
    text: `# wheel7 —— 轮心 0 连着轮缘 1…7，轮缘成一个圈
8 14
0 1
0 2
0 3
0 4
0 5
0 6
0 7
1 2
2 3
3 4
4 5
5 6
6 7
7 1
`,
  },
];

/** 按 id 取一个示例（找不到返回 undefined）。*/
export function exampleById(id) {
  return EXAMPLES.find((x) => x.id === id);
}
