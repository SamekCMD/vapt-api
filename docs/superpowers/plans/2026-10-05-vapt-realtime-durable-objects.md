# Vapt Realtime Durable Objects Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implementar notificações WebSocket isoladas por restaurante/pedido, recuperáveis pela API/Neon, com código reutilizável em produção e validação inicial privada no preview.

**Architecture:** `RestaurantRealtime` vive no Worker da API, com namespace SQLite exclusivo por Preview, tickets de uso único e autorização revalidada. Os serviços publicam invalidações após commit; o frontend compartilha conexões por escopo e consulta a API para obter dados. Polling permanece como recuperação; ativação pública/produção é a Etapa 13, não uma segunda implementação.

**Tech Stack:** TypeScript, Hono, Better Auth 1.7.6, pg 8.23.0/Hyperdrive, Cloudflare DO SQLite/Hibernation, Wrangler 4.138.0, React 18/Vite, node:test/tsx, workerd e Vitest existentes. Sem nova biblioteca de transporte ou serviço gerenciado.

**Spec:** [2026-10-05-vapt-realtime-durable-objects-design.md](../specs/2026-10-05-vapt-realtime-durable-objects-design.md), aprovada pelo usuário em 05/10/2026.

## Global Constraints

- Neon é a fonte de verdade; DO não guarda snapshots de negócio. Eventos são invalidações best-effort, não uma nova Queue/outbox.
- `REALTIME_ENABLED` e `VITE_REALTIME_ENABLED`: ausência equivale a desligado. Production fica desligada e sem binding DO nesta etapa.
- Ticket: pelo menos 256 bits aleatórios, 30 s, uso único; concessão: no máximo 5 minutos e nunca além da sessão Better Auth.
- Protocolo estável `vapt.realtime.v1`; ticket somente em `Sec-WebSocket-Protocol`, nunca ecoado. Nenhuma credencial em URL, Git, logs ou bundle.
- Frames até 4 KiB; 128 sockets/restaurante, 24/identidade autorizada, 256 tickets pendentes/sala. Excesso cai para polling.
- Coalescência 250 ms, ressincronização saudável 30 s, backoff com jitter 1–30 s; fallback conserva os intervalos atuais de 4/5/8 s.
- Tópicos `orders`, `kitchen`, `table_sessions`, `payments`; público recebe somente seu pedido e sua sequência, nunca contadores globais. Catálogo continua em polling.
- Publicação somente após commit; rollback/replay sem mudança não emite. Falha do DO nunca desfaz commit nem muda a resposta de negócio.
- Revalidar sessão/propriedade ou impressão do token no Neon antes de cada lote privado; sem cache de autorização entre lotes.
- Hibernation, attachments mínimos e alarmes agrupados; sem `setInterval` por sala/socket e sem alarme recorrente em sala vazia.
- Workers Free/SQLite (`new_sqlite_classes`), sem upgrade pago. Revalidar plano da conta antes de publicação; não prometer gratuidade dos demais serviços.
- Não mudar production, DNS, tráfego Coolify, Cron, Stripe Live, Access/bearer ou criar bypass/relay público. Navegador remoto é gate separado.
- Reusar os workspaces em D:, preservar `docs/implementation-references/`, não limpar alterações de terceiros; branch + PR, sem merge automático.

## Review Focus

- Uma troca de usuário com requisição de ticket ainda pendente não pode abrir socket da identidade anterior (Task 6).
- Falha no COMMIT depois de preparar uma notificação não pode publicar mudança inexistente (Task 5).
- Reativação/expiração simultânea à publicação deve negar concessão vencida, sem renovar autoridade por acidente (Task 3).
- Invalidação durante snapshot ou perda silenciosa de sinal precisa resultar em nova consulta, sem alertas duplicados (Tasks 6–7).
- Flags ausentes/binding indisponível não podem derrubar criação de pedido ou habilitar recurso em production (Tasks 1, 4 e 8).

## Workspaces e verificação inicial

API (`A`): `D:/Projetos/vaptmesaflow/.worktrees/vapt-api-infra-foundation`, branch `codex/infra-foundation`, base deste plano `32afaba`. Frontend/SQL (`F`): `D:/Projetos/vaptmesaflow`, mesma branch nominal em outro repositório, base `381a94b`. Prefixos A/F abaixo identificam o repositório; caminhos sem prefixo nos comandos são relativos ao cwd indicado.

Execução direta preservada da preferência anterior do usuário: implementador principal tarefa a tarefa, TDD e uma revisão independente final conforme a skill de execução. Não iniciar agora: este documento ainda precisa de revisão do usuário. Antes do primeiro RED, conferir status/branches e ler spec + plano; baseline A: `npm test`, `npm run test:worker`, `npm run build`, `npm run build:worker`; baseline F: `npm test -- --maxWorkers=2`, `npm run typecheck`, `npm run build:preview`. Documentar falhas preexistentes sem mascará-las ou refatorar UI não relacionada.

