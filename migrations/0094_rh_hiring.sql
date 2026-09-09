-- Processo de contratação (RH > Recrutamento) — pedido do lojista (09/09):
-- a partir de um candidato aprovado (ou avulso, sem candidatura), iniciar a
-- contratação, subir os documentos pessoais/CLT, preencher cargo/escala e
-- gerar o contrato de trabalho, tudo guardado no "banco de arquivos" do
-- colaborador. Idempotente.

-- candidate_id: de qual candidatura (rh_candidates) essa contratação saiu —
-- null quando o colaborador foi cadastrado direto (sem processo seletivo),
-- igual já era possível antes desta feature.
ALTER TABLE employees ADD COLUMN IF NOT EXISTS candidate_id integer REFERENCES rh_candidates(id);
-- hiring_status: 'em_contratacao' enquanto documentos/contrato ainda estão
-- sendo reunidos (colaborador criado mas processo não fechado), 'ativo'
-- quando finalizado. Default 'ativo' pra todo colaborador já existente
-- (cadastro direto de sempre, sem esse fluxo) continuar exatamente igual.
ALTER TABLE employees ADD COLUMN IF NOT EXISTS hiring_status text NOT NULL DEFAULT 'ativo';

-- Banco de arquivos do colaborador: 1 linha por documento (RG, CPF, foto
-- 3x4, carteira de trabalho, comprovante de residência, título de eleitor,
-- PIS/NIT, certidão, exame admissional, contrato de trabalho gerado etc.).
-- O arquivo em si fica no disco (mesmo DOCS_DIR já usado por documents.ts,
-- numa subpasta — assim usa o MESMO volume persistente já montado em
-- produção, sem precisar de nenhuma configuração nova no EasyPanel); aqui só
-- os metadados. text_content guarda o texto do contrato gerado/editado
-- quando a linha é o contrato (sem arquivo em disco nesse caso).
CREATE TABLE IF NOT EXISTS employee_documents (
  tenant_id integer NOT NULL DEFAULT 1,
  id serial PRIMARY KEY,
  employee_id integer NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  doc_type text NOT NULL,
  label text,
  file_name text,
  mime_type text,
  stored_name text,
  size_bytes integer,
  text_content text,
  uploaded_by_user_id integer,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS employee_documents_employee_idx ON employee_documents(employee_id);

-- Modelos de contrato de trabalho, personalizáveis pelo admin (texto com
-- placeholders tipo {{nome}}/{{cpf}}/{{cargo}} — substituídos na hora de
-- gerar o contrato de um colaborador específico). Vários modelos por
-- tenant (ex.: um pra CLT, outro pra PJ/estágio).
CREATE TABLE IF NOT EXISTS employee_contract_templates (
  tenant_id integer NOT NULL DEFAULT 1,
  id serial PRIMARY KEY,
  name text NOT NULL,
  contract_type text,
  body_text text NOT NULL,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
