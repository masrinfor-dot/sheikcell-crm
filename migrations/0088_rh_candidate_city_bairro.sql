-- Cidade/bairro do candidato de RH (Processo Seletivo) — campos livres,
-- opcionais, coletados no formulário público a partir de agora. Usados pro
-- filtro "Cidade"/"Bairro" na lista de candidatos (RH.tsx). Idempotente.
ALTER TABLE rh_candidates ADD COLUMN IF NOT EXISTS city text;
ALTER TABLE rh_candidates ADD COLUMN IF NOT EXISTS neighborhood text;