---

### Task 1: Contrato de invalidação e flags inertes

**Files:** Create A `src/modules/realtime/contracts.ts`, `contracts.test.ts`; modify A `src/worker/environment.ts`, `environment.test.ts`; modify F `src/lib/env.ts`, `src/vite-env.d.ts`; create F `src/test/realtime-env.test.ts`.

**Interfaces:** `RealtimeTopic = "orders" | "kitchen" | "table_sessions" | "payments"`; `CommittedChange = { restaurantId: string; topics: readonly RealtimeTopic[]; orderIds: readonly string[]; entityId: string; reason: "created" | "updated" | "cancelled" | "payment_changed" | "check_requested" | "closed" | "transferred" }`; `RealtimeEnvelope = { version: 1; eventId: string; sequence: number; topic: RealtimeTopic; entityId: string; reason: CommittedChange["reason"] }`. Exportar `isRealtimeEnabled(value: string | undefined): boolean` e `parseRealtimeEnvelope(value: unknown): RealtimeEnvelope | null`; aceitar somente campos/tipos conhecidos. Binding opcional A `RESTAURANT_REALTIME`; F `ENV.realtimeEnabled`.

- [ ] **RED:** Adicionar testes `flags default off`, `reject unknown event payload`, `disabled does not require DO`; no frontend validar flag ausente e literal `true`.

```ts
assert.equal(isRealtimeEnabled(undefined), false);
assert.equal(isRealtimeEnabled("false"), false);
assert.equal(isRealtimeEnabled("true"), true);
assert.equal(parseRealtimeEnvelope({ version: 1, token: "synthetic" }), null);
```

- [ ] **Confirmar RED:** A `npx tsx --test src/modules/realtime/contracts.test.ts src/worker/environment.test.ts`; F `npm test -- src/test/realtime-env.test.ts --maxWorkers=2`. Falha deve apontar os novos contratos/flag, não configuração externa.
- [ ] **GREEN:** Implementar somente os tipos/parser/flags. Não tornar DO obrigatório em `configFromWorkerBindings`, não ligar flag nas configurações reais. `sequence` é inteiro seguro não negativo; entidade UUID e envelope limitado a 4 KiB. Não acrescentar campos de negócio.
- [ ] **Verificar:** Reexecutar testes direcionados e builds/typecheck dos dois repos; todos devem passar com flag desligada.
- [ ] **Commit:** Adicionar somente os arquivos desta tarefa em cada repo; mensagens `feat: define realtime invalidation contract` e `feat: add inert frontend realtime flag`.

### Task 2: Adaptador de autorização sem credenciais persistidas

**Files:** Create A `src/modules/realtime/authorization.ts`, `authorization.test.ts`; modify A `src/composition/api-services.ts`, `api-services.test.ts`. Reusar `src/modules/auth/runtime.ts`, `src/modules/orders/service.ts`, `src/lib/permissions.ts` sem alterar respostas existentes de `/auth/me`.

**Interfaces:** `RealtimeGrant` é união `{ mode: "owner"; restaurantId; userId; sessionId; sessionExpiresAt: number }` ou `{ mode: "order"; restaurantId; orderId; tokenFingerprint: string }`, com strings para IDs. `RealtimeAuthorization.admit(input: { mode: "owner"; restaurantId: string; headers: Headers } | { mode: "order"; orderId: string; token: string }): Promise<RealtimeGrant>`; `revalidate(grants: readonly RealtimeGrant[], now: number): Promise<readonly boolean[]>`. `createRealtimeAuthorization({ database: Queryable, authRuntime: AuthRuntime, orders: OrderService, ownershipLookup: OwnershipLookup }): RealtimeAuthorization`. `ApiServices.realtimeAuthorization` lazy.

- [ ] **RED:** `owner must own restaurant`, `guest derives tenant from verified order`, `revoked session and token reject`, `grouped validation has no persistent cache`.

```ts
await assert.rejects(auth.admit({ mode: "owner", restaurantId: otherId, headers: ownerHeaders }));
assert.equal((await auth.admit({ mode: "order", orderId, token })).restaurantId, actualRestaurantId);
assert.deepEqual(await auth.revalidate([revokedOwner, invalidatedGuest], now), [false, false]);
```

