/**
 * 一战兵棋推演 —— 单位定义与开局部署（阶段 4：移动系统）
 *
 * 规则（用户澄清版）：
 *  步兵：行动力 3，造价 20，图标=钢盔
 *  炮兵：行动力 3，造价 30，图标=火炮（攻击步兵+1，消灭敌人后不能前进）
 *  坦克：行动力 5，造价 35，图标=坦克（攻击后仍可移动）
 * 攻击相关属性本轮未用（下一阶段实现），先按移动需要定义。
 */

// 单位类型
const UNIT_TYPE = {
  INFANTRY: "infantry", // 步兵
  ARTILLERY: "artillery",// 炮兵
  TANK: "tank",         // 坦克
};

// 单位基础属性表（坦克造价已按用户要求 +5：步兵35 / 炮兵45 / 坦克55）
const UNIT_STATS = {
  [UNIT_TYPE.INFANTRY]: { name: "步兵", movePoints: 3, cost: 35 },
  [UNIT_TYPE.ARTILLERY]: { name: "炮兵", movePoints: 3, cost: 45 },
  [UNIT_TYPE.TANK]: { name: "坦克", movePoints: 5, cost: 55 },
};

/**
 * 开局部署（驻军式，用户指定）：
 *  双方【2 级城市（大城市）】部署步兵；【首都（3 级）】部署炮兵。
 * 法国：步兵 里尔(9,2)/梅斯(11,10)，炮兵 巴黎(3,7)
 * 德国：步兵 科隆(15,3)/慕尼黑(17,13)，炮兵 柏林(21,6)
 * 单位字段：{ id, type, side, col, row, movePoints, confused, attacked }
 */
function createInitialUnits() {
  const units = [];
  let id = 0;
  const add = (type, side, col, row) => {
    units.push({
      id: `u${id++}`,
      type,
      side,
      col,
      row,
      movePoints: UNIT_STATS[type].movePoints, // 当前剩余行动力（回合开始时满）
      confused: false,
      attacked: false,
      deployed: false, // 刚部署的单位本回合不能行动，下个己方回合开始解除
    });
  };

  // 遍历城市：2 级 → 步兵；3 级（首都）→ 炮兵
  for (const city of MAP.cities) {
    if (city.level === 2) {
      add(UNIT_TYPE.INFANTRY, city.owner, city.x, city.y);
    } else if (city.level === 3) {
      add(UNIT_TYPE.ARTILLERY, city.owner, city.x, city.y);
    }
  }

  return units;
}

/** 重置所有单位行动力为满值（回合切换时调用）。 */
function resetMovePoints(units) {
  for (const u of units) u.movePoints = UNIT_STATS[u.type].movePoints;
}

// 暴露到全局
window.UNIT_TYPE = UNIT_TYPE;
window.UNIT_STATS = UNIT_STATS;
window.createInitialUnits = createInitialUnits;
window.resetMovePoints = resetMovePoints;
