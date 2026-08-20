/**
 * 一战兵棋推演 —— 地图数据（阶段 1：地图预览）
 *
 * 规则来源：D:\jr-game\兵棋游戏设想.txt（用户澄清版）
 *  - 地图：一战法国(蓝/左) vs 德国(红/右)，无英无殖民地，公平开局
 *  - 地形：平原/森林/山地/河流/城市（河流不可站，画在格边）
 *  - 收入：双方城市总收入各 80（3级15 + 2级10×2 + 1级5×9 = 80）
 */

// 地形类型常量
const TERRAIN = {
  PLAIN: 0,     // 平原
  FOREST: 1,    // 森林
  MOUNTAIN: 2,  // 山地
};

// 归属常量
const SIDE = {
  FR: "fr", // 法国（蓝）
  DE: "de", // 德国（红）
};

/**
 * 生成地形二维数组：rows 行 × cols 列。
 * 0=平原 1=森林 2=山地
 * 用确定性图案（非随机），保证每次打开地图一致：
 *  - 阿登森林：x 10~14, y 2~7，棋盘纹理
 *  - 孚日山地：x 8~10, y 9~13，条带纹理
 *  - 德国森林：x 17~19, y 9~12，棋盘纹理
 */
function buildTerrain(cols, rows) {
  const t = Array.from({ length: rows }, () => Array(cols).fill(TERRAIN.PLAIN));

  // 阿登森林（比利时-卢森堡一带，法德边境中北部）
  for (let y = 2; y <= 7; y++) {
    for (let x = 10; x <= 14; x++) {
      if ((x + y) % 2 === 0) t[y][x] = TERRAIN.FOREST;
    }
  }
  // 孚日山地（法国东部，莱茵河西侧）
  for (let y = 9; y <= 13; y++) {
    for (let x = 8; x <= 10; x++) {
      if ((x * 2 + y) % 3 !== 0) t[y][x] = TERRAIN.MOUNTAIN;
    }
  }
  // 德国中部小片森林（普法尔茨一带）
  for (let y = 9; y <= 12; y++) {
    for (let x = 17; x <= 19; x++) {
      if ((x + y) % 2 === 1) t[y][x] = TERRAIN.FOREST;
    }
  }
  return t;
}

/**
 * 地图定义。
 * rivers: 河流线段（网格线坐标，可带 .5 表示格与格之间的边），[x1,y1,x2,y2]
 * cities: 城市 {id,name,level,owner,x,y}；level: 3首都(15) 2大城市(10) 1城镇(5)
 */
const MAP = {
  cols: 24,
  rows: 16,
  terrain: null, // 在下方初始化

  // 两条南北向河流：马斯河(x=8，第7/8列之间，法国境内) 与 莱茵河(x=14，第13/14列之间，法德边界)
  // 注意：河流必须画在【整数格线】上（两地块之间），不能落在地块中间（规则："处于两地块之间，不能站上去"）
  rivers: [
    [8, 1, 8, 14],       // 马斯河
    [14, 1, 14, 14],     // 莱茵河
  ],

  cities: [
    // ── 法国（蓝，左）—— 收入 15+10+10+5×9 = 80 ──
    { id: "paris",    name: "巴黎",     level: 3, owner: SIDE.FR, x: 3,  y: 7 },
    { id: "lille",    name: "里尔",     level: 2, owner: SIDE.FR, x: 9,  y: 2 },
    { id: "metz",     name: "梅斯",     level: 2, owner: SIDE.FR, x: 11, y: 10 },
    { id: "rouen",    name: "鲁昂",     level: 1, owner: SIDE.FR, x: 2,  y: 4 },
    { id: "amiens",   name: "亚眠",     level: 1, owner: SIDE.FR, x: 7,  y: 3 },
    { id: "reims",    name: "兰斯",     level: 1, owner: SIDE.FR, x: 9,  y: 6 },
    { id: "verdun",   name: "凡尔登",   level: 1, owner: SIDE.FR, x: 9,  y: 9 },
    { id: "nancy",    name: "南锡",     level: 1, owner: SIDE.FR, x: 10, y: 11 },
    { id: "orleans",  name: "奥尔良",   level: 1, owner: SIDE.FR, x: 4,  y: 9 },
    { id: "dijon",    name: "第戎",     level: 1, owner: SIDE.FR, x: 5,  y: 12 },
    { id: "bourges",  name: "布尔日",   level: 1, owner: SIDE.FR, x: 4,  y: 13 },
    { id: "tours",    name: "图尔",     level: 1, owner: SIDE.FR, x: 1,  y: 11 },

    // ── 德国（红，右）—— 收入 15+10+10+5×9 = 80 ──
    { id: "berlin",   name: "柏林",     level: 3, owner: SIDE.DE, x: 21, y: 6 },
    { id: "koln",     name: "科隆",     level: 2, owner: SIDE.DE, x: 15, y: 3 },
    { id: "munchen",  name: "慕尼黑",   level: 2, owner: SIDE.DE, x: 17, y: 13 },
    { id: "aachen",   name: "亚琛",     level: 1, owner: SIDE.DE, x: 13, y: 4 },
    { id: "bonn",     name: "波恩",     level: 1, owner: SIDE.DE, x: 16, y: 4 },
    { id: "frankfurt",name: "法兰克福", level: 1, owner: SIDE.DE, x: 18, y: 7 },
    { id: "leipzig",  name: "莱比锡",   level: 1, owner: SIDE.DE, x: 20, y: 4 },
    { id: "dresden",  name: "德累斯顿", level: 1, owner: SIDE.DE, x: 22, y: 8 },
    { id: "hamburg",  name: "汉堡",     level: 1, owner: SIDE.DE, x: 21, y: 2 },
    { id: "bremen",   name: "不来梅",   level: 1, owner: SIDE.DE, x: 19, y: 2 },
    { id: "stuttgart",name: "斯图加特", level: 1, owner: SIDE.DE, x: 15, y: 11 },
    { id: "nurnberg", name: "纽伦堡",   level: 1, owner: SIDE.DE, x: 19, y: 11 },
  ],
};

// 初始化地形（固定随机种子区域，避免每次刷新地图都变）
MAP.terrain = buildTerrain(MAP.cols, MAP.rows);

// 记录城市初始归属（用于占领收益：本国 15/10/5，占领地 12/7/3）
for (const c of MAP.cities) c.initialOwner = c.owner;

/** 计算一方的城市收入：本国城市 3级15/2级10/1级5；占领的敌方城市 3级10/2级5/1级2。 */
function sideIncome(side) {
  return MAP.cities
    .filter((c) => c.owner === side)
    .reduce((sum, c) => {
      const base = c.level === 3 ? 15 : c.level === 2 ? 10 : 5;
      const occupied = c.initialOwner === side ? base : c.level === 3 ? 10 : c.level === 2 ? 5 : 2;
      return sum + occupied;
    }, 0);
}

// 暴露到全局（普通 script 标签共享）
window.MAP = MAP;
window.TERRAIN = TERRAIN;
window.SIDE = SIDE;
window.sideIncome = sideIncome;
