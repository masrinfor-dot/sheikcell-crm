---
name: WhatsApp media types
description: Convenções de mídia (vídeo/áudio/ptt) no pipeline chat↔bridge
---

- Extensão `weba` = áudio webm; `webm` puro = vídeo. O GET /chat/media decide Content-Type só pela extensão, então essa reserva evita servir áudio como vídeo.
- Mimetype do navegador chega com parâmetros (`audio/webm;codecs=opus`) — sempre normalizar com `split(";")` antes de validar contra whitelist.
- Nota de voz (ptt): gravada como webm/opus no navegador; o bridge anuncia ao Baileys como `audio/ogg; codecs=opus` com `ptt:true` (prática padrão, WhatsApp aceita).
- **Why:** WhatsApp rejeita/mostra errado áudio ptt com mimetype webm; e whitelist estrita quebrava uploads de gravação por causa dos parâmetros do mimetype.
- **How to apply:** ao adicionar novo tipo de mídia, atualizar em 4 lugares: ALLOWED_MIMES (inbound), ALLOWED_MIMES_OUT + mimeToExt (POST /media), mimeMap (GET /media), accept do file input no ChatCenter.
