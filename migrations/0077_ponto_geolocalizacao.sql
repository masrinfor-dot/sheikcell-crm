-- Geolocalização capturada no navegador na hora da batida de ponto. Só é
-- obrigatória (junto com a foto, que já usa a coluna proof_url existente)
-- na batida de ENTRADA feita pelo próprio colaborador (source='self'),
-- que é a que o PontoGate.tsx exige logo ao abrir o sistema. Batidas
-- antigas, pelo WhatsApp e feitas manualmente pelo admin ficam com essas
-- colunas nulas — ver requirePhotoAndGeo em
-- artifacts/api-server/src/routes/rhDp.ts.
ALTER TABLE time_clock_entries ADD COLUMN IF NOT EXISTS lat double precision;
ALTER TABLE time_clock_entries ADD COLUMN IF NOT EXISTS lng double precision;
ALTER TABLE time_clock_entries ADD COLUMN IF NOT EXISTS accuracy_meters double precision;
