# Product

## Register

product

## Users

The primary user is the author: a Mac power user triaging disk space in focused, occasional sessions. Context: the "Your disk is almost full" notification appeared, or a big cleanup is overdue. Sessions are short (5–20 minutes), goal-directed, and infrequent — the interface must be legible instantly even after weeks of non-use. Secondary audience: other Mac users who find DaisyDisk too closed/paid and GrandPerspective too dated.

## Product Purpose

mydirstats is a disk usage analyzer for macOS in WinDirStat's tri-pane tradition, modernized: fast parallel scanning, a live treemap that builds progressively during the scan, FSEvents-driven freshness afterwards, and a safe cleanup loop ending in macOS Trash. Success looks like: open the app, scan, find the space hogs, trash them, close — in one sitting, with zero uncertainty about what the numbers mean.

## Brand Personality

Precise, honest, quiet. A tool that never exaggerates, never hides uncertainty, and never gets in the way. Three words: exact, calm, trustworthy. The interface should feel like a well-made instrument, not a dashboard.

## Anti-references

- DaisyDisk's spectacle-first polish: beautiful, but the radial sunburst is weaker for deep hierarchies and the app is closed/paid. We take its progressive-scan feedback idea, not its visualization.
- GrandPerspective/Disk Inventory X: correct but frozen in 2008 — no live feedback, no modern interaction, dated chrome. We are not a port of that era.
- Generic "dashboard" SaaS aesthetics: stat cards, hero metrics, gradient text. This is a utility, not an analytics landing page.
- WinDirStat's own chrome: the layout DNA is right; the Windows-XP-era UI dressing is not.

## Design Principles

1. **Never lie about the numbers.** If part of the disk is unreachable (permissions), the UI says so and quantifies it. Estimates are labeled as estimates. No silent gaps.
2. **Match the user's mental model.** Bundles are objects, sizes are what Finder would report, Trash means Trash. The filesystem's implementation details never leak into the interface without translation.
3. **The treemap is the data; chrome is silence.** Categorical color is load-bearing information inside the treemap. Everything around it stays neutral so the data reads cleanly.
4. **Feedback is the feature.** Scans show progress as a forming picture, not a spinner. Deletions remove rectangles live. Every action has visible consequence.
5. **Keyboard-first triage.** The core loop (scan, navigate, inspect, trash) must be completable without touching the mouse.

## Accessibility & Inclusion

WCAG AA contrast throughout. The categorical treemap palette is chosen to survive deuteranopia; semantic states (selection, hover, focus) are never color-only — they use border, luminance shift, or geometry. Full keyboard navigation. Respects macOS Reduce Motion. VoiceOver labels carry size and path for every meaningful element.
