---
name: Mobile app chat is minimal
description: The Expo mobile app does not have web-parity chat; scope "também no celular" tasks accordingly
---

The Sheikcell Mobile (Expo) app does NOT have the full Central de Atendimento — only a "Conversas" tab (list with pin-to-top + search, 15s polling), a minimal text-only conversation screen, and real-time alerts.

**Why:** tasks phrased "também no celular" tend to assume web-parity chat exists on mobile; it doesn't, so such tasks usually require building missing UI, not just wiring events.

**How to apply:** before planning mobile chat work, check what screens actually exist in the mobile app. React Native has no EventSource — the app has its own SSE-over-XHR client (with reconnect + Last-Event-ID); reuse it for new real-time mobile features instead of adding a dependency, and advance its Last-Event-ID checkpoint on EVERY event (even unhandled ones) or reconnects replay already-shown alerts.
