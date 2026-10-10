import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ACTIVITY_OPTIONS,
  CALCULATOR_COPY,
  allocateMealTarget,
  estimateMaintenance,
  getMatchingBand,
  parseNumericInput,
  validateManualMealTarget,
  type MaintenanceInput,
  type SpecialCircumstance,
} from '../src/lib/calories.ts';

const adult: MaintenanceInput = {
  age: 30,
  heightCm: 175,
  weightKg: 70,
  sexParameter: 'male',
  activity: 'sedentary',
  eligibilityConfirmed: true,
};

test('Mifflin–St Jeor male formula and activity multiplication use unrounded resting result', () => {
  const result = estimateMaintenance(adult);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.restingKcal, 1649); // Exact: 1648.75
  assert.equal(result.maintenanceKcal, 2308); // Exact: 2308.25
  assert.equal(result.activityFactor, 1.4);
  assert.equal(result.purpose, 'maintenance');
  assert.equal(result.method, 'mifflin-st-jeor');
});

test('female formula uses -161 and accepts decimal metric measurements', () => {
  const result = estimateMaintenance({
    ...adult,
    sexParameter: 'female',
    heightCm: 165.5,
    weightKg: 60.5,
    activity: 'light',
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const exact = 10 * 60.5 + 6.25 * 165.5 - 5 * 30 - 161;
  assert.equal(result.restingKcal, Math.round(exact));
  assert.equal(result.maintenanceKcal, Math.round(exact * 1.6));
});

test('all activity presets are explicit and affect maintenance only', () => {
  for (const activity of ACTIVITY_OPTIONS) {
    const result = estimateMaintenance({ ...adult, activity: activity.id });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.restingKcal, 1649);
    assert.equal(result.maintenanceKcal, Math.round(1648.75 * activity.factor));
  }
});

test('missing fields do not get hidden defaults', () => {
  const result = estimateMaintenance();
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.deepEqual(
    result.issues.map((issue) => issue.field).sort(),
    ['activity', 'age', 'eligibilityConfirmed', 'heightCm', 'sexParameter', 'weightKg'].sort(),
  );
});

test('eligibility must be positively confirmed', () => {
  for (const eligibilityConfirmed of [undefined, false, 'true', 1, null]) {
    const result = estimateMaintenance({ ...adult, eligibilityConfirmed } as MaintenanceInput);
    assert.equal(result.ok, false);
    if (!result.ok) assert(result.issues.some((issue) => issue.code === 'eligibility-required'));
  }
});

test('minors never enter the adult automatic estimate even if checkbox is true', () => {
  for (const age of [0, 12, 17, 17.99]) {
    const result = estimateMaintenance({ ...adult, age });
    assert.equal(result.ok, false);
    if (!result.ok) assert(result.issues.some((issue) => issue.code === 'adult-only'));
  }
});

test('pregnancy, lactation, eating disorders and clinical diet block automatic estimate', () => {
  const cases: SpecialCircumstance[] = [
    'pregnancy',
    'lactation',
    'eating-disorder',
    'clinical-diet',
  ];
  for (const circumstance of cases) {
    const result = estimateMaintenance({ ...adult, specialCircumstances: [circumstance] });
    assert.equal(result.ok, false);
    if (!result.ok) assert(result.issues.some((issue) => issue.code === 'professional-guidance'));
  }
});

test('unknown sex parameter and activity remain unknown rather than inferring a value', () => {
  for (const sexParameter of [undefined, 'unspecified', 'unknown', 'nonbinary']) {
    const result = estimateMaintenance({ ...adult, sexParameter } as MaintenanceInput);
    assert.equal(result.ok, false);
    if (!result.ok) assert(result.issues.some((issue) => issue.field === 'sexParameter'));
  }
  assert.equal(
    estimateMaintenance({ ...adult, activity: 'unknown' } as unknown as MaintenanceInput).ok,
    false,
  );
});

test('nonfinite, string, fractional age and out-of-range numbers fail validation', () => {
  const cases = [
    { age: NaN },
    { age: Infinity },
    { age: 30.5 },
    { age: 121 },
    { heightCm: 0 },
    { heightCm: 99 },
    { heightCm: 251 },
    { heightCm: Infinity },
    { weightKg: 0 },
    { weightKg: 24 },
    { weightKg: 351 },
    { weightKg: NaN },
    { weightKg: '70' },
    { heightCm: '175' },
  ];
  for (const patch of cases)
    assert.equal(estimateMaintenance({ ...adult, ...patch } as MaintenanceInput).ok, false);
});

test('malformed runtime input fails closed without throwing', () => {
  for (const input of [null, 'person', 123, []]) {
    assert.equal(estimateMaintenance(input as unknown as MaintenanceInput).ok, false);
  }
  for (const specialCircumstances of [null, {}, 'pregnancy']) {
    assert.equal(
      estimateMaintenance({ ...adult, specialCircumstances } as unknown as MaintenanceInput).ok,
      false,
    );
  }
});

test('adult ages outside the original study are disclosed', () => {
  for (const age of [18, 79]) {
    const result = estimateMaintenance({ ...adult, age });
    assert.equal(result.ok, true);
    if (result.ok) assert(result.warnings.some((warning) => warning.includes('19–78')));
  }
});

test('results are deterministic and do not mutate the input or share warnings', () => {
  const input = Object.freeze({ ...adult, specialCircumstances: Object.freeze([]) });
  const first = estimateMaintenance(input);
  assert.deepEqual(first, estimateMaintenance(input));
  if (first.ok) first.warnings.push('changed externally');
  const second = estimateMaintenance(input);
  if (second.ok) assert(!second.warnings.includes('changed externally'));
});

test('parsing handles missing and unknown input without zero-coercion', () => {
  for (const value of [
    undefined,
    null,
    '',
    ' ',
    'unknown',
    '70kg',
    '0x10',
    '1e3',
    'Infinity',
    NaN,
    Infinity,
  ]) {
    assert.equal(parseNumericInput(value), undefined);
  }
  assert.equal(parseNumericInput(' 70.5 '), 70.5);
  assert.equal(parseNumericInput('.5'), 0.5);
  assert.equal(parseNumericInput('0'), 0);
  assert.equal(parseNumericInput(70), 70);
});

test('meal allocation is adjustable and does not apply a weight-loss deficit', () => {
  assert.equal(allocateMealTarget(2400, 25), 600);
  assert.equal(allocateMealTarget(2400, 35), 840);
  assert.equal(allocateMealTarget(2400, 100), 2400);
  assert.equal(allocateMealTarget(2308, 33.3), 769);
  for (const [daily, percent] of [
    [0, 30],
    [-100, 30],
    [Infinity, 30],
    [NaN, 30],
    [2400, 0],
    [2400, 101],
    [2400, NaN],
    [2400, Infinity],
  ]) {
    assert.equal(allocateMealTarget(daily, percent), null);
  }
});

test('manual target works independently of any body data', () => {
  assert.deepEqual(validateManualMealTarget(650), []);
  for (const target of [0, -1, NaN, Infinity, 10001])
    assert(validateManualMealTarget(target).length > 0);
});

test('±10% band is an exact matching band, including zero-tolerance support', () => {
  assert.deepEqual(getMatchingBand(650), { min: 585, max: 715, tolerance: 0.1 });
  assert.deepEqual(getMatchingBand(650, 0), { min: 650, max: 650, tolerance: 0 });
  assert.deepEqual(getMatchingBand(650, 0.2), { min: 520, max: 780, tolerance: 0.2 });
  assert.equal(getMatchingBand(650, -0.1), null);
  assert.equal(getMatchingBand(650, 0.51), null);
  assert.equal(getMatchingBand(650, NaN), null);
  assert.equal(getMatchingBand(0), null);
  assert.equal(getMatchingBand(Infinity), null);
});

test('Chinese UI copy distinguishes estimate, matching, manual entry and privacy', () => {
  assert(CALCULATOR_COPY.matchingBand.includes('不是临床安全范围'));
  assert(CALCULATOR_COPY.estimateHelp.includes('不会自动扣减热量'));
  assert(CALCULATOR_COPY.privacy.includes('浏览器本地计算'));
  assert(CALCULATOR_COPY.skip.includes('跳过'));
  assert(CALCULATOR_COPY.sexParameterHelp.includes('性别身份'));
});