- [ ] **Confirmar RED:** A `npx tsx --test src/modules/realtime/authorization.test.ts src/composition/api-services.test.ts`.
- [ ] **GREEN:** Usar sessão integral retornada por `AuthRuntime.getSession` só durante admissão; não alargar `AuthContext` público. Hash SHA-256 do token validado compatível com `orders.public_access_token_hash`. Na revalidação consultar `better_auth.session` (ID/user/expiry), `restaurants.owner_id` e pedido/token hash, por parâmetros e só campos necessários. Agrupar identidades no lote, falhar fechado e não registrar queries com valores. Não mudar schema, grants ou migrar Better Auth para Neon Auth.
- [ ] **Verificar:** Reexecutar testes, `npm run build`; provar que getters permanecem lazy e que o retorno não inclui cookie, token em claro ou email.
- [ ] **Commit:** Somente os quatro arquivos indicados, `feat: authorize scoped realtime grants`.

### Task 3: Durable Object hibernável com tickets e limites

**Files:** Create A `src/worker/realtime/restaurant-room.ts`, `ticket-store.ts`, `room-policy.ts` e testes Node `ticket-store.test.ts`, `room-policy.test.ts`; create A `src/worker/realtime.workerd.ts`, `src/worker/realtime-test-fixture.ts`, `wrangler.worker-realtime-test.jsonc`. Tipos de plataforma existentes em `@cloudflare/workers-types`, sem pacote novo.

**Interfaces:** `RoomAdmission = { environment: "preview" | "production"; origin: string; grant: RealtimeGrant }`; `RealtimeTicket = { ticket: string; restaurantId: string; expiresAt: number }`; `RealtimeRoomPort.issueTicket(admission: RoomAdmission): Promise<RealtimeTicket>`, `publish(change: CommittedChange): Promise<{ delivered: number }>`. `RestaurantRealtime` exporta esses métodos internos por binding e `fetch(request: Request): Promise<Response>`, `alarm(): Promise<void>`, handlers Hibernation `webSocketMessage`, `webSocketClose`, `webSocketError`. Controle servidor `RealtimeReady = { version: 1; type: "ready"; leaseExpiresAt: number }`; cliente `RealtimeAck = { version: 1; type: "ack"; sequence: number }`. `fetch` só aceita upgrade GET, não publicação HTTP. Construção recebe estado DO/env; adaptador real usa Hyperdrive por invocação e encerra pool em `finally`, sem pool global ou PG nos attachments. Exportar tipos de controle junto aos contratos da Task 1.

- [ ] **RED:** Tickets expiram em 30 s, só um consumo vence em duas admissões concorrentes; armazenamento não contém ticket bruto. Teste workerd de duas salas, dois pedidos e owner, ticket/origem trocados, `101`, protocolo negociado sem ticket, frames 4096/4097 bytes, 128/129 sockets e 256/257 tickets. Validar limite 24 por usuário proprietário ou pedido público, não por IP. Fixtures injetam autorização fake alterável e usam apenas dados sintéticos.

```ts
assert.equal(ticket.expiresAt - now, 30_000);
assert.equal(upgrade.status, 101);
assert.equal(upgrade.headers.get("sec-websocket-protocol"), "vapt.realtime.v1");
assert.equal(guestFrames.some(frame => frame.entityId === otherOrderId), false);
```

- [ ] **Confirmar RED:** A `npx tsx --test src/worker/realtime/*.test.ts src/worker/realtime.workerd.ts`. Usar `createTestHarness`/workerd, padrão já existente, não jsdom para provar upgrade.
- [ ] **GREEN:** Gerar ticket base64url com `crypto.getRandomValues`; protocolo de admissão `vapt.ticket.<ticket>` além do estável. Registrar hash + grant/origem/ambiente/expiração em SQLite, consumir atomicamente antes de aceitar e revalidar após awaits relevantes. Attachments versionados contêm só escopo/expiração/metadados não reutilizáveis. Hibernation `acceptWebSocket`, restauração via `getWebSockets`/attachments e alarmes para prazo mínimo, cancelados em sala vazia. Separar sequência owner e por pedido; podar sequências de pedidos sem consumidores/tickets para não acumular histórico permanente.
- [ ] **GREEN:** Publicação revalida o lote antes de cada envio, aplica tópicos/entidade por audiência e nunca emite envelope global ao público; envelope público usa orderId como entidade, não ID de pagamento/sessão. Enviar `ready` após aceitação para informar o prazo da concessão. Só aceitar controles heartbeat/ack; close 1008 para violação, 1009 para frame grande, 1013 para capacidade/indisponibilidade. Aplicar timeout de validação/publicação de 2 s e saída individual até 4 KiB. Backpressure de aplicação: no máximo 32 envelopes sem ack por conexão, depois fechar 1013; guardar só lastSent/lastAck no attachment, nunca fila de payloads. Ack deve avançar dentro da sequência enviada àquela conexão, nunca de outra audiência e nunca renovar concessão. Em erro de send, fechar conexão e preservar demais destinatários.
- [ ] **Verificar:** Testar reativação pelo mecanismo de eviction do harness disponível (confirmar API antes de usar), expiração simultânea ao broadcast, revogação e restauração de attachments corrompidos (fechar, nunca autorizar por fallback). Cliente sem ack fecha antes do 33º envelope; ack futuro/de outra sequência é rejeitado e não concede autoridade. Testar cleanup de storage/alarme e sequências, sem depender só de constructor manual como prova de hibernação. Rodar testes direcionados, `npm run build` e dry-run do config de teste.
- [ ] **Commit:** Arquivos da tarefa, `feat: add hibernating restaurant realtime rooms`.

