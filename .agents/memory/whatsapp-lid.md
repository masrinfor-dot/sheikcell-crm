---
name: WhatsApp LID JIDs
description: WhatsApp migrates contacts to "@lid" internal IDs; sends to stripped digits go nowhere silently
---
WhatsApp is migrating chats to LID JIDs (`123...@lid`), which are internal IDs, not phone numbers.

**Why:** Prod incident: messages showed "sent" but never arrived — bridge stripped non-digits and sent to `LID@s.whatsapp.net`, a nonexistent phone. Baileys reports success, so the failure is silent.

**How to apply:**
- Inbound (bridge): if `remoteJid` ends with `@lid`, resolve real phone via `m.key.remoteJidAlt` or `sock.signalRepository.lidMapping.getPNForLID()` before forwarding; fall back to keeping the `@lid` jid.
- API stores phone with the `@lid` suffix intact when unresolved — never strip it.
- Outbound (bridge `toJid`): if target contains `@lid`, send to `digits@lid`, not `@s.whatsapp.net`.
- Log symptom: "USync fetch yielded no results for pending PNs" before a "sent" line = sending to a LID.
