# Etapa 13 — diagnóstico CPU em 07/10/2026

Status: **gate Workers Free não aprovado**. O diagnóstico inicial abaixo corresponde à versão `4a33769a-1958-484d-9dbc-bcca9d1b0048`, sem otimização naquela rodada. A primeira otimização limitada foi implantada depois, em produção ainda privada, na versão `d4940da2-d822-4943-92e2-8f64f95ed34c`, mantendo realtimefalse e Stripe Test; sua evidência está na continuação ao final. CI dos heads anteriores APIb2f7765/run37627330588 e frontendd7791eb/run37627339949: completed/success.

## Leitura controlada no Worker implantado

Doze GETs privados pelo service binding existente: três sequências health200, ready200, auth/me401 **sem Cookie** e catálogo de slug inexistente404. Mesmo IP TEST-NET, quatro segundos entre chamadas, rate limiter mantido. Não criou fixtures, contas, sessões, objetos, emails ou pagamentos. Readbacks confirmaram versão/ingress inalterados e transporte descartado.

Janela GraphQL `2026-10-07T13:24:00.346Z`–`2026-10-07T13:24:51.517Z`: leitura inicial mostrou cinco grupos; readback posterior retornou12grupos/12requests/0invocationErrors, cada grupo com um request e status success, limite1000 não atingido. Os timestamps Analytics antecedem os timestamps locais; a tabela correlaciona **pela ordem das 12 chamadas isoladas**, não por trace/request ID. Não presumir buckets de quatro segundos, sincronismo exato de relógios ou associação perfeita em janelas concorrentes.

| Sequência | Caminho correlacionado | Início local UTC | Grupo Analytics UTC | P50 = P99 CPU (ms) |
| --- | --- | --- | --- | ---: |
| 1 | /health | 13:24:01.346 | 13:24:00 | 1.191 |
| 1 | /health/ready | 13:24:06.070 | 13:24:04 | 7.184 |
| 1 | /auth/me, sem Cookie | 13:24:10.170 | 13:24:08 | 37.512 |
| 1 | catálogo ausente | 13:24:14.441 | 13:24:12 | 6.364 |
| 2 | /health | 13:24:18.614 | 13:24:16 | 0.496 |
| 2 | /health/ready | 13:24:22.694 | 13:24:20 | 1.307 |
| 2 | /auth/me, sem Cookie | 13:24:26.782 | 13:24:24 | 10.293 |
| 2 | catálogo ausente | 13:24:30.969 | 13:24:28 | 3.709 |
| 3 | /health | 13:24:35.088 | 13:24:33 | 0.476 |
| 3 | /health/ready | 13:24:39.181 | 13:24:37 | 1.204 |
| 3 | /auth/me, sem Cookie | 13:24:43.270 | 13:24:41 | 13.548 |
| 3 | catálogo ausente | 13:24:47.409 | 13:24:45 | 4.195 |