### Task 4: Rotas, publicação degradável e perímetro do Worker

**Files:** Create A `src/worker/routes/realtime.ts`, `src/worker/realtime/publisher.ts`, `publisher.test.ts`; modify A `src/worker/{index.ts,parallel-preview.ts,app.ts,http.ts,environment.ts,services.ts,route-contract.ts,route-contract.test.ts,test-fixture.ts}`; extend A `realtime.workerd.ts`, `parallel-preview.test.ts`.

**Interfaces:** `registerWorkerRealtimeRoutes(app: Hono<WorkerHonoEnv>): void`; `CommittedChangePublisher = (change: CommittedChange) => Promise<void>` definido em `src/modules/realtime/contracts.ts`; `createWorkerRealtimePublisher(env: WorkerBindings, onFailure: (code: "realtime_publish_failed") => void): CommittedChangePublisher`. Adicionar `ApiServiceDependencies.publishCommittedChange?: CommittedChangePublisher`, default noop; configurar no Worker, não no Fastify/Coolify. Reexportar classe DO nos entrypoints Worker e Preview.

- [ ] **RED:** POST union discriminada com UUIDs, GET upgrade válido, Origin ausente/null/errado, ticket repetido, bearer ausente/incorreto, binding faltando, flag off; HTTP normal conserva CORS/cookies e limites anteriores. Usar `workerRateLimit("public")` para ambas as rotas e os limites de sala da Task 3; ausência do binding rate-limit continua 503. Não inventar um sétimo namespace.

```ts
assert.equal(noBearer.status, 401);
assert.equal(noOrigin.status, 403);
assert.equal(enabledWithoutRoom.status, 503);
await assert.doesNotReject(() => publishWithMissingBinding(committedChange));
assert.equal(validUpgrade.webSocket !== undefined, true);
```

- [ ] **Confirmar RED:** A `npx tsx --test src/worker/realtime/publisher.test.ts src/worker/parallel-preview.test.ts src/worker/route-contract.test.ts src/worker/realtime.workerd.ts`.
- [ ] **GREEN:** Habilitação antes de criar serviços/DO quando off; POST sem campos extras, origem exata e resposta `no-store`; GET devolve o upgrade original. Ajuste CORS apenas para preservar a Response WebSocket sem regressão HTTP. Publisher seleciona sala pelo restaurante autoritativo, limita execução em 2 s e engole somente erros de transporte observados com código seguro. Não liberar publicação via endpoint público ou aceitar `CommittedChange` do navegador.
- [ ] **Verificar:** Reexecutar direcionados e suíte workerd inteira; confirmar `101` atravessa app + middleware + wrapper com headers de operador somente na fixture privada. Testes de configuração desligada não inicializam DO/banco desnecessariamente.
- [ ] **Commit:** Arquivos da tarefa e contratos/composição necessários, `feat: expose authorized realtime admission in Worker`.

### Task 5: Emissores reais de negócio, somente após commit

**Files:** Modify A `src/composition/api-services.ts`, `src/modules/orders/{repository.ts,service.ts}`, `src/modules/kitchen/repository.ts`, `src/modules/table-sessions/repository.ts`, `src/modules/payments/{repository.ts,composition.ts}`; extend testes existentes `orders.test.ts`, `kitchen.test.ts`, `table-sessions.test.ts`, payments `repository-postgres.test.ts`, `repository-webhook.test.ts`, `manual-payment.test.ts`, `effects.test.ts`, `reconciliation.test.ts`, providers/mercado-pago `webhook.test.ts`. Create A `src/modules/realtime/committed-changes.test.ts`, `docs/infra-migration-phase-12-realtime-emitters.md`.

**Interfaces:** Opção final opcional `{ publishCommittedChange?: CommittedChangePublisher }` nos construtores de repositório acima; não mudar DTO HTTP. Construir `CommittedChange` a partir de retorno/linhas afetadas autoritativas. Retornos internos podem incluir metadados `changed`/IDs afetados, mas os serviços removem metadados extras antes da resposta pública. Repositório de pagamento observado deve receber `Database`/pool com transação sob seu controle: nunca assumir que uma query em `PoolClient` de transação externa já foi commitada.

