# 素材与第三方说明

麦搭为独立开发的非官方用餐助手，不代表麦当劳提供产品背书。

## 商标、图片和数据

- McDonald's、麦当劳与金色拱门等商标属于其相应权利人。项目 MIT 许可不涵盖第三方商标及图片。
- `public/brand/mcdonalds-golden-arches.jpg` 与 `public/brand/big-mac.png` 为官方公开素材。原始来源、用途和文件哈希见 `public/brand/SOURCES.json`，图像本身未重新绘制。
- 页面中的动态餐品图片来自实际官方菜单接口。README 截图记录真实产品界面，不是生成的餐品或虚构价格。
- 营养份量证据的来源和校验方法见 `server/serving-evidence.mjs`、`server/serving-calculator-evidence.json` 与 `docs/calorie-method.md`；这些证据不会补充实时接口缺失的价格或营养事实。
- 使用麦当劳 MCP 及相应素材、服务时，需遵守其适用规则。项目开源许可不授予第三方素材的额外使用权。

## 软件依赖

本项目使用 React、Vite、TypeScript、Ajv、ajv-formats、TOON、Playwright 等第三方软件。各依赖保持自己的许可证，具体版本由 `package-lock.json` 锁定，许可证可在相应包和上游仓库中查阅。

## AI 辅助

项目开发使用 AI 编程辅助。运行时的自然语言解析和部分商品分类使用 DeepSeek；价格、菜单和营养事实仍来自实际麦当劳接口并经程序校验。本项目未使用 WorkBuddy，不生成或伪造 WorkBuddy 开发记录。
