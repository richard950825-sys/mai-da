# 麦搭 UI design system

The separately retained design concept is an internal specification, not product data. Reference images are not redistributed with the app source. Actual Mobbin screenshots inspected: https://mobbin.com/screens/3f7253ba-8294-4be9-be01-6ce9fe3232f0 and https://mobbin.com/screens/1bcbf1aa-2727-4e59-b388-6f52962d6dbb . Also inspected pickup/delivery address and review screens in https://mobbin.com/flows/0519347f-ca84-4542-a0a9-ad6c15e093a8 and https://mobbin.com/flows/03f68e56-1e2b-4144-a835-62f540f9cfe3 . US product names, USD prices and nutrition are visual references only; never used as China menu data.

White canvas #ffffff; surface #f7f7f7; text #171717; muted #747474; border #dedede; yellow #ffbc0d; red #db241c. Black headings and yellow action controls form hierarchy. Borders instead of card shadows; 8–12px radii, circles only for compact actions. Desktop shell: 84px header, max-width 1440, 64px gutters; question column 64%, editorial rail 36%. Workspace: step rail, open task column, restrained summary rail. Mobile: one column, 22px gutters, no decorative rail. Body system sans-serif; 16px body/14px utility; question 54px desktop/34px phone; no tiny legal text below 12px. Code-native icons stroke1.7.

After connecting the account, preserve the planner question: “是否需要帮你规划本餐热量？”; choices “需要，帮我估算” and “不用，直接开始”. First no-calorie path leads directly to the same composer used by calculator completion. No nonfunctional navigation. Body data remains component memory, never localStorage/network. No production fixtures or silently substituted products/prices.


## Product homepage and entry flow

The public `/` route introduces the app before requesting an account connection. The CTA links to `/connect`; successful token entry continues to `/plan`. `/owner/setup` remains a compatible account-change entry. The homepage does not fetch account status, open a credential session or depend on a running API.

Mobbin references inspected for this homepage:

- [McDonald’s welcome](https://mobbin.com/screens/102c2c8b-f04f-4d33-8fef-51fbf05b70ca): strong headline, white space, food imagery and a clear yellow action.
- [McDonald’s home](https://mobbin.com/screens/81cf09e8-cd8e-43fd-86c0-d2f716dd60bd): large food-led promotion, bold black type and branded yellow actions.
- [McDonald’s recommendation sheet](https://mobbin.com/screens/1bcbf1aa-2727-4e59-b388-6f52962d6dbb): compact food presentation and an obvious primary action.

The homepage uses a white header, a solid McDonald's-yellow hero with the existing official burger cutout, an open feature row, a neutral product showcase with actual app screenshots, three practical steps, and a red closing section. No Mobbin image is shipped or used as an application asset. The built-in image generation tool was unavailable; this iteration used the inspected references and existing official assets, without an API image-generation fallback.

Typography: desktop hero up to 76px, mobile 40–62px; controls 14–16px with at least 44px touch height. New primary-action text meets 4.5:1 contrast. Use the existing Icon component and Brand component. White and yellow surfaces stay solid, with no photo tint or decorative gradient. Mobile is checked at 390px and 320px; feature descriptions retain deliberate line breaks.

The screenshots under `public/preview/` are copies of this project's actual UI captures in `docs/images/`. They are labeled as screenshots, not live offers; menu data and prices are still fetched only inside the authenticated planner.
