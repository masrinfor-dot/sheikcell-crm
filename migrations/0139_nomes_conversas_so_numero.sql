-- Conversas só com o número no nome (19/10/2026: "puxa os nomes já
-- cadastrados"). Conversas criadas por mensagem enviada do celular ou pelo
-- histórico nasciam com o telefone como nome. Preenche com o nome já
-- cadastrado, nesta ordem: agenda do WhatsApp da MESMA linha → ficha do CRM →
-- agenda de qualquer linha da loja → outra conversa do mesmo número.
-- Idempotente: só mexe em nome que ainda é só número; compara o telefone com
-- e sem o 9º dígito. Grupos (@g.us) ficam de fora.
WITH alvo AS (
  SELECT c.id, c.tenant_id, c.session_key, c.phone,
    CASE WHEN length(c.phone) = 13 THEN left(c.phone, 4) || right(c.phone, 8)
         WHEN length(c.phone) = 12 THEN left(c.phone, 4) || '9' || right(c.phone, 8)
         ELSE c.phone END AS alt
  FROM conversations c
  WHERE c.phone NOT LIKE '%@%'
    AND (c.name ~ '^[0-9+ ()-]+$' OR c.name = c.phone)
),
nome AS (
  SELECT a.id, COALESCE(
    (SELECT w.name FROM whatsapp_contacts w
      WHERE w.tenant_id = a.tenant_id AND w.session_key = a.session_key AND w.phone IN (a.phone, a.alt)
        AND coalesce(trim(w.name), '') <> '' AND w.name !~ '^[0-9+ ()-]+$'
      ORDER BY w.updated_at DESC LIMIT 1),
    (SELECT k.name FROM crm_contacts k
      WHERE k.tenant_id = a.tenant_id AND k.phone IN (a.phone, a.alt)
        AND coalesce(trim(k.name), '') <> '' AND k.name !~ '^[0-9+ ()-]+$'
      ORDER BY k.updated_at DESC LIMIT 1),
    (SELECT w.name FROM whatsapp_contacts w
      WHERE w.tenant_id = a.tenant_id AND w.phone IN (a.phone, a.alt)
        AND coalesce(trim(w.name), '') <> '' AND w.name !~ '^[0-9+ ()-]+$'
      ORDER BY w.updated_at DESC LIMIT 1),
    (SELECT o.name FROM conversations o
      WHERE o.tenant_id = a.tenant_id AND o.id <> a.id AND o.phone IN (a.phone, a.alt)
        AND coalesce(trim(o.name), '') <> '' AND o.name !~ '^[0-9+ ()-]+$'
      ORDER BY o.last_message_at DESC NULLS LAST LIMIT 1)
  ) AS name
  FROM alvo a
)
UPDATE conversations c SET name = n.name, updated_at = now()
FROM nome n
WHERE n.id = c.id AND n.name IS NOT NULL;

-- Fichas do CRM só com o número: mesmo preenchimento a partir da agenda do
-- WhatsApp (qualquer linha) ou de uma conversa com nome.
WITH alvo AS (
  SELECT k.id, k.tenant_id, k.phone,
    CASE WHEN length(k.phone) = 13 THEN left(k.phone, 4) || right(k.phone, 8)
         WHEN length(k.phone) = 12 THEN left(k.phone, 4) || '9' || right(k.phone, 8)
         ELSE k.phone END AS alt
  FROM crm_contacts k
  WHERE k.phone IS NOT NULL AND (k.name ~ '^[0-9+ ()-]+$' OR k.name = k.phone)
),
nome AS (
  SELECT a.id, COALESCE(
    (SELECT w.name FROM whatsapp_contacts w
      WHERE w.tenant_id = a.tenant_id AND w.phone IN (a.phone, a.alt)
        AND coalesce(trim(w.name), '') <> '' AND w.name !~ '^[0-9+ ()-]+$'
      ORDER BY w.updated_at DESC LIMIT 1),
    (SELECT o.name FROM conversations o
      WHERE o.tenant_id = a.tenant_id AND o.phone IN (a.phone, a.alt)
        AND coalesce(trim(o.name), '') <> '' AND o.name !~ '^[0-9+ ()-]+$'
      ORDER BY o.last_message_at DESC NULLS LAST LIMIT 1)
  ) AS name
  FROM alvo a
)
UPDATE crm_contacts k SET name = n.name, updated_at = now()
FROM nome n
WHERE n.id = k.id AND n.name IS NOT NULL;
