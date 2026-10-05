# Etapa 12 — Realtime Vapt com Durable Objects e WebSockets

Status: desenho e especificação escrita aprovados pelo usuário em conversa em 05/10/2026; plano de implementação aguarda revisão. A ativação pública em produção continua fora desta etapa.

## Objetivo e limites

Substituir a atualização frequente por polling dos fluxos de pedidos, cozinha e caixa por notificações WebSocket, mantendo o Neon como fonte de verdade e o polling como recuperação. Cada restaurante deve ter uma sala isolada; um cliente público deve acompanhar somente seus próprios pedidos. O produto está em desenvolvimento, sem clientes ou dados de produção a preservar.

Esta etapa segue a Etapa 12 de `D:/Projetos/vaptmesaflow/docs/infra-migration-plan.md`. A API pública continua no Coolify. Vercel e Easypanel são legado, não alvos de reparo. Não mudar DNS, tráfego, API pública, Cron, Stripe Live, planos pagos nem recursos de production. A preferência de integração continua sendo branch + PR, sem merge automático na main.

A implementação será validada primeiro localmente e depois na API Preview privada. Não confundir prova remota por script com integração real de navegador remoto. O pareamento público final e a ativação em produção pertencem ao gate de cutover da Etapa 13.

## Contexto auditado

- A API usa Hono no Worker, Better Auth e Hyperdrive/Neon. O acesso privado atual é por proprietário do restaurante (`owner_id`), não por uma matriz já implementada de cargos de funcionários.
- A API Preview `vapt-api-parallel`, Preview nomeado `stage11-inert`, exige Cloudflare Access e um bearer exclusivo de teste. Esse bearer nunca pertence ao frontend.
- O frontend atual usa polling: cozinha e caixa a cada 5 s, acompanhamento público a cada 4–8 s. Não foram encontrados canais Supabase Realtime ativos nesses fluxos. Não reintroduzir Supabase para cumprir literalmente o nome da etapa.
- O frontend Preview mantém um endpoint de API inválido de bootstrap; ainda não existe pareamento remoto certificado. A Etapa 11 também não certificou cookies entre os dois hostnames `workers.dev`.
- O verificador SQL de privilégios do preview tem uma dívida registrada na Etapa 11: deve receber cobertura equivalente à do verificador de production antes da aceitação remota ampliada. Isso não autoriza novos grants nem mudanças em production.

## Decisão arquitetural

Exportar a classe `RestaurantRealtime` no próprio Worker da API. O plano canônico permite essa simplificação; o contexto atual favorece reutilizar a autenticação, os serviços e o perímetro privado, sem um segundo Worker público, novas credenciais de serviço ou duplicação de regras de autorização. Separar o módulo de transporte, o adaptador de autorização, o publicador de invalidações e o cliente frontend por contratos pequenos.

