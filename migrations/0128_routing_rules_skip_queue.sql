-- "Pular fila" por palavra-chave (pedido 18/09: "como recebemos muitos
-- xerox impressão criar palavra chave por transferir atendimento para loja
-- adequada e pular a fila"). Default false nos dois: nenhuma regra nem
-- nenhuma loja muda de comportamento até o admin ligar explicitamente.
ALTER TABLE routing_rules ADD COLUMN IF NOT EXISTS skip_queue boolean NOT NULL DEFAULT false;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS skip_queue_enabled boolean NOT NULL DEFAULT false;
