-- =============================================================================
-- MFA para usuários finais
--
-- `users` já tinha `mfa_secret` e `mfa_enabled_at` desde a Fase 1, sem uso.
-- Faltavam duas coisas para o recurso existir de verdade:
--
--   `mfa_last_window` — a janela TOTP já consumida. O mesmo código vale por até
--   90 segundos; sem registrar qual janela foi usada, um código interceptado
--   pode ser reapresentado dentro dela.
--
--   `mfa_recovery_codes` — os códigos de recuperação, em HASH. Sem eles, perder
--   o celular significa perder a conta, e a recuperação passaria por nós,
--   manualmente, provando identidade por e-mail — que é justamente o fator que
--   o MFA existe para não ser suficiente.
--
-- Os códigos são guardados como hash pelo mesmo motivo de uma senha: um dump do
-- banco não pode virar acesso às contas dos clientes.
-- =============================================================================

ALTER TABLE users
  ADD COLUMN mfa_last_window bigint,
  ADD COLUMN mfa_recovery_codes text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN users.mfa_recovery_codes IS
  'Hashes dos códigos de recuperação. Cada um serve uma vez e é removido do array ao ser usado.';

COMMENT ON COLUMN users.mfa_last_window IS
  'Janela TOTP já consumida. Impede reapresentar o mesmo código dentro dos 90s em que ele continua válido.';
