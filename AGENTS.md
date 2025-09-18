# Repository Guidelines

## Project Structure & Module Organization
The app is a browser-first ES module codebase. Entry point `index.html` renders the shell, `styles.css` carries global theming, and `main.js` orchestrates feature bootstrapping. Shared services live under `modules/` (state, DOM selectors, storage, UI, audio, API, platform). Feature flows live in `features/<name>/`, each exporting an `init*` and helper utilities; keep cross-feature helpers in `modules/` rather than duplicating logic. Data fixtures and user assets are stored in `wordlists/`, `articles/`, `qa-sets/`, and media under the root. Review `docs/prd.md` and `PLAN.md` whenever touching the QA training roadmap.

## Build, Test, and Development Commands
- `npx serve .` (or VS Code Live Server) starts a static dev server so module imports work and fetch requests hit the right origin.
- `npx http-server -c-1 .` is a quick alternative when you need cache-busting while debugging storage flows.
- Use your editor's ESLint/Prettier integrations with 4-space indentation and single quotes; there is no repo-managed config yet.

## Coding Style & Naming Conventions
Stick to ES2022 syntax with named imports/exports and `const`/`let`. Functions and variables use `camelCase`; reserve `PascalCase` for constructors or namespace objects. Group DOM access through `modules/dom.js`, keep side-effects behind intent-revealing helpers, and extract feature-specific utilities into sibling files once they exceed ~300 lines. Inline comments should explain why, not what, and prefer TODO tags with owner initials.

## Testing Guidelines
Automated suites are not in place yet. Use `test-floating-statusbar.html` for smoke tests on platform detection, state persistence, and floating controls, and update it whenever UI affordances change. Extend `qa-sets/*.json` with representative prompts whenever you add QA features, and note the dataset you exercised in your PR. Document manual verification steps, including which wordlists/articles were used, so reviewers can replay them.

## Commit & Pull Request Guidelines
Follow the existing Conventional Commit-inspired style (`feat:`, `fix:`, `chore:`) with concise Mandarin or English summaries (see `git log`). Limit each branch to one logical change, link related docs or issues, and attach before/after screenshots or GIFs for UI updates. PR descriptions must enumerate configuration steps, manual test evidence, and any data migrations to streamline review.

## Security & Configuration Tips
`ai-config.js` ships demo keys-create a private copy of `ai-config.example.js` for real credentials and exclude it from commits. Scrub sensitive examples from `wordlists/` and `articles/` before sharing. When adding external requests, document rate-limit handling in `modules/api.js` and avoid blocking UI threads with long-running AI calls.

## 用户要求
使用繁体中文
生成文档要获取当前日期。