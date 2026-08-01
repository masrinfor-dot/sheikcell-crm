---
name: Satisfaction survey (pesquisa pós-atendimento)
description: Non-obvious constraints of the 1–5 rating survey after resolving WhatsApp attendances
---
- Rating capture must run BEFORE the inbound conversation upsert. **Why:** the upsert reopens resolved conversations into Potenciais and triggers the bot, so a "5" reply would leak into triage instead of being consumed as a rating.
- Only the FIRST reply after the survey may count. **Why:** a stray lone digit sent days later must never become a rating.
- The pending-survey marker must be written BEFORE the bridge send (with conditional cleanup on failure). **Why:** customers reply the instant the prompt arrives, before the bridge call returns — writing the marker afterwards loses valid ratings to the race.
