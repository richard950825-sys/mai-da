/**
 * Optional, browser-local adult maintenance estimate. No network, storage, weight-loss
 * deficit, or clinical-safety inference belongs in this module. See docs/calorie-method.md.
 */

export type SexParameter = 'male' | 'female' | 'unspecified';
export type ActivityLevel = 'sedentary' | 'light' | 'moderate' | 'high';
export type SpecialCircumstance = 'pregnancy' | 'lactation' | 'eating-disorder' | 'clinical-diet';

export interface MaintenanceInput {
  age?: number;
  heightCm?: number;
  weightKg?: number;
  sexParameter?: SexParameter;
  activity?: ActivityLevel;
  /** Explicit confirmation of the eligibility statement in CALCULATOR_COPY. */
  eligibilityConfirmed?: boolean;
  /** Optional detail. Any supplied circumstance blocks automatic estimation. */
  specialCircumstances?: readonly SpecialCircumstance[];
}

export type ValidationField = keyof MaintenanceInput | 'input' | 'targetKcal';
export type ValidationCode =
  | 'required'
  | 'invalid'
  | 'out-of-range'
  | 'adult-only'
  | 'eligibility-required'
  | 'professional-guidance'
  | 'unsupported-parameter';

export interface ValidationIssue {
  field: ValidationField;
  code: ValidationCode;
  message: string;
}

export interface MaintenanceEstimate {
  ok: true;
  method: 'mifflin-st-jeor';
  purpose: 'maintenance';
  /** kcal/day, rounded for display; not an intake prescription. */
  restingKcal: number;
  /** Computed from the unrounded resting estimate. */
  maintenanceKcal: number;
  activityFactor: number;
  warnings: string[];
}

export type MaintenanceResult = MaintenanceEstimate | { ok: false; issues: ValidationIssue[] };

export interface ActivityOption {
  readonly id: ActivityLevel;
  readonly label: string;
  readonly description: string;
  readonly factor: number;
}

/** Coarse product presets, not clinically validated activity measurements. */
export const ACTIVITY_OPTIONS: readonly ActivityOption[] = Object.freeze([
  Object.freeze({
    id: 'sedentary',
    label: '以坐着为主',
    description: '日常活动较少，粗略系数 1.4',
    factor: 1.4,
  }),
  Object.freeze({
    id: 'light',
    label: '轻度活动',
    description: '以坐着为主，偶尔步行或骑车，粗略系数 1.6',
    factor: 1.6,
  }),
  Object.freeze({
    id: 'moderate',
    label: '中等活动',
    description: '日常走动较多或规律运动，粗略系数 1.8',
    factor: 1.8,
  }),
  Object.freeze({
    id: 'high',
    label: '较多活动',
    description: '日常体力活动或运动较多，粗略系数 2.0',
    factor: 2.0,
  }),
]);

export const CALCULATOR_COPY = Object.freeze({
  firstQuestion: '要先粗略估算一下每日维持热量吗？',
  yes: '先估算一下',
  skip: '跳过，直接填写这餐目标',
  eligibility: '我已满 18 岁，且不处于孕期或哺乳期，没有进食障碍或需要专业管理的临床饮食需求',
  eligibilityHelp:
    '未成年人、孕期或哺乳期、有进食障碍或临床饮食需求的人，请跳过自动估算，使用专业人员提供的计划或只浏览菜单',
  sexParameter: '公式使用的性别参数',
  sexParameterHelp:
    '原公式只有男、女两组系数。这不是对性别身份的判断；不确定、不适用或不愿提供时，可跳过估算并手动填写目标',
  estimateHelp:
    '这是每日维持热量的粗略估计，不会自动扣减热量，也不是减重处方。实际需要会因身体情况和活动量而变化',
  activityHelp: '活动系数是粗略预设，并非个人活动量测量；本工具也未针对中国人群做独立验证',
  mealAllocationHelp: '这餐占每日估计的比例可自行调整；比例用于安排这餐，不代表推荐的饮食分配',
  manualTargetHelp: '手动目标只用于匹配菜单，不代表本工具认可它适合你的健康状况',
  matchingBand: '±10% 只是菜单热量的匹配范围，不是临床安全范围、营养达标线或估算准确度保证',
  privacy: '年龄、身高、体重等资料仅用于浏览器本地计算，不需要发送给外部模型',
});