**Matriz obrigatória de emissores:**

| Caminho real | Emissão depois de mudança confirmada |
| --- | --- |
| `orders.createPublicOrder`, sem `idempotentReplay` | `orders`, `kitchen`, `table_sessions` quando houver sessão; orderId criado |
| `kitchen.updateOwnedOrderStatus`, status realmente mudou | `orders`, `kitchen`, `table_sessions`; orderId alterado |
| `tableSessions.requestPublicCheck` | `table_sessions`; pedido público não recebe atividade da mesa |
| `tableSessions.closeOwnedSession`/`transferOwnedSession` | `table_sessions` e `orders`/`kitchen` apenas se dados desses pedidos mudaram; IDs capturados na transação |
| `payments.applyPaymentTransition` via checkout, manual, return reconciliation ou webhook MP | `payments`, `orders`, `kitchen`, `table_sessions`; somente se versão/status pertinente mudou |
| `payments.releaseOrderToProduction` via effects/reconciliation | `orders`, `kitchen`, `table_sessions` somente se estado do pedido mudou |

Cancelar é motivo válido quando o caminho de pagamento existente realmente cancela o pedido; não criar API de cancelamento inexistente. Stripe nesta base trata assinatura SaaS, não status de pedido de restaurante: registrar como não emissor desses tópicos, sem confundir billing com pagamento de mesa. Criar documentação final do mapa usando funções/linhas reais.

- [ ] **RED:** Criar fixture Database que registra BEGIN/COMMIT/ROLLBACK e falha no COMMIT; simular replay, atualização repetida e erro do publisher; exercitar todos os caminhos da matriz, inclusive webhook/reconciliação por injeção de fake provider.

```ts
assert.equal(trace.indexOf("COMMIT") < trace.indexOf("publish"), true);
assert.equal(publishedAfterCommitFailure.length, 0);
assert.equal(publishedOnIdempotentReplay.length, 0);
assert.deepEqual(resultWithPublisherFailure, resultWithNoPublisher);
```

- [ ] **Confirmar RED:** A `npx tsx --test src/modules/realtime/committed-changes.test.ts src/modules/orders/orders.test.ts src/modules/kitchen/kitchen.test.ts src/modules/table-sessions/table-sessions.test.ts src/modules/payments/repository-postgres.test.ts`.
- [ ] **GREEN:** Capturar mudança e IDs dentro da transação; chamar publisher só após `withTransaction` retornar com COMMIT. Chamadas SQL autocommit só contam após sucesso; se for necessária leitura antes/depois para detectar no-op de rotina que retorna void, fazê-la na transação controlada com lock adequado. Não alterar SQL functions/versionar schema para transportar eventos, nem introduzir outbox. Manter caminhos/read-only que recebem `Queryable` compatíveis, sem observer em transação externa. Garantir failure handler não lança erro para o chamador após commit.
- [ ] **Verificar:** `npm test`, `npm run test:worker`, `npm run build`; testes de webhook/effects entram na suíte completa. Documento cobre cada linha da matriz e registra funções que não alteram esses domínios. Nenhuma chamada real de provider nesta tarefa.
- [ ] **Commit:** Arquivos/fixtures/documento indicados, `feat: publish committed restaurant invalidations`.

### Task 6: Cliente compartilhado e recuperação autoritativa

**Files:** Create F `src/lib/realtime/{contracts.ts,client.ts,resync.ts}`, `src/hooks/use-realtime-refresh.ts`, `src/test/realtime-client.test.ts`, `src/test/realtime-refresh.test.tsx`; modify F `src/contexts/AuthContext.tsx` para limpar escopos de proprietário no logout/troca. Contrato frontend espelha envelope A, sem depender de filesystem do outro repo.

**Interfaces:** `RealtimeScope = { mode: "owner"; userId: string; restaurantId: string } | { mode: "order"; orderId: string; token: string }`; `subscribeRealtime(scope: RealtimeScope, onSignal: (signal: "connected" | RealtimeEnvelope) => void, onState: (state: "connected" | "fallback" | "unauthorized") => void): () => void`; `clearOwnerRealtimeScopes(): void`; `useRealtimeRefresh({ scopes, topics, enabled, refresh, fallbackMs }: { scopes: readonly RealtimeScope[]; topics: readonly RealtimeTopic[]; enabled: boolean; refresh: () => Promise<void>; fallbackMs: number }): void`. Tokens ficam só em memória/armazenamento já existente; não incluí-los em chaves logáveis da registry.