Usar um Durable Object por UUID de restaurante, em namespace exclusivo do Preview. A classe será local ao Worker, sem `script_name` apontando para outro Worker. O binding nomeado será declarado explicitamente na configuração de Previews; não depender de herança dos bindings de produção. Não adicionar binding realtime ao shell de production nesta etapa. O namespace não poderá ser compartilhado com production ou outro Preview. [Isolamento de recursos em Previews](https://developers.cloudflare.com/workers/previews/resources/).

O armazenamento do DO será SQLite, com migração `new_sqlite_classes`. Workers Free suporta esse backend e, ao exceder suas cotas, as operações correspondentes falham; a solução deve cair para polling, nunca ativar upgrade. Confirmar o plano efetivo da conta em consulta somente leitura antes da publicação. Isso não promete custo zero para todos os outros serviços já contratados. [Disponibilidade e limites do plano Free](https://developers.cloudflare.com/durable-objects/platform/pricing/).

O DO guarda apenas coordenação: tickets de admissão com prazo curto, metadados mínimos de autorização, conexões e sequência de notificações. Não guardar pedidos, pagamentos, catálogo, emails ou sessões completas como um segundo banco. Não introduzir Queue/outbox realtime nesta etapa: a entrega de invalidações é best-effort e recuperável por consultas à API.

## Contrato de admissão e autorização

Adicionar `POST /v1/realtime/tickets` e `GET /v1/realtime/restaurants/:restaurantId/socket`. Esses caminhos são aditivos; não substituir endpoints HTTP de negócio. Ambos exigem origem exata permitida, validação de formato, limitação de requisições e recurso realtime habilitado. O POST retorna somente ticket opaco, restaurante e validade, com `Cache-Control: no-store`.

O POST admite duas modalidades fechadas:

- Proprietário: corpo com modalidade `owner` e UUID de restaurante; validar a sessão Better Auth e a propriedade atual usando as regras existentes.
- Pedido público: corpo com modalidade `order` e UUID de pedido; validar o `X-Vapt-Order-Token` pelo serviço atual e derivar o restaurante no servidor. Não confiar em um restaurante declarado pelo cliente nem usar UUID como credencial.

O navegador não consegue configurar headers HTTP arbitrários no construtor WebSocket. Portanto, o ticket de uso único irá no `Sec-WebSocket-Protocol`, junto ao protocolo estável `vapt.realtime.v1`; o servidor negociará apenas o protocolo estável, sem devolver o ticket. Não colocar ticket, cookie, bearer ou token de pedido na URL, logs, métricas, Git ou mensagens de erro. O UUID do restaurante na URL não é secreto nem concede acesso.

Cada ticket terá pelo menos 256 bits aleatórios, validade de 30 s e vínculo com ambiente, restaurante, modalidade, identidade autorizada e Origin. O DO guarda seu hash, nunca o ticket em claro, e consome-o atomicamente uma única vez no upgrade. Revalidar a autorização atual na admissão; rejeitar expiração, replay, origem divergente ou troca de restaurante antes do `101`. Limitar a quantidade de tickets pendentes e remover expirados; nenhum crescimento ilimitado de storage.

O socket recebe uma concessão de no máximo 5 minutos, limitada também à expiração da sessão do proprietário. A renovação exige nova admissão HTTP autenticada, não uma mensagem autoautorizadora no socket. O cliente renova uma conexão por vez e refaz a consulta autoritativa; o servidor encerra concessões vencidas usando alarmes agrupados, sem intervalo permanente por conexão.

O adaptador de autorização precisa expor proveniência mínima que o `AuthContext` atual não contém: ID não secreto da sessão, usuário e expiração para proprietário; pedido, restaurante e impressão criptográfica não reutilizável do token validado para público. Essa impressão não é aceita como credencial em endpoint algum. Não persistir cookies, tokens de sessão ou tokens públicos em claro no DO ou em attachments.

Antes de enviar uma invalidação privada, conferir no Neon que a sessão ainda existe e não expirou e que a propriedade segue válida; para público, conferir pedido/restaurante e a impressão do token contra o registro atual. Falha ou indisponibilidade dessa validação fecha a conexão sem emitir o evento. Reutilizar a autorização dentro de um único lote, não entre lotes. Consultas são agrupadas por identidade; ping não consulta banco. Isso impede que um socket aberto preserve acesso após revogação ou transferência de propriedade. Não prometer cancelamento retroativo de um frame já autorizado e em trânsito.

Os destinatários são determinados pelo servidor. Proprietário recebe apenas eventos do seu restaurante. Público recebe apenas eventos do pedido autorizado, nunca pedidos vizinhos, movimentação geral da sala ou sessões de mesa. A concessão de um pedido não autoriza acompanhar outro. Para até 24 pedidos já armazenados pelo frontend, admitir conexões por pedido somente enquanto o acompanhamento estiver ativo; não criar uma assinatura ampla a partir de um único token.

## Eventos e publicação após commit

Adotar envelopes pequenos e versionados: versão, ID do evento, sequência do escopo autorizado, tópico, entidade pertinente e motivo de invalidação. Proprietário pode receber sequência da sala; público recebe somente sequência do próprio pedido, sem revelar lacunas ou contadores da atividade de outros pedidos. A sequência auxilia detectar mudanças, mas não é cursor de replay durável nem substitui leitura no Neon. Não enviar itens, valores, dados pessoais, tokens ou snapshots de negócio no socket.

Os tópicos são `orders`, `kitchen`, `table_sessions` e `payments`. O público recebe somente `orders` do próprio pedido. O frontend continua consultando catálogo por HTTP/polling; catálogo público não ganha acesso a uma sala privada nesta etapa.

Cobrir os caminhos já existentes que efetivamente alteram o estado: criação de pedido, alteração/cancelamento de pedido, status de cozinha, solicitação/fechamento/transferência de sessão de mesa e mudanças de pagamento confirmadas pelos serviços ou reconciliação. O plano de implementação deve mapear cada caminho real a seus tópicos; nomes conceituais do plano canônico não justificam criar endpoints, cargos ou transições que não existem.

Emitir exclusivamente depois de commit confirmado. Rollback e replay idempotente sem alteração não emitem uma nova mudança. O restaurante e os pedidos afetados vêm do resultado autoritativo da operação, não do input não validado. Transfers invalidam as sessões/pedidos efetivamente afetados, sem emitir para outro tenant por confiar no cliente.

Falha no DO/publicador não desfaz uma venda, não transforma um commit bem-sucedido em resposta de erro e não dispara uma segunda mutação. Publicação terá espera/execução limitada e erro sanitizado observável. Duplicação, coalescência e perda de sinais são toleradas; o frontend recupera estado via HTTP. Webhooks e reconciliação precisam de testes de publicação, sem ativar provider Live ou Cron remoto.

## Cliente frontend e recuperação

Criar um cliente compartilhado por escopo de autorização, com contagem de consumidores e limpeza no unmount, logout ou troca de restaurante. Nunca compartilhar um socket de proprietário com um público, nem reutilizar uma concessão depois da troca de identidade. Conexões de pedidos públicos distintos permanecem separadas.

Ao receber a confirmação de conexão, consultar o estado atual pela API e acumular invalidações recebidas durante essa consulta. Reconsultar uma vez ao final se houve mudança no intervalo. Esse fluxo de assinatura antes da consulta evita perder o evento entre snapshot e conexão. Não aplicar envelopes como mutações locais completas e não criar alertas duplicados apenas por repetir uma invalidação.

Coalescer invalidações em janela de 250 ms e não executar mais de uma consulta simultânea por recurso; uma mudança durante a consulta agenda nova consulta. Quando conectado, manter ressincronização de segurança a cada 30 s para recuperar sinais perdidos. Quando o realtime falhar ou estiver desligado, usar os intervalos atuais de polling, sem acrescentar um segundo timer concorrente.

Reconexão usa backoff com jitter, de 1 a 30 s. Erros de autenticação suspendem reconexão até uma nova autenticação/concessão válida. Offline ou aba oculta suspendem a tentativa ativa de realtime; ao voltar, conectar e ressincronizar. Polling e atualização ao retornar à aba devem preservar a recuperação do estado. Não remover timers de relógio, idade dos pedidos ou outras funções independentes do transporte.

Integrar cozinha, caixa e acompanhamento público (`MyOrdersDrawer`, pedidos prontos no menu e delivery) conforme seus endpoints atuais. Não redesenhar telas, navegação, billing, armazenamento local de pedidos ou regras de negócio. Não fixar URL remota no código: derivar a URL WS da API configurada e validar protocolo/ambiente. A flag frontend fica desligada por padrão em production e em Previews não pareados.

## Hibernação, proteção e consumo

Usar WebSocket Hibernation (`acceptWebSocket`) e reconstruir metadados com attachments após reativação do objeto. Não depender de Map em memória como única fonte da autorização, nem manter `setInterval` que impeça hibernação. Heartbeat, se necessário, deve usar resposta automática do runtime, sem trabalho de banco. [Hibernação e restauração de attachments](https://developers.cloudflare.com/durable-objects/best-practices/websockets/).

O servidor só aceita mensagens de controle do protocolo, nunca comandos de pedido/pagamento. Limitar frames a 4 KiB, sockets a 128 por restaurante e a 24 por identidade autorizada; limitar tickets pendentes a 256 por sala. Rejeitar excesso com erro recuperável e polling, sem expulsar outro tenant ou abrir acesso alternativo. Limitar o broadcast e encerrar clientes lentos sem fila ilimitada. Os testes devem provar esses limites; eles não são promessa de capacidade de produção.

Tickets e attachments terão expiração e limpeza. Alarmes encerram concessões vencidas e limpam tickets; não manter alarme recorrente em sala vazia. Usar métricas sanitizadas de conexões, rejeições, falhas de publicação, reconexões e duração, sem registrar headers de admissão ou identificadores pessoais. Observar os limites Free antes de qualquer ensaio remoto, com volume sintético pequeno e limitado.

## Flags e validação remota sem enfraquecer o perímetro

Definir `REALTIME_ENABLED` no backend e `VITE_REALTIME_ENABLED` no frontend. Ausência equivale a desligado. Com backend desligado, rotas realtime respondem indisponibilidade controlada e nenhuma operação de negócio exige binding DO. Se estiver ligado e o binding estiver ausente/incorreto, os endpoints realtime falham fechados; os endpoints de negócio continuam com a publicação degradada e observável.

Na etapa remota, habilitar somente o named Preview já protegido, depois da verificação local. Manter o bearer e o Access em todas as rotas, inclusive upgrade. Testar com cliente de operador que suporta os headers necessários e conserva segredos só em memória. Confirmar que Hono, middleware CORS e wrapper preservam o `101` e o objeto WebSocket, sem reconstruir uma Response que perca o upgrade.

Não remover o bearer para facilitar teste no navegador, não incluí-lo no bundle e não criar bypass público. A prova de navegador desta etapa começa com frontend + Worker locais e dados sintéticos. A validação em navegador remoto permanece um gate separado: exige um relay server-side aprovado ou o pareamento/domínio público autorizado na Etapa 13. Nenhum relay, Service Token persistente ou nova rota pública é criado implicitamente por esta especificação.

## Critérios de aceitação

1. Testes de autorização para dois restaurantes: proprietário errado, token público errado, pedido vizinho, origem divergente, ticket malformado/expirado/reutilizado, admissão concorrente e ausência de bindings. Nenhum caso transmite evento privado indevido, nem contador que revele movimentação de pedidos vizinhos.
2. Revogação/logout, sessão expirada, mudança de proprietário e invalidação de token público bloqueiam novas admissões e novas emissões privadas; concessões vencidas fecham sem depender de mensagem do cliente.
3. Testes reais em `workerd` exercitam upgrade, passagem pelo middleware/wrapper, emissão filtrada, hibernação/reativação, attachments, alarmes, limites de frames/conexões/tickets e cliente lento.
4. Testes dos serviços provam publicação após commit e ausência após rollback/replay sem mudança; falha do DO mantém a resposta de negócio correta. Cobertura inclui criação de pedido, cozinha, caixa e mudança de pagamento.
5. Frontend local prova recepção cozinha/caixa, acompanhamento somente do próprio pedido, desconexão/reconexão, ressincronização durante mudança concorrente, sinal perdido, polling fallback, limpeza e troca de identidade. Usar duas identidades/tenants, não apenas um smoke feliz.
6. Suítes Node/workerd, typecheck, builds de API/frontend e dry-run Worker permanecem verdes. Inventário HTTP/WS e configuração provam ausência de recurso production e flags desligadas por padrão.
7. Antes da publicação Preview, endurecer o verificador ACL de preview e executar seus testes rollback-only; revalidar Hyperdrive/Neon/R2 e plano Free sem alterar production. Segredos e headers sensíveis não aparecem nos artefatos de teste.
8. Smoke remoto sintético prova Access/bearer deny antes do app, WebSocket autorizado, isolamento, invalidação após escrita em Neon e ressincronização HTTP. Limpar apenas os dados sintéticos, tickets, storage de coordenação e sockets criados pelo teste; registrar contagens e IDs não secretos.

Só declarar a prova de transporte da Etapa 12 concluída quando esses critérios passarem. O handoff deve separar essa prova do gate pendente de navegador remoto e produção; não afirmar que o cutover ou todo o pareamento está pronto.

## Rollback e entregáveis

Desligar flags e restaurar somente a versão do named Preview se necessário; o polling existente permanece funcional. Encerrar conexões e limpar exclusivamente registros sintéticos identificados. Não apagar namespace/branch/bucket de forma ampla, não alterar schema de negócio, production, Coolify ou DNS. Uma migração destrutiva de classe DO não é um rollback trivial e exige avaliação específica antes de executar.

Entregar código e testes nos dois repositórios, configuração Preview isolada, contrato/inventário WS, matriz de emissores reais e handoff de evidências/limitações. Manter no handoff o aviso de consolidação: as funcionalidades de billing da PR 3 e as mudanças das PRs API 1/frontend 4 não chegam à main automaticamente por compartilhar este plano. A integração final continua uma decisão separada.

## Referências de implementação existente

- API: `src/worker/index.ts`, `app.ts`, `http.ts`, `environment.ts`, `parallel-preview.ts` e `route-contract.ts`.
- Autorização: `src/modules/auth/session-resolver.ts`, `src/lib/permissions.ts` e `src/modules/orders/service.ts`.
- Serviços de negócio: `src/modules/kitchen/service.ts`, `src/modules/table-sessions/service.ts` e caminhos de pagamentos/reconciliação existentes.
- Frontend: `src/lib/vapt-api-client.ts`, `order-client.ts`, `kitchen.ts`, `table-sessions.ts`, `env.ts`; cozinha, caixa, menu, drawer de pedidos e delivery citados acima.
- Estado de infra: `docs/infra-migration-phase-11-api-parallel.md` neste repositório e `docs/infra-migration-phase-4-neon.md` no repositório principal.
