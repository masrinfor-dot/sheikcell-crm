---
name: AttendantDashboard Fragment quirk
description: The "queue" tab content is wrapped in a JSX Fragment that must stay intact
---

## Rule
In `AttendantDashboard.tsx`, the queue tab renders as `{mainTab === "queue" && <><div...>...</></>}` — a Fragment wrapping multiple top-level elements.

**Why:** The modal overlay and the main list are siblings inside the conditional, requiring a Fragment.

**How to apply:**
- When adding new tabs, insert them BEFORE the queue block (not inside it)
- The Fragment `<>...</>` on line ~193 must not be split or re-wrapped — doing so causes a Babel JSX parse error in Vite HMR
- TypeScript's `tsc --noEmit` passes even with malformed JSX sometimes; trust Vite's HMR error as the real indicator
