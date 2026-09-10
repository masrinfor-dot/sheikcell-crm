-- Ficha cadastral de admissão (pedido 10/09): campos que faltavam no cadastro
-- do colaborador comparado ao modelo de ficha usado pela contabilidade —
-- endereço completo, estado civil, escolaridade e duração do contrato de
-- experiência. Idempotente.
ALTER TABLE employees ADD COLUMN IF NOT EXISTS address text;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS address_number text;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS neighborhood text;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS city text;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS state text;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS zip_code text;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS marital_status text;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS education_level text;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS experience_days integer;

-- Modelos de "documento com texto" (contrato de trabalho) agora também
-- servem pro Regimento interno (pedido 10/09) — kind distingue os dois na
-- listagem/cadastro do admin; a geração por placeholder (contract-preview)
-- continua igual pra qualquer um, não olha pra kind.
ALTER TABLE employee_contract_templates ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'contrato';

-- Propósito da empresa (Missão/Visão/Valores, pedido 10/09) — texto único
-- por tenant, editado pelo admin em RH > Contratação e apresentado pro
-- colaborador confirmar/assinar no ato da contratação (a confirmação vira
-- um employee_documents com docType "proposito_confirmado", mesmo padrão já
-- usado pro contrato de trabalho).
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS company_mission text;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS company_vision text;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS company_values text;
