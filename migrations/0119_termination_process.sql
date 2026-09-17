-- Processo de desligamento/demissão (pedido 17/09): nova aba dentro de RH >
-- Departamento Pessoal pra acompanhar o processo do início à conclusão —
-- tipo de desligamento, aviso prévio, exame demissional, homologação e um
-- checklist de pendências. Só ACOMPANHA o processo, nunca calcula nem paga
-- verba nenhuma (mesmo espírito do vencimento do banco de horas, que só
-- sinaliza pra decisão humana) — valor de rescisão continua calculado fora
-- daqui (contabilidade/folha). Documentos do processo (aviso prévio, exame,
-- TRCT, termo de quitação) reaproveitam a tabela employee_documents que já
-- existia, sem precisar de tabela nova pra isso.

CREATE TABLE IF NOT EXISTS termination_processes (
  tenant_id integer NOT NULL DEFAULT 1,
  id serial PRIMARY KEY,
  employee_id integer NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  dismissal_type text NOT NULL,
  reason text,
  notice_type text,
  notice_start_date date,
  notice_end_date date,
  last_work_date date,
  termination_date date,
  exam_date date,
  exam_result text,
  homologation_date date,
  fgts_multa_paid boolean NOT NULL DEFAULT false,
  trct_signed boolean NOT NULL DEFAULT false,
  seguro_desemprego_guided boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'iniciado',
  notes text,
  created_by_user_id integer NOT NULL,
  concluded_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- No máximo um processo ativo (não concluído/cancelado) por colaborador.
CREATE UNIQUE INDEX IF NOT EXISTS termination_processes_employee_active_unique
  ON termination_processes (employee_id) WHERE status NOT IN ('concluido', 'cancelado');
