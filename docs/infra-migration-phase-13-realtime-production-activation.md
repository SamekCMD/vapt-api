# Etapa 13 — ativação guardada de realtime production

## Estado em 09/10/2026

Operador implementado; **primeira ativação controlada foi revertida após falha de admissão**. API `3fd2b685-02b7-4448-ab22-dff291b359db` ficou ligada com frontend desligado para o smoke. Os dois logins reais/identidade/cookies passaram, mas a fase de proof falhou antes de pedidos ou conexões admitidas. Cleanup confirmou zero resíduos nas12 tabelas e encerrou recursos locais. Rollback guardado publicou API `efd7a60e-68ce-4eda-bed7-bec699423edf`; readback confirmou realtime false, CPU1000, seis rates/oito nomes/mesmos recursos/ingress/Cron0/StripeTest/R2 privado e frontend `28c56520-dcaf-4aeb-8d24-8258fbd0e124` inalterado. CI API `aaf4ba5` e frontend `5730e2b` passaram em push e PR. Nenhuma mudança de main, DNS, recursos, secrets, cobrança, Stripe Live ou leitura pública de R2.

Diagnóstico ainda aberto: o transporte sem credencial à rota desligada recebeu503JSON esperado. A fase agregada não distinguia proof forjada/transplantada/abertura; instrumentação agora separa essas fronteiras e registra somente status numérico ou categoria fixa, nunca ticket/header/body/erro bruto. Nenhuma proteção foi relaxada. Próximo é reprodução mínima via um pedido normal público/grant order, com manifesto próprio/cleanup/rollback, antes de retomar o smoke completo owner/order. Não declarar WebSocket production aprovado nem ativar o frontend.

## Caminhos explícitos e rollback

O comando API `npm run deploy:worker-production-realtime` valida `wrangler.worker-production-realtime.jsonc` e publica com keep-vars no Worker existente. A configuração difere da pública desligada **somente** por `REALTIME_ENABLED: "true"`. O novo checker exige esse valor e normaliza apenas essa flag para reaplicar o guard público original inteiro: conta/domínio, CPU1000, HD/R2 production, namespace próprio, migrations não destrutivas, seis limiters, CORS/auth exatos, Stripe Test, sem secrets em vars, Cron ou entradas extras. Os guards privado e público originais continuam rejeitando realtime ligado. Validação estática não confirma ACL remota nem limita a fatura total.

No frontend, `npm run deploy:production-realtime` faz build isolado, verifica o artefato e publica keep-vars em `vapt-web`. Usa `wrangler.production-realtime.jsonc`, o mesmo domínio e `dist-production-realtime`; o build fixa realtime ligado somente por modo explícito, ignorando VITE/arquivos de ambiente não autorizados. API/origins, CAPTCHA, payments sandbox e imagens disabled permanecem. O comando normal `npm run deploy:production` mantém realtime desligado e `dist-production`.

Ambos os builds geram `deployment-proof.json` com versão1, boolean realtime e SHA256 de index+todos os JS. A verificação exige modo e bytes correspondentes; detecta cópia acidental de artefato desligado/stale. Não é assinatura nem proteção contra alguém capaz de alterar código/prova. O arquivo não contém credenciais. Artefato desligado `949df49dba77c42d5b8bc76588b2c721df313cb1f08f22c1f507a1526bde49fa`; ligado `375dc00c982c8bb52236fc65c95d38daba511ff92d9b6e086f4eb013ccb19750`.

Rollback operacional usa os comandos normais de produção (frontend desligado antes da API) e readback do par; não apaga namespace, não roda migration destrutiva, não libera tickets unsigned. Preservar secrets/HD/R2/DO/limites e polling. Histórico de versão só é alternativa após confirmar compatibilidade do par.

## Evidências desta preparação

- RED observado: quatro assertions API por ausência do guard; quatro frontend por flag/config/build/CLI e uma por falta de prova de artefato. O primeiro spawnEPERM do sandbox não foi contado como RED.
- GREEN:17 testes de guards API (incluindo13 existentes),15 frontend (incluindo10 existentes); configuração API ligada tem comparação exata com a desligada, salvo flag. Rejeitam alargamentos e erros sem refletir valores sensíveis.
- Suítes completas API550/550, workerd22/22, frontend177/177 e auth-retention1/1 passaram. TypeScript e bundles API dos dois modos passaram,4495.87KiB/gzip767.88. Builds/verify frontend dos dois modos passaram; dry-run dos dois pacotes não publica. CI foi ampliado para testar e empacotar os caminhos ligados, sem deploy automático.

## Próximo gate, antes de ativar o frontend

O operador production separado está implementado em `scripts/verify-realtime-production.mjs`, com fixture driver `scripts/realtime-production-fixtures.mjs` e readback puro `scripts/production-runtime-readback.mjs`. Dezoito testes locais cobrem alvos/headers/cookies/protocolos, prova MAC forjada/transplantada/replay, ciclo de duas contas/quatro pedidos, limpeza transacional e limites remotos. Os doubles externos não comprovam WebSocket ou cleanup remoto. Preview permanece inalterado e Preview-only.

O chamador deve fornecer manifesto público de recuperação (duas identidades novas, sem senha), CAPTCHA humano real por login e transporte somente para API/origin production exatos. A primeira resposta humana precede o seed e a ativação; dois desafios adicionais são necessários. Cookie Secure/HttpOnly/Lax e identidade são conferidos pelo login normal. O socket da sessão antiga é renovado **após** o terceiro desafio e antes do logout: expiração enquanto o humano espera não pode contar como revogação. A limpeza valida primeiro todas as identidades, exclui somente UUID+owner/name/slug/email próprios e exige zero resíduos em12 tabelas antes de COMMIT. Falha exige recuperar exclusivamente o manifesto e rollback, não ampliar DELETE.

Readback exige versões explícitas a100%, modo disabled/enabled explícito, CPU1000, seis rates com os namespaces/limites originais, oito nomes de secrets, HD/R2/DO próprios, Cron0, StripeTest, R2 privado e somente os dois domínios existentes. O verificador desligado original não foi alterado. Tela local one-shot distingue este teste na API pública de produção de antigos testes privados e do billing; valores de desafio, senha, cookie e tickets nunca são registrados.

Preparar operador production separado, com alvo exato `https://api.vapt.app.br`/origin `https://vapt.app.br`, fixtures sintéticas próprias, CAPTCHA real por humano, credenciais/tickets somente em memória e cleanup limitado aos IDs criados. O operador Preview continua Preview-only e não deve ser retargetado; Preview antigo ainda precisa atualização coordenada para usar o envelope assinado.

Sequência: readback estrito do par desligado; ativação explícita da API com frontend ainda desligado; readback esperado realtime ligado mantendo todos os outros controles; ensaio owner/order/isolamento entre restaurantes e pedidos, reconexão, logout/revogação, single-use e rejeição de proof falsa; cleanup e readback. Só então publicar frontend ligado e provar integração por fluxo normal do navegador. Falha de smoke/readback pede rollback para flags desligadas, não relaxamento de autenticação.

Ticket assinado continua sendo pré-admissão ligada à sala; o DO mantém consumo único, grants/revogação, lease/heartbeat/caps. Não declarar WebSocket remoto aprovado, quota global, teto financeiro, cutover, aposentadoria Coolify/Hetzner ou Etapa13 completa apenas por estes testes locais.