Unidade Analytics: microssegundos convertidos emms, conforme introspecção anterior. Não são máximos absolutos ou quantis globais. Não chamar a primeira sequência de cold start: não há prova de isolate novo. Os resultados localizam a investigação no caminho auth sem senha, mas não atribuem a amostra anterior120.784ms ao login. [Analytics usa amostragem/quantis](https://developers.cloudflare.com/workers/observability/metrics-and-analytics/); zero invocationErrors não substitui o [orçamento Free de10ms](https://developers.cloudflare.com/workers/platform/limits/).

## Evidência de código e bundle

Dry-run da configuração production:4484.87KiB/gzip765.05KiB, sem upload. Metafile selecionou `@better-auth/utils/dist/password.node.mjs`; bundle importa `scrypt` de `node:crypto`. Parâmetros existentesN16384/r16/p1 preservados. Isso elimina a hipótese de seleção do fallback JavaScript neste bundle, não prova que hashing cabe em10ms.

Inspeção do código instalado BetterAuth1.7.6:

- `requireWorkerAuth` obtém serviços request-local e acessa `services.authRuntime`.
- O getter constrói Better Auth para cada request autenticado. A biblioteca cria contexto e wrappers de endpoints, e inicia validação de schema SQL por adapter.
- O dispatcher aguarda a validação antes de executar getSession. Só então getSession sem cookie retorna null, sem consulta de sessão ou trabalho de senha. **Scrypt não explica esse caminho sem Cookie.**
- A validação de schema é cacheada por instância de adapter; reconstruir auth/adapter perde esse cache. Não desativamos essa validação.
- A composição também recria config/Pool e inicializa o signer S3 de R2 mesmo nos caminhos que não fazem upload.

Subagente Astra medium, autorizado pelo usuário para destravar, conferiu esses caminhos somente por leitura. Não encontrou uma opção pronta que tornasse a instância auth global mantendo dependências request-local: factory de adapter Better Auth e callback pool do Kysely são executados na inicialização, **não** em cada request. `better-auth/minimal` mantém a mesma criação de contexto/endpoints.

## Perfis exclusivamente locais

Bundle real executado em workerd local/Miniflare5 com configuração sintética, sem remote bindings. Com e sem R2:300health200+300ready200 por variante, nenhum fetch externo solicitado. Perfis localizaram parsing de config e, quando configurado, criação de S3Client. Tempos amostrados totais de ready584.366ms com R2 e581.187ms sem R2 incluem idle; contagens174/123amostras e resolução do profiler variam. **Não demonstram ganho material de R2 ou orçamento de produção.**

Auth no bundle real offline não pôde ser certificado: validação SQL contra `db.vapt.test` sintético falhou. O operador deixou de executar esse caminho, em vez de desligar validação. Nenhum banco real ou fixture foi usado.

Diagnóstico complementar: builder real `createBetterAuthOptions`, plugins/config sintéticos equivalentes e **memoryAdapter real da própria biblioteca**. Comparou300getSession sem Cookie com auth novo por chamada versus300com instância reutilizada em controle local. Todos401, nenhum fetch/email/background task. O perfil fresh teve306amostras/823.373ms totais, com `resolveDatabaseSchemaIndexes`, `getAuthTablesWithResolvedIndexes`, `createAuthContext`, `getBaseAdapter` e cálculo de entropia entre frames; controle100amostras/668.767ms. Esses totais incluem idle e não viram CPU/request, porcentagem de economia ou prova do runtime remoto. O controle **não é proposta de cache para produção**: exclui PostgreSQL, introspecção, protocolo e lifetime de pool/contexto. [Cloudflare documenta essas limitações do profiling local](https://developers.cloudflare.com/workers/observability/dev-tools/cpu-usage/).

Falhas de bootstrap do operador local (formato Miniflare5, saída multipart e import do wrapper memoryAdapter) foram corrigidas somente no scratch; perfis finais exit0 e runtimes descartados. Nenhum workerd permaneceu ativo ao final.

## Próximo passo e limites

Hipótese principal sustentada: inicialização repetida de auth/schema contribui para CPU; contribuição exata SQL versus contexto ainda não quantificada. Há oportunidades menores dentro do request: evitar inicialização do signer quando não necessário e parsing duplicado de config. Aplicar somente mudanças mínimas com testes RED/GREEN e nova medição no runtime alvo; não declarar que essas economias por si resolvem login/CPU Free.

Não usar cache global simples de auth/serviços/pool. Uma ponte de contexto por request exigiria design explícito, isolamento concorrente, ownership de cliente/transação, falha fora de contexto e lifetime de tarefas tardias; não foi implementada por inferência. Não reduzir hashing, cachear autorização/sessão revogável, trocar provedor, contratar Paid ou expor tráfego para encerrar o gate. Browser/CORS, provedores, imagem pública, recuperação/rollback e cutover continuam pendentes no handoff principal.

## Primeira otimização limitada — signer R2

Commit runtime `63390661fd9774ab0e1cc627857328928de8bfa4`: somente `r2-worker.ts` e seus três testes novos. Signer S3 inicializado no primeiro createUploadUrl, memoizado **por gateway**, sem compartilhamento entre requests/ambientes. Native delete continua no binding R2. Config, autorização, assinatura/constraints e força do hashing não mudaram.

Baseline488/488. RED: exclusão nativa tentou inicializar credenciais de upload; signer já estava inicializado antes de qualquer upload. GREEN:4/4 focados,491/491 API,19/19 workerd, build TypeScript e7/7 guard production + CLI. Testes exercitam o signer real, URLs distintas, TTL60s, Content-Length/Content-Type/host assinados e isolamento de credenciais preview/production. Uma expectativa inicial sobre path-style foi corrigida para o virtual-hosted efetivamente usado pelo SDK, **antes** de implementar a otimização. Revisão independente limitada ao diff/consumidores: nenhum Critical/Important/Minor; não substitui gates históricos ou CPU remoto.

Novo production dry-run4484.86KiB/gzip765.04KiB. Perfil complementar do bundle atualizado em workerd local:300health200+300ready200, zero fetch externo solicitado, runtime descartado; ready125amostras/622.438ms totais incluindo idle. Não comparar esse total bruto com a rodada anterior como percentual de economia ou latência de produção.

Implantação exclusivamente privada com keep-vars, sem arquivo de secrets ou upload de credenciais: versão `d4940da2-d822-4943-92e2-8f64f95ed34c`, startup77ms, sem targets públicos. O aviso Wrangler de diferença de metadados R2/DO foi seguido por GET/readback: mesmo namespace SQLite `d3ad7a4008c64124b765f934986956da`, Hyperdrive production e bucket production, oito secret_text por nome, workers.dev/Preview URLsfalse, zero custom domains/Cron, R2 públicofalse, realtimefalse, Stripe Test, observabilitynull. Não criou namespace, token, assinatura paga, tráfego público ou provider event. Rollback técnico disponível para a versão anterior4a33769a, mas **não** foi ensaiado nem certificado nesta rodada.

Nova medição privada:12GETs com os mesmos caminhos/IP/intervalos/Referer e sem Cookie, fixtures ou provedores, status200/200/401/404 em três sequências. Pre/post mesma versão e ingressfalse; exit0/transportDisposedtrue. Janela `2026-10-07T13:51:18.201Z`–`2026-10-07T13:52:12.766Z`. Primeira leitura Analytics parcial:4grupos/4requests/0invocationErrors, CPU5.756/2.318/**48.423**/5.618ms, grupos UTC13:51:20/25/29/33. São grupos amostrados; a associação por ordem aos primeiros health/ready/auth/catalog é uma correlação, não trace individual. Não tratar a cobertura parcial como prova de requisições warm ou de toda a janela.

Conclusão: trabalho desnecessário do signer removido estruturalmente e sem regressão local, mas há CPU acima do limite mesmo após essa mudança. **Gate Free continua não aprovado**; ainda falta orçamento no caminho auth/contexto/SQL e em login real, além dos gates browser/provedores/imagens/recuperação. Não reduzir segurança, esconder métricas com cache de sessão ou contratar Paid para fechar esse gate.