- [ ] **RED:** Mock WebSocket, fetch e relógio; provar uma conexão para dois consumidores do mesmo escopo, nenhuma mistura owner/order, ticket apenas nos subprotocolos, URL sem segredo, renovação antes do `leaseExpiresAt` de `ready` (máximo 5 min), backoff 1–30 s, offline/hidden, cleanup e troca de identidade enquanto ticket está pendente.

```ts
expect(socketCreationsForSameScope).toBe(1);
expect(socketUrl).not.toContain(token);
expect(refetchDuringInitialSnapshot).toHaveBeenCalledTimes(2);
expect(socketOpenedAfterIdentitySwitch).toBe(false);
expect(reconnectDelay).toBeGreaterThanOrEqual(1_000);
expect(reconnectDelay).toBeLessThanOrEqual(30_000);
```

- [ ] **Confirmar RED:** F `npm test -- src/test/realtime-client.test.ts src/test/realtime-refresh.test.tsx --maxWorkers=2`.
- [ ] **GREEN:** POST via `vaptApiRequest`, cookie só owner e `X-Vapt-Order-Token` só order; derivar wss de https e ws apenas localhost de http. Registry com refcount/generation guard cancela admissão obsoleta. Não expor impressão do token ao frontend. Espelhar os tipos de envelope, ready e ack de A em F contracts; parser recusa versão/tópico/frame indevido e dispara fallback seguro. Não aceitar tópico privado em socket público. Ack avança somente após envelope válido, sem consultar banco; controles não são eventos de negócio. Renovar 5 s antes do prazo de `ready` quando houver tempo; prazo muito curto/inválido encerra socket e usa fallback, sem hot loop. Ticket expirado requer novo POST, nunca replay. Owner pode esperar mudança de sessão; público só retenta autenticação após token/escopo mudar ou ação explícita, sem loop 401.
- [ ] **GREEN:** Hook mantém fila de refetch (um em andamento, mais um dirty), debounce 250 ms e consulta inicial após `connected`. Backup 30 s quando saudável; fallback único com intervalo do chamador; suspender tentativas realtime offline/hidden e ressincronizar ao retornar. Limpar listeners/timers/consumidores, renovar sem overlap de sockets além da substituição limitada e sem duplicar refresh.
- [ ] **Verificar:** Direcionados + `npm run typecheck`, `npm run build:preview`; tempo fake prova perdas silenciosas/refetch em 30 s e nenhum segundo timer de polling. Reexecutar `auth-session.test.tsx` e `better-auth-flows.test.tsx` para logout.
- [ ] **Commit:** Arquivos da tarefa, `feat: add scoped realtime client with polling recovery`.

### Task 7: Integrar cozinha, caixa e pedidos sem redesenho

**Files:** Modify F `src/pages/dashboard/{KitchenMonitor.tsx,CashierPage.tsx}`, `src/pages/menu/PublicMenu.tsx`, `src/components/menu/MyOrdersDrawer.tsx`, `src/pages/delivery/PublicDelivery.tsx`; extend F `src/test/{kitchen-monitor.test.tsx,cashier-flow.test.tsx,delivery-online-checkout.test.tsx}`, create F `src/test/public-order-realtime.test.tsx`; extend A `realtime-test-fixture.ts` para fluxo sintético local sem secrets/provider.

**Interfaces:** Consumir `useRealtimeRefresh` e endpoints HTTP já existentes. Resolver restaurante owner por `fetchOwnedRestaurant` já usado no caixa; cozinha pode reutilizar lookup sem ampliar cargos. Menu/drawer usam `readStoredOrderAccess`, delivery usa lastOrderId/token existentes. Nenhuma assinatura tenant-wide para público.

- [ ] **RED:** Pedido criado atualiza cozinha/caixa; mudança ready atualiza somente seu acompanhamento; re-render e sinal duplicado não duplicam som/toast. Delivery consulta seu pedido, menu não abandona polling de catálogo, drawer fechado não cria assinatura. Preservar relógio/autoarchive da cozinha e tick do caixa.

```ts
expect(kitchenRefreshesAfterOrderCreated).toBe(1);
expect(readyToastCountAfterDuplicateSignal).toBe(1);
expect(subscribedOrderIds).not.toContain(otherOrderId);
expect(activeDrawerSocketsAfterClose).toBe(0);
```

