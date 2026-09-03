-- Perfil comportamental (Analítico/Dominante/Apoiador/Inovador) calculado
-- automaticamente na hora da candidatura, a partir das opções marcadas com
-- perfil em perguntas type:"options" da etapa "Teste de perfil" (ver
-- optionProfiles em RhQuestion, artifacts/api-server/src/routes/rh.ts).
-- profile_result = perfil dominante (maior contagem) ou null se nenhuma
-- pergunta da candidatura tinha perfil configurado. profile_scores = objeto
-- com a contagem de cada um dos 4 perfis, só preenchido junto com o result.
ALTER TABLE rh_candidates ADD COLUMN IF NOT EXISTS profile_result text;
ALTER TABLE rh_candidates ADD COLUMN IF NOT EXISTS profile_scores jsonb;