export const CALORIE_SOURCES = Object.freeze([
  Object.freeze({
    label: 'Mifflin–St Jeor 原始研究（1990）',
    url: 'https://pubmed.ncbi.nlm.nih.gov/2305711/?dopt=Abstract',
  }),
  Object.freeze({
    label: 'NIDDK 成人计算器适用范围与活动水平说明',
    url: 'https://www.niddk.nih.gov/bwp',
  }),
  Object.freeze({
    label: 'NIMH 进食障碍资料',
    url: 'https://www.nimh.nih.gov/health/topics/eating-disorders',
  }),
]);

/** Engineering input bounds only. These are not healthy-body or safe-intake ranges. */
export const CALCULATOR_INPUT_LIMITS = Object.freeze({
  age: Object.freeze({ min: 18, max: 120 }),
  heightCm: Object.freeze({ min: 100, max: 250 }),
  weightKg: Object.freeze({ min: 25, max: 350 }),
  manualMealKcal: Object.freeze({ min: 1, max: 10000 }),
});

/** Empty/unknown values stay missing. Never silently coerce blanks to zero. */
export function parseNumericInput(value: string | number | null | undefined): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  // Accept plain decimal UI input, not partial strings, hex, or exponent syntax.
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(trimmed)) return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function validateNumber(
  value: unknown,
  field: 'age' | 'heightCm' | 'weightKg',
  label: string,
): ValidationIssue | undefined {
  if (value === undefined || value === null)
    return { field, code: 'required', message: `请填写${label}，或跳过估算` };
  if (typeof value !== 'number' || !Number.isFinite(value))
    return { field, code: 'invalid', message: `请填写有效的${label}数值` };
  if (field === 'age' && value < 18)
    return {
      field,
      code: 'adult-only',
      message: '未满 18 岁不使用成人自动估算，请使用专业人员提供的计划或只浏览菜单',
    };
  if (field === 'age' && !Number.isInteger(value))
    return { field, code: 'invalid', message: '年龄请填写已满的整数岁数' };
  const limits = CALCULATOR_INPUT_LIMITS[field];
  if (value < limits.min || value > limits.max)
    return {
      field,
      code: 'out-of-range',
      message: `${label}超出本工具可填写的范围（${limits.min}–${limits.max}）；请核对单位，或使用专业人员提供的目标`,
    };
  return undefined;
}

