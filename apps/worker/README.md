# @forms/worker

Workers BullMQ. Entram na **Fase 2** e crescem até a Fase 4.

Filas previstas, na ordem em que aparecem no roteiro:

| Fila | Fase | Por que é fila e não request |
|---|---|---|
| `email` | 2 | SMTP lento não pode segurar um cadastro. |
| `export` | 2 | Exportar 25.000 respostas em CSV/XLSX/PDF leva minutos. |
| `retention` | 2 | Purga diária por `responseRetentionDays`, com aviso 7 dias antes. |
| `webhook` | 4 | Entrega com HMAC e retry exponencial. Endpoint do cliente cai. |
| `ai` | 4 | Claude API. Nunca síncrono no request (seção 5.3). |
| `dns` | 4 | Verificação de DNS a cada 30s por 30min, depois de hora em hora. |
| `billing` | 3 | Webhooks do gateway e a reconciliação diária. |

A reconciliação diária (`billing`) não é opcional: é o job que compara status
local com o do gateway e evita cliente pagante ficar suspenso por um webhook
perdido. Ver `docs/adr/0004-gateway-de-pagamento.md`.

Todo job roda com contexto de tenant explícito, pelo mesmo `withTenant()` da
API — um worker sem contexto enxerga zero linhas, e é isso que queremos.
