---
name: browser-toolkit
description: "Browser parent skill. Triggers: 'use the browser', 'use my Chrome', 'in the browser', 'help me do X on <site>', form filling, navigation, web automation, surf CLI, agent-browser, chrome-devtools/Lighthouse/performance, pinchtab/stealth scraping, xurl/X links, screenshots, authenticated browsing."
---

# Browser Toolkit

Classify browser/web tasks without loading every browser automation guide.

**Default for any "do X in my browser" task: load `references/surf.md`.** Surf drives the user's existing logged-in Chrome via CDP — fast, semantic refs, real session cookies. Reach for the others only when the category below explicitly calls for them.

**Prefer `surf` over `computer-use` / `peekaboo` AX clicks for web tasks** — faster, page-aware, won't fight Chrome's window chrome.

## Categories

- **general automation / local dev** — forms, clicking, navigation, screenshots, localhost, `.test`, `file://` → **`surf`** (default)
- **performance debugging** — Lighthouse, traces, network, console, memory → `chrome-devtools`
- **stealth scraping** — bot-protected sites, Cloudflare/DataDome, anti-detection → `pinchtab`
- **authenticated browsing** — logged-in sessions, admin panels, OAuth → **`surf`** (uses your active Chrome session)
- **AI via browser session** — ChatGPT / Gemini / Perplexity / Grok / AI Studio without API keys → **`surf`**
- **speed scrape / article extraction** — prefer cheaper fetch/extract before browser control
- **X/Twitter URL handling** — `xurl`

## Workflow

1. Decide whether a browser is actually needed. Static docs/articles should use fetch/markdown extraction first.
2. If browser control is needed, load only the specific reference for the selected category:
   - general / local / authenticated automation, AI-via-session → `references/surf.md` ← **default**
   - performance debugging → `references/chrome-devtools.md`
   - stealth scraping → `references/pinchtab.md`
   - X/Twitter URL handling → `references/xurl.md`
   - legacy alternative CLI → `references/agent-browser.md` (use only if explicitly requested)
3. Reuse existing browser state before launching new windows/profiles. Use `surf window.new` + `--window-id` to keep agent work isolated from the user's tabs when needed.
4. Stop for login approval, 2FA, captcha, OS permission dialogs, external posting/sending, or destructive actions.

## Related but separate

Visual explanation workflows live under `/planning` references. Exploratory QA/dogfooding was removed as a standalone global skill.