/** All guards run before the formula; missing sex/activity never selects a default. */
export function estimateMaintenance(input: MaintenanceInput = {}): MaintenanceResult {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return {
      ok: false,
      issues: [{ field: 'input', code: 'invalid', message: '估算资料无效，请重新填写或跳过' }],
    };
  }
  const issues: ValidationIssue[] = [];
  if (input.eligibilityConfirmed !== true)
    issues.push({
      field: 'eligibilityConfirmed',
      code: 'eligibility-required',
      message: '请先确认适用范围；不确定或不适用时，请跳过自动估算',
    });
  if (input.specialCircumstances !== undefined && !Array.isArray(input.specialCircumstances)) {
    issues.push({
      field: 'specialCircumstances',
      code: 'invalid',
      message: '适用范围资料无效，请重新确认或跳过估算',
    });
  } else if (input.specialCircumstances?.length) {
    issues.push({
      field: 'specialCircumstances',
      code: 'professional-guidance',
      message: CALCULATOR_COPY.eligibilityHelp,
    });
  }
  for (const [field, label] of [
    ['age', '年龄'],
    ['heightCm', '身高（厘米）'],
    ['weightKg', '体重（公斤）'],
  ] as const) {
    const issue = validateNumber(input[field], field, label);
    if (issue) issues.push(issue);
  }
  if (input.sexParameter !== 'male' && input.sexParameter !== 'female')
    issues.push({
      field: 'sexParameter',
      code: input.sexParameter === undefined ? 'required' : 'unsupported-parameter',
      message: CALCULATOR_COPY.sexParameterHelp,
    });
  const activity = ACTIVITY_OPTIONS.find((option) => option.id === input.activity);
  if (!activity)
    issues.push({
      field: 'activity',
      code: input.activity === undefined ? 'required' : 'invalid',
      message: '请选择日常活动水平；不确定时可跳过估算并手动填写目标',
    });
  if (issues.length) return { ok: false, issues };

  // The guards above establish all required inputs and formula parameters.
  const restingRaw =
    10 * input.weightKg! +
    6.25 * input.heightCm! -
    5 * input.age! +
    (input.sexParameter === 'male' ? 5 : -161);
  if (!Number.isFinite(restingRaw) || restingRaw <= 0)
    return {
      ok: false,
      issues: [
        {
          field: 'input',
          code: 'out-of-range',
          message: '这组数据无法得出可用估计，请核对资料或使用专业人员提供的目标',
        },
      ],
    };
  const warnings: string[] = [CALCULATOR_COPY.estimateHelp, CALCULATOR_COPY.activityHelp];
  if (input.age! < 19 || input.age! > 78)
    warnings.push(
      '原始研究的受试者为 19–78 岁；你的年龄超出该研究范围，估计更不确定，建议优先使用专业人员提供的目标',
    );
  return {
    ok: true,
    method: 'mifflin-st-jeor',
    purpose: 'maintenance',
    restingKcal: Math.round(restingRaw),
    maintenanceKcal: Math.round(restingRaw * activity!.factor),
    activityFactor: activity!.factor,
    warnings,
  };
}

/** A mathematical meal allocation, not a recommended allocation or calorie deficit. */
export function allocateMealTarget(dailyKcal: number, percent: number): number | null {
  if (
    !Number.isFinite(dailyKcal) ||
    dailyKcal <= 0 ||
    dailyKcal > 100000 ||
    !Number.isFinite(percent) ||
    percent < 1 ||
    percent > 100
  )
    return null;
  const target = Math.round((dailyKcal * percent) / 100);
  return target > 0 ? target : null;
}

/** Validates a menu-matching number only, not nutritional suitability. */
export function validateManualMealTarget(kcal: number): ValidationIssue[] {
  const limits = CALCULATOR_INPUT_LIMITS.manualMealKcal;
  if (typeof kcal !== 'number' || !Number.isFinite(kcal))
    return [{ field: 'targetKcal', code: 'invalid', message: '请输入有效的这餐目标热量（kcal）' }];
  if (kcal < limits.min || kcal > limits.max)
    return [
      {
        field: 'targetKcal',
        code: 'out-of-range',
        message: `菜单匹配目标需在 ${limits.min}–${limits.max} kcal 内；此输入范围不代表安全摄入范围`,
      },
    ];
  return [];
}

export interface MatchingBand {
  min: number;
  max: number;
  tolerance: number;
}

/** The ±10% default is a matching constraint, never a medical safety interval. */
export function getMatchingBand(targetKcal: number, tolerance = 0.1): MatchingBand | null {
  if (
    validateManualMealTarget(targetKcal).length ||
    !Number.isFinite(tolerance) ||
    tolerance < 0 ||
    tolerance > 0.5
  )
    return null;
  return {
    min: Number((targetKcal * (1 - tolerance)).toFixed(8)),
    max: Number((targetKcal * (1 + tolerance)).toFixed(8)),
    tolerance,
  };
}