- [ ] **Confirmar RED:** F `npm test -- src/test/kitchen-monitor.test.tsx src/test/cashier-flow.test.tsx src/test/public-order-realtime.test.tsx src/test/delivery-online-checkout.test.tsx --maxWorkers=2`.
- [ ] **GREEN:** Substituir apenas timers de fetch pelo hook, manter fetch inicial/fallback e refresh manual sem duplicação. Cozinha escuta orders/kitchen, caixa table_sessions/payments/orders, público somente orders de cada pedido ativo. Respeitar até 24 acessos existentes; compartilhar o socket entre menu e drawer para mesmo pedido.
- [ ] **Verificar:** Suíte F inteira, typecheck/build. Iniciar harness Worker local e Vite local com flags opt-in efêmeras, sem substituir `.env.preview` de bootstrap. Validar no navegador dois restaurantes, criação/status/caixa, desconectar/reconectar e logout; registrar prova navegador local separada da futura prova remota. Dados somente sintéticos, timers/serviços encerrados ao final.
- [ ] **Commit:** Arquivos desta tarefa, `feat: integrate realtime into restaurant order screens`.

### Task 8: Gate ACL preview e configuração verificável de publicação

**Files:** Modify F `infra/neon/verify-worker-preview-role.sql`; create A `scripts/verify-preview-acl-regression.mjs`, `scripts/verify-realtime-preview-config.mjs`, `scripts/verify-realtime-preview-config.test.mjs`; modify A `wrangler.worker-parallel-preview.jsonc`, `scripts/verify-parallel-preview-config.test.mjs`; create A `scripts/verify-preview-acl-target.test.mjs`.

**Interfaces:** Regression ACL recebe somente stdin JSON `{ ownerUrl: string; verifierPath: string }`; guard host `ep-hidden-bird-b673zocn.c-2.sa-east-1.aws.neon.tech`, database `vapt`, owner `neondb_owner`, arquivo `verify-worker-preview-role.sql`. Rejeitar host production antes de conexão. Exportar `checkRealtimePreviewConfig(config: unknown): { ok: boolean; failures: readonly string[] }`, sem secrets. Binding `RESTAURANT_REALTIME` para classe local em `previews.durable_objects.bindings`, migração SQLite tag `stage12-realtime-sqlite-v1` na lista de migrations do arquivo; adicionar `REALTIME_ENABLED: "true"` somente em `previews.vars`. Shell/top-level segue sem tráfego/bindings e não recebe deploy: só publicar named Preview. Flag frontend remota off.

- [ ] **RED:** Config rejeita `script_name`, namespace compartilhado, HD/role/bucket production, DO ou flag no top-level, paid/KV migration, remoção de Access/bearer, Cron/queue/route nova. Regression-target rejeita host production sem abrir conexão. ACL regressions: baseline passa; column SELECT indevido, EXECUTE em rotina legacy e propriedade de função são rejeitados.

```js
assert.equal(checkRealtimePreviewConfig(configWithCrossWorkerRoom).ok, false);
assert.equal(checkRealtimePreviewConfig(configWithProductionBinding).ok, false);
assert.equal(checkRealtimePreviewConfig(isolatedPreview).ok, true);
```

- [ ] **Confirmar RED:** A `node --test scripts/verify-realtime-preview-config.test.mjs scripts/verify-preview-acl-target.test.mjs`. Testes ACL SQL reais entram somente quando conexão preview segura estiver disponível; não substituir por falso PASS offline.
- [ ] **GREEN:** Espelhar o allowlist exato da role preview/grants atuais, com cobertura column ACL, pg_proc ownership e exceção restrita ao pgcrypto revisado. Reusar padrão rollback-only do regression production sem editar seu script/alvo. Nada persiste além da leitura: testes que introduzem capacidade insegura sempre fazem ROLLBACK, inclusive erro no verificador. Nenhum password é rotacionado nem grant ampliado.
- [ ] **Verificar:** Direcionados de scripts + `node --test scripts/verify-parallel-preview-config.test.mjs`; `npx wrangler deploy --dry-run --config wrangler.worker-parallel-preview.jsonc` prova bundle e ausência de bindings top-level, não publica nem certifica config resolvida de Preview. Habilitar bindings sintéticos equivalentes no config workerd da Task 3 para prova local. Publicação real usa `npx wrangler preview --name stage11-inert --config wrangler.worker-parallel-preview.jsonc --ignore-base-config`, sintaxe conferida na ajuda instalada 4.138.0; só executar na Task 9. Inspecionar namespace efetivamente Preview e produção sem novo deploy antes do smoke.
- [ ] **Commit:** Dois repos, somente arquivos da tarefa; `fix: tighten preview ACL verification` e `feat: configure isolated preview realtime namespace`.

### Task 9: Smoke remoto, limpeza, revisão e handoff

**Files:** Create A `scripts/verify-realtime-preview.mjs`, `scripts/verify-realtime-preview.test.mjs`, `docs/infra-migration-phase-12-realtime.md`; modify F `docs/infra-migration-plan.md` apenas com registro/evidências da etapa, sem alterar ordem ou arquitetura aprovada.

