-- Gerente IA: link do dono pode comentar, mudar a situação e avisar a equipe.
ALTER TABLE gerente_links ADD COLUMN IF NOT EXISTS can_edit boolean NOT NULL DEFAULT false;
