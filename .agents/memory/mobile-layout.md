---
name: Mobile responsive layout
description: Como o web app sheikcell se comporta em telas < md (celular)
---
Regra: breakpoint `md` separa celular de desktop; desktop não muda.
- AttendantDashboard/AdminDashboard: sidebar `hidden md:block`; bottom nav `md:hidden fixed bottom-0 z-30/40` com altura `calc(3.5rem+env(safe-area-inset-bottom))`; conteúdo recebe `pb-[calc(3.5rem+safe-area)] md:pb-0`.
- Admin tem 10 abas → mobile mostra 4 primárias + "Mais" (bottom sheet com o resto). Se adicionar aba nova, ela cai no sheet automaticamente (slice(0,4)/slice(4)).
- ChatCenter: lista `hidden md:flex` quando há conversa ativa; botão voltar `button-back-conv-list` (md:hidden) faz setActiveId(null); painel info vira overlay `fixed inset-0 z-40` no mobile; header usa flex-wrap no mobile.
- InternalChat: coluna direita `hidden md:flex`; no celular vira aba "equipe" da bottom nav. Versão NÃO-docked (aba do Admin) também é single-column no mobile (lista OU conversa, botão voltar `md:hidden`, altura 100dvh−11rem−safe-area).
- Alturas mobile: `calc(100dvh - 7rem - env(safe-area-inset-bottom))` (navbar 3.5rem + bottom nav 3.5rem). Mudou a altura de alguma barra? Ajustar esse cálculo junto.
**Why:** usuário atende pelo celular; z-order: bottom nav 30/40 < info panel 40 < modais 50.
