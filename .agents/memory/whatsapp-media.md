---
name: WhatsApp media types
description: Convenções de mídia (vídeo/áudio/ptt) no pipeline chat↔bridge
---

- Extensão `weba` = áudio webm; `webm` puro = vídeo. O GET /chat/media decide Content-Type só pela extensão, então essa reserva evita servir áudio como vídeo.
- Mimetype do navegador chega com parâmetros (`audio/webm;codecs=opus`) — sempre normalizar com `split(";")` antes de validar contra whitelist.
- Nota de voz (ptt): gravada como webm/opus no navegador; o bridge anuncia ao Baileys como `audio/ogg; codecs=opus` com `ptt:true` (prática padrão, WhatsApp aceita).
- **Why:** WhatsApp rejeita/mostra errado áudio ptt com mimetype webm; e whitelist estrita quebrava uploads de gravação por causa dos parâmetros do mimetype.
- **How to apply:** ao adicionar novo tipo de mídia, atualizar em 4 lugares: ALLOWED_MIMES (inbound), ALLOWED_MIMES_OUT + mimeToExt (POST /media), mimeMap (GET /media), accept do file input no ChatCenter.

- Áudio outbound: NÃO basta renomear mimetype para ogg/opus — WhatsApp rejeita ("algo errado com o arquivo"). Converter de verdade com ffmpeg (toOggOpus no bridge); ffmpeg precisa estar na imagem Docker do bridge.

- Grupos/comunidades: conversas de grupo guardam o JID completo (…@g.us) em conversations.phone; detecção de grupo = phone.includes("@g.us") em todo o stack (toJid passa @g.us direto, CRM/Meta-fallback devem ignorar grupos).