**Interfaces:** Exportar `validateTarget(baseUrl: string, origin: string): URL`, com match exato do named Preview existente e origem frontend Preview. Smoke recebe somente stdin JSON `{ baseUrl: string; origin: string; accessJwt: string; bearer: string }`. Usar `ws` já presente no lockfile/node_modules para cliente operador com headers configuráveis; imports do runner são guardados para não consumir stdin durante testes. Não usar WebSocket nativo do navegador para essa prova e não instalar pacote novo. Admissão owner/order continua separada dos headers de perímetro. Secrets só em memória, `WRANGLER_WRITE_LOGS=false` e `WRANGLER_SEND_METRICS=false` antes de CLI sensível; nunca imprimir input/token/URI/cookies.

- [ ] **RED:** Testar guard URL/origem, validação e redaction; script recusa production/base arbitrária e saída contém somente status/contagens, não segredos sintéticos. Smoke executa no máximo dois owners/tenants e dois pedidos por tenant, sem disparar email para cliente/provider Live.

```js
assert.throws(() => validateTarget("https://api.vapt.app.br", previewOrigin));
assert.equal(safeOutput.includes("synthetic-bearer"), false);
assert.equal(safeOutput.includes("synthetic-cookie"), false);
```

- [ ] **Confirmar RED/GREEN local:** A `node --test scripts/verify-realtime-preview.test.mjs`, implementar guard/runner; rodar suites A/F completas, builds/dry-runs e diff check. Não fazer deploy se qualquer gate de segurança falhar.
- [ ] **Preflight remoto:** Consultar plano Free, estado Access/Preview, Neon branch/role/HD e contagens de resíduos, sem alterações em production. Executar verifier/regression ACL preview com conexão direct e stdin protegido. Recuperar credenciais existentes por mecanismo seguro; autenticação expirada exige login do usuário, não novo token persistente/bypass. Registrar readback não secreto.
- [ ] **Publicar:** Reusar `stage11-inert` pelo fluxo Preview existente, confirmar export/class migration SQLite e namespace separado; não clicar upgrade/abrir rota pública. URL/bearer/Access continuam exigidos. Dry-run/readback não equivalem a namespace isolado testado: realizar inspeção e requests reais.
- [ ] **Smoke:** Provar edge deny sem Access, wrapper deny sem bearer e admissão de sessão/token; criar pedidos sintéticos, observar cozinha/caixa owner e somente order correspondente público, revogar sessão, desconectar/reconectar e buscar snapshot HTTP. Assinar apenas eventos sintéticos existentes; Stripe/MP ficam fake ou Test conforme requisito, sem novas compras.
- [ ] **Limpar:** Fechar sockets, apagar tickets/coordenação e dados Neon somente dos IDs/etiquetas do smoke; confirmar zero resíduos criados e nenhuma gravação em production. Não excluir namespace/branch/bucket amplo nem destruir migração DO. Falha de cleanup é pendência explícita, não etapa concluída.
- [ ] **Revisão e handoff:** Uma revisão independente final da branch, conforme execução direta, cobre spec, segurança e arquivos dos dois repos; resolver achados e reexecutar testes afetados. Handoff registra comandos/resultados, versão Preview/namespace/IDs não secretos, emissor→teste, quotas observadas, cleanup, rollback e limitação navegador remoto. Não alegar validação production ou equivalência Coolify indisponível.
- [ ] **Commit e PR:** Commitar somente smoke/testes/handoff e nota canônica; push das branches já escolhidas e atualizar PRs API 1/frontend 4 com evidências da Etapa 12. Preservar PR billing 3, explicar consolidação ainda necessária; não fazer merge/main cutover. Falhas/limitações aparecem no resumo, não são escondidas pela atualização da PR.

## Gate seguinte: produção, sem refazer funcionalidades

O mesmo código, contrato e cliente serão usados em production. Na Etapa 13, após revisão específica, o checklist é: consolidar os repos/PRs incluindo billing, configurar namespace SQLite próprio e bindings/secrets de production, validar sessão/cookies no pareamento real, testar tráfego controlado e fallback, então ativar domínio/rotas e emissores necessários. Não clonar credenciais nem namespace preview, nem portar novamente as funcionalidades. Sem autorizar pagamento/upgrade para viabilizar o cutover; caso os limites Free não sustentem o requisito, reportar o impedimento e manter fallback antes de qualquer mudança de plano.

Este plano termina com a prova privada e o código pronto para esse gate. Implementação de relay remoto, cargos de funcionários, novos endpoints de negócio, backup ou aposentadoria Coolify são outros escopos do plano canônico.
