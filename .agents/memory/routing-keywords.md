---
name: Routing keyword matching gotcha
description: autoRouter.ts uses simple substring matching after accent normalization — multi-word phrases only match if adjacent in text
---

## Rule
The classifier in `autoRouter.ts` checks `normalizedText.includes(keyword)` for each keyword. Multi-word keywords only match if the exact sequence appears in the text.

**Why:** "não está ligando" normalizes to "nao esta ligando". The keyword "nao liga" is NOT a substring of "nao esta ligando" (the word "esta" sits between them). This caused "meu iphone não está ligando" to route to Comercial (via "iphone") instead of Assistência Técnica.

**How to apply:**
- Prefer single-word or adjacent-word keywords: use "ligando" not "nao liga" for the "device won't turn on" pattern
- Device model names (iphone, samsung) in Comercial are too generic — use purchase-intent words (comprar, preco, valor, parcela)
- Always verify new rules with POST /api/routing/classify before deploying
- Priority order (highest first): Garantia(40) > Assistência Técnica(35) > Comercial(30) > Acessórios(20) > Financeiro(15)
- The 60-second in-memory cache in autoRouter.ts means DB changes take up to 60s to reflect; API restart clears the cache immediately
