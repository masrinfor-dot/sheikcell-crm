---
name: WhatsApp anti-ban send queue
description: Outbound Baileys sends are serialized with human pacing; invariants to keep
---
Rule: every outbound Baileys send (text + media) must go through the single send queue in the bridge's connection manager — random 1.5–3s gap between sends + "composing" presence sim (proportional to text, capped ~4s), 45s per-job watchdog so a hung send can't stall the queue.

**Why:** Baileys is an unofficial client; burst sends without typing presence are the classic automation signal that gets numbers banned. The watchdog exists because the queue is a single promise chain — one never-settling send would freeze all outbound messaging.

**How to apply:** New send paths in the bridge must call the queue, never `sock.sendMessage` directly. The API's calls to the bridge send endpoints carry a 60s abort timeout (must stay > queue watchdog) so failures still mark messages 'failed' + broadcast message_updated instead of hanging.
