# Optional calorie estimation: method and boundaries

Checked against primary/official sources on 2026-10-09. This module is a Chinese-language menu-planning aid, not a clinical calculator or a validated assessment for Chinese populations.

## Calculation

The original Mifflin–St Jeor study derived resting energy expenditure from 498 healthy adults aged 19–78. This implementation uses its simplified equations, in kcal/day:

- Male formula parameter: `10 × weightKg + 6.25 × heightCm − 5 × age + 5`
- Female formula parameter: `10 × weightKg + 6.25 × heightCm − 5 × age − 161`

Source: [Mifflin et al., American Journal of Clinical Nutrition, 1990, DOI 10.1093/ajcn/51.2.241](https://pubmed.ncbi.nlm.nih.gov/2305711/?dopt=Abstract). The equation estimates resting expenditure, not a measured daily intake requirement. The two coefficients are model parameters, not an inference about gender identity. Missing, unknown, or inapplicable parameters yield no estimate; there is no averaging or automatic choice.

Approximate maintenance energy = unrounded resting estimate × explicitly selected activity preset. Display values round to integer kcal. Presets are 1.4 (mostly sedentary), 1.6 (light), 1.8 (moderate), and 2.0 (high). These are **coarse application choices**, not individually validated activity classifications. NIDDK describes a typical physical-activity-level range of 1.4–2.5 and describes 1.6 as mostly sitting with some moderate activity. We use that as context for the presets; we do not reproduce or claim equivalence to NIDDK's dynamic weight planner. [NIDDK Body Weight Planner](https://www.niddk.nih.gov/bwp)

No deficit, goal weight, weight-loss rate, or minimum-safe-intake prescription exists in this module. Meal target = maintenance estimate × the user's adjustable percentage, rounded to integer kcal. The percentage is a planning choice rather than a recommended meal distribution. Manual entry is always available and requires no body measurements.

## Eligibility and guardrails

- The first question must be optional: estimate, or skip directly to a manual meal target.
- An affirmative eligibility statement is required before estimation. Anyone under 18, pregnant, breastfeeding, experiencing an eating disorder, or needing clinical dietary management must not be routed into this automatic adult calculation. They can browse the menu or use an appropriate professionally supplied plan.
- NIDDK excludes under-18, pregnant, and breastfeeding users and states that its information is not medical advice. Its guidance also points people with specific health questions to their healthcare provider. This product's additional eating-disorder and clinical-diet exclusions are conservative design decisions. [NIDDK](https://www.niddk.nih.gov/bwp)
- NIMH identifies eating disorders as serious illnesses requiring appropriate treatment; its discussion supports avoiding automated general-purpose dietary targets in that context. [NIMH Eating Disorders](https://www.nimh.nih.gov/health/topics/eating-disorders)
- Ages 18 and over 78 receive an explicit warning that they are outside the original study's age range. No independent validation for Chinese users, athletes, or particular medical conditions is claimed.
- Runtime validation requires finite numeric values. Age must be a whole number from 18–120; height is 100–250 cm; weight is 25–350 kg. These broad **software input bounds are not clinical eligibility or healthy-body ranges**. Manual meal input accepts 1–10,000 kcal as a computational range only, with no judgment of nutritional suitability. Numbers outside these ranges must not be silently clamped.
- Activity and the formula's sex parameter are mandatory only if the user chooses calculation. Missing/unknown inputs are surfaced, never guessed.
- The default ±10% range is exclusively a menu-matching band. It is **not** an uncertainty interval, clinical safety margin, nutritional adequacy check, or promise of accurate calorie estimation. Meeting a calorie target alone does not establish a balanced meal.

## Privacy and integration

`calories.ts` is pure TypeScript with no network, logging, storage, browser-global, or third-party dependency. Call it locally in the browser. Do not add age, sex parameter, height, weight, or special circumstances to a model prompt, request payload, analytics event, URL, or persistent storage. Send only independently authorized menu inputs to any external service. Skipping the estimator must work without requesting these details.

Exports: `MaintenanceInput`, `MaintenanceResult`, `ValidationIssue`, `ActivityLevel`, `SexParameter`, `SpecialCircumstance`, `estimateMaintenance`, `ACTIVITY_OPTIONS`, `CALCULATOR_COPY`, `CALORIE_SOURCES`, `CALCULATOR_INPUT_LIMITS`, `parseNumericInput`, `allocateMealTarget`, `validateManualMealTarget`, and `getMatchingBand`.

Tests cover both formulas, fractional measurements, all activity presets, missing/unknown and malformed inputs, adult eligibility, all special circumstances, study-age caveats, no mutation, input parsing, adjustable allocation, manual targets, matching-band edges, and the key caution/privacy copy.
