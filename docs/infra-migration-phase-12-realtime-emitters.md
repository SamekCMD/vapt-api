# Etapa 12 — emissores de invalidação após commit

Implementação reutilizável para preview e produção; ativação permanece opt-in.
Esta tarefa não altera tráfego, recursos remotos, schema, grants ou providers.
As referências abaixo apontam para funções/linhas desta implementação.

## Mapa dos caminhos reais

| Entrada real | Repositório / publicação | Mudança e tópicos |
| --- | --- | --- |
| `orders.createPublicOrder` | `src/modules/orders/repository.ts:136`, emissão em 171 | Criação não replay: `orders`, `kitchen`; também `table_sessions` se houver sessão. ID/restaurante vêm de `create_public_order_v3`. |
| `kitchen.updateOwnedOrderStatus` | `src/modules/kitchen/repository.ts:137`, emissão em 174 | Status carregado após update difere do status bloqueado: `orders`, `kitchen`, `table_sessions`. |
| `tableSessions.requestPublicCheck` | `src/modules/table-sessions/repository.ts:359`, emissão em 395 | Somente passagem de mesa aberta para conta solicitada: `table_sessions`, `orderIds: []`; convidados não recebem atividade da mesa. |
| `tableSessions.closeOwnedSession` | `src/modules/table-sessions/repository.ts:236`, emissão em 299 | Mesa fechada: `table_sessions`; `orders`/`kitchen` somente se o update retornou IDs de pedidos alterados. Mesa já fechada não emite. |
| `tableSessions.transferOwnedSession` | `src/modules/table-sessions/repository.ts:307`, emissão em 351 | Mesa e/ou pedidos mudaram de número: `table_sessions`; `orders`/`kitchen` somente para IDs retornados por `UPDATE ... IS DISTINCT FROM`. Mesmo número sem mudança não emite. |
| Checkout, manual, retorno e webhook MP | `src/modules/payments/repository.ts:480`, emissão em 528 | Versão/status efetivo da transação mudou: `payments`, `orders`, `kitchen`, `table_sessions`. Comparação com snapshot autoritativo, não com `expectedVersion` do chamador. |
| Effects e reconciliação de effects | `src/modules/payments/repository.ts:662`, emissão em 687 | `release_paid_order_to_production` alterou status do pedido: `orders`, `kitchen`, `table_sessions`; rotina repetida sem mudança não emite. |

Todos chamam `emitCommittedChange` (`src/modules/realtime/committed-changes.ts:12`)
somente depois de `withTransaction` terminar com `COMMIT` e liberar o client.
Falha/rollback/commit recusado não publica. Exceção do publisher não muda o
resultado já confirmado e não acrescenta metadados aos DTOs HTTP.

## Ligações de pagamento

- `createHostedCheckoutService` (`src/modules/payments/service.ts:442`) e
  `createManualPaymentService` (708) usam `PaymentService.startPayment` (324),
  que chama o mesmo `applyPaymentTransition` observado.
- `createMercadoPagoReturnReconciliationService` (491) valida a resposta do
  provider e chama esse repositório; retorno já confirmado não repete emissão.
- `createMercadoPagoWebhookService`
  (`src/modules/payments/providers/mercado-pago/webhook.ts:186`) mantém validação
  de assinatura, reserva/dedupe e conferência de conta/valor/referência antes da
  transição. Webhook duplicado não emite novamente.
- `executeEffect` (`src/modules/payments/effects.ts:78`) executa a liberação;
  `reconciliation.runOnce` (`src/modules/payments/reconciliation.ts:72`) usa o
  mesmo processor/repositório. Concluir/reservar/reagendar um effect não é, por
  si, mudança de pedido e não emite.

## Transações, permissões e degradação

Observação requer pool `Database` gerenciado pelo repositório. `Queryable`
isolado e `PoolClient` emprestado continuam aceitos sem observer; fornecer
observer nesses casos é recusado na construção, pois não há prova do commit
de uma transação externa.

A role API não tem `UPDATE` em `payment_transactions`. A transição observada
usa transação `SERIALIZABLE`, snapshot SELECT e o lock já existente na rotina
security-definer. Não adiciona grants. Concorrência pode gerar conflito de
serialização e o erro de storage já sanitizado; os caminhos idempotentes podem
ser repetidos. A liberação void bloqueia o pedido autorizado e compara seu
status antes/depois na mesma transação.

Não existe entrega garantida/outbox nova para realtime: invalidação é
best-effort, limitada pelo publisher Worker a dois segundos. O cliente deve
refazer GETs e manter ressincronização/polling fallback. Com flag desligada,
o Worker não injeta observer nem acrescenta transações às queries autocommit.
Fastify/Coolify permanece sem observer por padrão.

## Não emissores

Leituras, catálogo, feedback, push subscriptions, OAuth, diagnósticos de
provider, reserva de webhook e manutenção de outbox não alteram os domínios
acima. Stripe nesta base trata assinatura SaaS, não pagamento/status de pedido;
nenhum webhook billing publica tópicos de restaurante. Não foi criada rota
inexistente de cancelamento de pedido. Uma transição de pagamento cancelado
usa `payment_changed`; não afirma cancelar o pedido quando o SQL não o faz.

## Evidência local

`src/modules/realtime/committed-changes.test.ts` exercita repositórios e serviços
reais, composição compartilhada, manual, checkout, retorno, webhook assinado e
effects/reconciliação. Somente SQL e transporte externo do provider são
simulados. Inclui commit falho, rollback, replay/no-op, publisher falho,
IDs/tópicos mínimos e recusa de observer em client de transação externa.
As suítes legadas de cada domínio permanecem na execução completa.
Não houve chamada real de provider nem prova remota de commit nesta tarefa.
