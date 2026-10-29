-- Pedido do Samuel (29/10/2026): os gerentes são Samuel (dono) e Lucelia.
-- Lucelia vira gestora do Gerente IA (celular 33 98710-4831, já cadastrado
-- na Equipe no WhatsApp). Idempotente; só age se o usuário existir.
INSERT INTO gerente_members (tenant_id, phone, name, user_id, role, is_active)
SELECT u.tenant_id, '5533987104831', 'Lucelia', u.id, 'gestor', true
FROM users u
WHERE u.id = 2 AND u.name ILIKE 'lucelia%'
ON CONFLICT (tenant_id, phone) DO NOTHING;
