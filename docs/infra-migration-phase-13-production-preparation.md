# Etapa 13 — preparação da API production

## Status em 07/10/2026

**Continuação mais recente — recuperação de código:** CI dos heads API `434948c` (runs37672002895/37671994721) e frontend `478d558` (37672015303/37672009816) completed/success. Ensaio privado `ba363c7c→799b78a0→ba363c7c` passou: rollback explícito a100%, strictGET dos bindings/flags e health200/ready200/catálogo ausente404 com SELECT real em ambas as versões. Restauração obrigatória emfinally via versions deploy; estado final `ba363c7c-3355-4849-b71f-c615bc3344db` a100%, API/R2 públicosfalse, realtimefalse, StripeTest, oito nomes de secrets e mesmo HD/R2/DO. Após restaurar, oito controles authbody passaram novamente, incluindo três413, CAPTCHA400, GETsessionnull e logoutJSON200/3cookies; transportes encerrados, zero fixtures criadas. Nenhuma alteração de dados/schema/grants/secrets/DNS/main/Paid. Este ensaio certifica somente esse par de código compatível; não backup/restore SQL, objetos ou lifecycle deDO. [Rollback não reverte os recursos conectados](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/).

**Próximo controle antiabuso — SQL:** inspeção READ ONLY na branch production existente confirmou ausência de overrides dos quatro deadlines selecionados em `pg_db_role_setting` para a role API/banco. Não prova defaults globais nem settings efetivos via Hyperdrive. Driver/recursos preservados; nenhuma mudança de timeout aplicada. Detalhes, risco de query_timeout sem cancelamento e critérios de verificação em `docs/infra-migration-phase-13-abuse-cost-readiness.md`. Browser/CORS/cookies reais, provedores/imagens públicas, proteção de custo e recuperação ampla permanecem gates da Etapa13; não reabrir Free10ms como bloqueio permanente.

**Diretriz supersedente do usuário:** Workers Paid é o destino planejado da API para substituir Hetzner; não perseguir custo zero nem exigir<=10ms como condição permanente. Regras11–13/seção5 do plano já preveem essa transição. Leituras Free abaixo permanecem históricas, não certificam nem impedem por si production Paid. Próximo gate de consumo é proteção contra abuso/readiness do plano escolhido; ativação Paid continua etapa financeira explícita. Nenhuma assinatura/main/DNS/entrada pública ativada. MínimoUS$5 por conta não é teto; risco e próximos controles em `docs/infra-migration-phase-13-abuse-cost-readiness.md`.

Estado após o guard: guardPOSTauth1MiB antes de serviços, runtime2f76670+96bda74 e versão privada `ba363c7c-3355-4849-b71f-c615bc3344db`. Suíte final524/524/workerd21/21/build/bundle; revisão focada achou1Important deContent-Type/logout, corrigido RED→GREEN com Better Auth real, sem re-review/Minors. Oito controles remotos passaram sem fixtures/provedores, pré/pós mesmos recursos/secrets/flags e transporte encerrado. Nenhuma nova certificaçãoCPU/budget/Paid/browser/concorrência/recuperação ampla. Evidência e limitação doPOSTvazio no transporte constam no handoff antiabuso, sem relaxar parser. Seções seguintes799b78a0 são histórico do gate anterior; ensaio do novo par está registrado acima.

Última continuação: engine request-scoped (`36d76df`/`e9aa582`) implantado na versão production **privada** `799b78a0-a585-413d-9cfa-06fa4e14119d`, somente código com keep-vars. GETs antes/depois preservaram oito secrets por nome e bindings/flags privados. Sem entrada pública/main/DNS/Paid/grant/secret alterada. Registros posteriores “sem deploy nesta rodada” descrevem o experimento local anterior.

Verificação fresca:26/26 focados, GC1/1, fixture workerd1/1, TypeScript, guard7/7+CLI e bundle4490.24KiB/gzip766.39KiB. Quinze probes negativos passaram; CPU ainda acima do Free (Cookie não relacionado94.680ms, sem Cookie até15.005ms, associação por ordem sem trace/cold-warm). Não há economia/capacidade certificada; janelas/unidades em `docs/infra-migration-phase-13-cpu-diagnosis.md`.

Gate positivo repetido após mudança de auth:13checks com Turnstile humano real, schema/transporte PostgreSQL-Hyperdrive, login/sessão, isolamento owner, CRUD/menu/cozinha/caixa, R2 e revogação. Chamadas sequenciais separadas funcionaram; concorrência remota não certificada. Mesmo escopo sintético, zero resíduos em12tabelas e objetos, exit0/transporte/pool encerrados; sem email/pagamento. Browser/CORS/cookies entre domínios, provedores, imagens públicas, CPU/login Free, concorrência e recuperação ampla continuam gates. Rollback histórico não certifica799b78a0→db882acc. CI anterior API72dec1d/run37636586532 e frontend83b1b5a/run37636582938 passou, não certifica novos commits ainda não enviados.

API production implantada sem entradas públicas, com oito secrets, CORS R2 e webhook Stripe Test próprio desativado. ACL SQL e 11 checks públicos privados passaram; uma rodada adicional aprovou 13 checks de login real/owner/CRUD/R2/logout, com limpeza verificada de zero resíduos em 12 tabelas e nos objetos sintéticos. Rollback de código compatível e restauração foram ensaiados. Cutover ainda pendente: pareamento browser/CORS, exposição deliberada das imagens, entregas/ciclo de provedores, CPU Free e recuperação ampla precisam dos próximos gates. Main, DNS, plano pago e Access de produção não foram alterados. O runtime da Etapa12 é reutilizado, sem uma segunda implementação da API.

As seções seguintes até “Avanço remoto” preservam a evidência histórica da preparação local no commit91c84d0, anterior à implantação. Referências a Worker/DO inexistentes e secrets ausentes descrevem aquele preflight, não o estado atual.

## Recursos e isolamento

Readback somente GET na conta Cloudflare `3ce69408aa5112617a282957aba71932`, com OAuth capturado em memória, sem imprimir credenciais:

- Hyperdrive production existente: `2885c609a66641b3b716190c2d467902`, `vapt-api-neon-production`, role `vapt_api_production`, banco `vapt`, host `ep-holy-wildflower-b6vtv1dd.c-2.sa-east-1.aws.neon.tech`; caching desabilitado. Este readback confirma configuração, não recertifica ACL SQL nem conectividade real.
- Bucket `vapt-assets-production`: domínio gerenciado `pub-a1c726374f434a7d8c2e2324d61a4de7.r2.dev`, **enabled:false**. O endereço é reservado na configuração, mas leitura pública de imagens não está pronta. Nenhuma publicação do bucket foi feita; escolher/validar sua exposição em gate próprio.
- Namespace DO existente somente do Preview `stage11-inert`. Produção usa binding local `RestaurantRealtime`, sem `script_name` nem ID compartilhado, migration SQLite própria `stage13-realtime-production-sqlite-v1`. O namespace production será criado somente em eventual implantação futura, não neste dry-run.
- GET de custom domains Workers não retornou mapeamento `vapt.app.br`. Não é auditoria DNS nem prova de indisponibilidade do frontend. Nenhum registro foi alterado.

`wrangler.worker-production.jsonc` mantém `workers_dev:false`, `preview_urls:false`, `routes:[]`, `REALTIME_ENABLED:false` e `STRIPE_ENVIRONMENT:test`. Sem Cron, Queue, configuração paga ou secrets. Namespaces de rate limit próprios `13011`–`13016`, limites20/60/30/30/300/120 por60s. Os IDs públicos do catálogo Stripe de teste são reaproveitados, não credenciais; existência/origem remota do catálogo não foi verificada novamente nesta rodada.

Origens alvo: frontend `https://vapt.app.br`, API/Better Auth `https://api.vapt.app.br`. São valores de preparação, não uma afirmação de cookies/domínios já operacionais. O facade exporta a classe DO e o fetch/scheduled existente; a ausência de triggers não ativa o scheduled. Sem a configuração secreta completa o fetch retorna503.

## Secrets e próximos gates

Nenhum secret foi criado/copied de Preview/billing. Para futura instalação, os nomes necessários à configuração atual são `STRIPE_SECRET_KEY` (test), `STRIPE_WEBHOOK_SECRET` do endpoint próprio, `PUBLIC_ORDER_TOKEN_SECRET`, `BETTER_AUTH_SECRET`, `TURNSTILE_SECRET_KEY`, `RESEND_API_KEY`, `R2_ACCESS_KEY_ID` e `R2_SECRET_ACCESS_KEY`. Valores devem entrar somente via canal write-only, fora de Git/logs. `DATABASE_URL` vem do binding Hyperdrive, não de variável/secret duplicado. Resend de autenticação é independente do consumer billing; credencial e escopo devem ser verificados para produção, não copiados por conveniência.

Mercado Pago permanece opcional e não habilitado nesta configuração; isto não certifica paridade desse fluxo. Preservar seus gates próprios. Antes de tráfego real: verificar ACL/conectividade production, instalar secrets com isolamento, testar pareamento real/Turnstile/cookies, endpoint Stripe de teste e ciclo de pagamento, R2 upload/leitura/delete, observabilidade/CPU, recuperação HTTP e rollback. Nenhum desses testes remotos foi atribuído ao dry-run.

Não ampliar Access para usuários de produção nem depender de Zero Trust pago. O Access existente do Preview não foi modificado. Não ativar Stripe Live ou upgrade de plano por inferência.

## Evidência local

- Guard implementado com RED observado (7 falhas antes da implementação), depois7/7 GREEN. Rejeita recursos Preview, secrets em vars, novas origens/ingress, triggers, settings pagos, DO compartilhado/destrutivo, realtime ligado e Stripe Live. CLI falha sem refletir entradas sensíveis.
- Verificadores locais selecionados (parallel config/flows, realtime config/driver, production config):34/34, nenhum skip. São testes sintéticos locais; não executaram drivers remotos.
- API488/488, workerd19/19; build TypeScript passou. Runtime de negócio não modificado.
- Wrangler4.138.0 production dry-run passou:4484.87KiB/gzip765.05KiB; bindings production/R2/local DO/rates corretos no bundle. Nenhum deploy.
- CI YAML analisado; dois novos steps executam guard/testes e production dry-run, sem credenciais ou publish. CI de consolidação anterior: API run37541826207 no headba067ce e frontend run37541828898 no headb16a27b passaram (verify e billing_email). Isso não certifica o novo commit ainda não enviado.
- Revisão independente focada nos quatro arquivos configuração/guard/testes/CI: nenhum Critical, Important ou Minor; aceita integração da preparação. Reviewer executou seis testes in-process e CLI direta; sandbox dele bloqueou spawn do sétimo caso, que passou7/7 na execução do implementador. Não rerodou API/workerd/build. Todos os itens declinados (ACL/resolução remota, Worker/DO inexistentes, R2 público, secrets, origem Stripe, CPU/custo Free e semântica realtime/billing inalterada) permanecem registrados acima como gates separados ou evidência anterior, sem nova certificação.

## Limites e rollback

Documentação Cloudflare consultada em06/10/2026: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) informa10ms CPU por requisição HTTP no Free,64MiB de código descomprimido e100.000 requisições/dia. O bundle cabe no limite de tamanho; isso **não prova** CPU de auth/pagamentos, startup, memória ou custo zero. Medir caminho real antes do cutover; se Free não atender, comunicar o limite e buscar alternativa dentro do orçamento, sem comprar plano automaticamente.

[Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) permite SQLite no Free com quotas; esgotamento pode interromper operações. Não equivale a garantia de disponibilidade/custo. Não houve upgrade.

Rollback desta preparação: reverter somente estes arquivos/steps na feature branch, sem tocar main ou recursos remotos. Após uma implantação futura, preferir versão anterior/flags/rotas sem apagar namespace ou executar migration destrutiva como rollback trivial. Realtime permanece off e polling existente preservado. Cutover público, integração main e aposentadoria Coolify/Hetzner seguem pendentes.

## Avanço remoto em 06/10/2026 — implantação sem exposição

- Deploy do código91c84d0 com Wrangler4.138.0 e configuração production passou:4484.87KiB/gzip765.05KiB, startup113ms e “No targets deployed”. Isso comprova upload/implantação, não requisições funcionais ou CPU por caminho de negócio. Versão inicial `a9b50f42-689f-46f8-9433-01a2cc7c5ee2`.
- Namespace SQLite próprio criado: `d3ad7a4008c64124b765f934986956da`, `vapt-api-production_RestaurantRealtime`; distinto do Preview69fbe1f54ad64a93b7cb761910da094a. Binding Hyperdrive production2885c609a66641b3b716190c2d467902 e bucketvapt-assets-production confirmados por GET. Flags realtimefalse e Stripe test preservadas.
- `BETTER_AUTH_SECRET` e `PUBLIC_ORDER_TOKEN_SECRET`: gerados independentemente com48bytes aleatórios cada e instalados por stdin write-only, sem arquivos de valores, Git ou logs. Não copiados de Preview.
- `RESEND_API_KEY`: chave própria `vapt-api-production-auth-2026-10-06`, Sending access restrito a `vapt.app.br`. Criação/instalação aprovadas explicitamente; usuário transferiu o valor da tela única Resend ao campo Secret production da Cloudflare, Previews desmarcado. UI confirmou “Value encrypted”; GET confirmou somente o nome/tipo. Nenhum email enviado nesta rodada. Não reutilizada em billing/Preview.
- `TURNSTILE_SECRET_KEY`: secret do widget existente `0x4AAAAAAEhvIktjmb6yaq09`, que já inclui `vapt.app.br`, recuperado em memória e instalado por stdin somente em production. Widget/domínios não alterados, secret não rotacionado. É reutilização deliberada do mesmo widget frontend/backend, não cópia de binding Preview; validação real do desafio permanece pendente.
- CORS versionado `infra/cloudflare/r2-cors-production.json` aplicado somente emvapt-assets-production e confirmado por GET200: PUT, Content-Type/Content-Length, origensvapt.app.br/dashboard.vapt.app.br, ETag,3600s. CORS não autoriza uploads sem assinatura nem torna o bucket público. Credenciais S3 ainda ausentes.
- Readback final: quatro bindings secret_text acima; deployment `305e7828-d26f-40fd-9bb1-04d451892f83`, versão `7cdfa081-d782-4d05-a5d1-55864bbe6511` a100%; workers.dev=false, previews_enabled=false, schedules0, custom domains Workers[] e R2[]. Domínio R2 gerenciado continua enabled:false. Nenhuma rota/DNS/Cron/Queue/Access/upgrade foi ativado.
- Catálogo Stripe conferido por GET usando credencial Test local somente em memória: três prices e portal da configuração retornaram200, active:true, livemode:false; preços BRL/mês. Esse inventário não instalou a chave, não criou webhook nem realizou pagamento.
- CI da configuração91c84d0: API run37543814966 aprovado. Frontendd74d507: run37544183319 aprovado, verify e billing_email, após correção limitada à espera do prato no teste público. Não atribuir esses resultados ao novo commit documental.

Os quatro secrets R2/Stripe ainda ausentes nesse primeiro readback foram instalados na continuação abaixo. Não atribuir a primeira prova de quatro secrets ao estado final.

Rollback operacional: manter ingress/realtime desligados; escolher uma versão anterior quando necessário, preservando secrets válidos e o namespace SQLite. Não apagar namespace/objetos ou executar migration destrutiva. Reverter somente documentação não desfaz recursos remotos.

## Continuação — secrets completos e primeira prova interna

- Token R2 Account `vapt-api-production-r2-2026-10-06` criado após aprovação específica: Object Read & Write somente em `vapt-assets-production`, até revogação, sem administração de buckets. As chaves S3 foram transferidas em memória para `R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY`, Secret production, Previews desmarcado; UI “Value encrypted” e GET secret_text confirmados. Token preview preservado, tela única encerrada, valores descartados. Sem objetos escritos/apagados ou bucket público.
- `STRIPE_SECRET_KEY`: chave Test local já existente do mesmo catálogo Stripe, revalidada pelos três prices active/livemodefalse, instalada por stdin write-only em production. Reuso deliberado da conta Stripe Test/catalogo, não recuperação de secret do Worker Preview nem troca por Stripe Live. Nenhum Customer/Checkout/pagamento criado.
- Inventário Stripe Test confirmou endpoints[] antes da criação. Endpoint próprio `we_1UNjPKQYNWCekS7FvWV2SZuo`, URL final `https://api.vapt.app.br/webhooks/stripe`, api_version `2026-08-26.dahlia`, livemode:false, **status:disabled**. Escuta somente checkout.session.completed/expired, invoice.paid/payment_failed e customer.subscription.updated/deleted, iguais aos eventos tratados pelo código. Secret emitido pelo provedor instalado em `STRIPE_WEBHOOK_SECRET`, não um valor sintético.
- Preparação do endpoint: criação com URL do próprio Worker workers.dev já desabilitado; desativação confirmada antes de atribuir a URL final. Não houve entrega ao Coolify, alteração DNS/ingress ou teste de entrega. O endpoint permanece desativado até gate de ativação. [Stripe documenta criação com secret e atualização com disabled.](https://docs.stripe.com/api/webhook_endpoints/update)
- Readback final confirmou oito secret_text, sem valores. Versão após Stripe `4a33769a-1958-484d-9dbc-bcca9d1b0048`; workers.dev e Preview URLs false, realtimefalse e Stripe test preservados.
- Prova autenticada pelo remote service binding Wrangler4.138.0/getPlatformProxy, sem publicar proxy ou adicionar Access production: `/health`200/ok e `/health/ready`200/ready; snapshot paymentEffects pending/lastRunAt/lastError null. Transporte temporário descartado com dispose confirmado. [Remote service bindings são suportados no desenvolvimento local.](https://developers.cloudflare.com/workers/local-development/)
- Leitura única de catálogo para slug sintético inexistente: primeira tentativa sem CF-Connecting-IP recebeu429 antes do banco, conforme guard de ingresso e testes existentes. Depuração rastreou a ausência do header no operador interno; nenhuma alteração no runtime. Repetição com IP TEST-NET203.0.113.13 pelo transporte autenticado recebeu404/not_found e x-ratelimit-limit presente. O caminho inspecionado executa SELECT parametrizado empublic.restaurants antes de not_found: prova limitada de conexão Hyperdrive/Neon e leitura com roleproduction, não ACL completa, publicação de catálogo ou limite por IP na borda pública. Nenhuma fixture ou grant criado.
- Handoffs anteriores API2f8a84d/frontend e5234e4 enviados às branches existentes: CI37555280420/37555269039 concluídos success. Os registros anteriores de CI pendente são históricos; este resultado não certifica commits documentais posteriores.

Pendentes antes do cutover: auth/browser/cookies/Turnstile real, CRUD/isolamento com fixtures sintéticas e cleanup, R2 upload/leitura/delete e exposição deliberada das imagens, origem/entrega Stripe e ciclo completo de pagamento Test, ACL completa e orçamento CPU Free/recuperação/rollback. Saúde HTTP e uma leitura SQL não certificam esses fluxos. A API continua sem tráfego público, webhook Test desativado e Etapa13 incompleta. Nenhum upgrade, Stripe Live, main ou aposentadoria do legado nesta rodada.

## Gate privado funcional em 07/10/2026

CI dos handoffs anteriores confirmado: API head66aba971/run37556456162 e frontend head253f313d/run37556459318, ambos completed/success. Não atribuir esse CI às alterações documentais desta rodada.

Operador local restrito à branch Neon production `br-odd-term-b6j2n9ms`, host direto `ep-holy-wildflower-b6vtv1dd.c-2.sa-east-1.aws.neon.tech`, databasevapt/roleneondb_owner. Credenciais capturadas do CLI autenticado somente em memória. `infra/neon/verify-worker-production-role.sql` passou no estado atual: atributos, membership, ownership e allowlist de privilégios da role `vapt_api_production` verificados sem novos grants. Owner foi usado apenas no bootstrap/limpeza e leitura de controle; os requests de negócio atravessaram o binding privado do Worker implantado e seu Hyperdrive production, sem executar o serviço localmente.

Onze checks aprovados:

- ACL SQL atual de production.
- Rota de proprietário sem sessão:401/unauthorized.
- Login sem CAPTCHA:400/MISSING_RESPONSE; proteção mantida, **não** prova de login real.
- Dois catálogos200, cada um contendo somente seu restaurante/item sintético.
- Dois POSTs concorrentes com a mesma chave:201 e200, mesmo pedido/token, sem duplicação.
- Token de cada pedido lê somente seu pedido; uso no pedido do outro tenant:404/not_found.
- Reuso de chave com quantidade diferente:409/idempotency_conflict.
- Item do segundo restaurante no pedido do primeiro:400/invalid_request.
- Solicitação de conta na sessão do outro restaurante:404/table_session_not_found.
- Solicitação de conta nas duas sessões corretas:200/check_requested.
- Controle SQL final: dois pedidos, duas sessões check_requested e zero payment_effect_outbox para as fixtures.

Bootstrap com UUIDs/slug/email `stage13-4cf06604-71e4-4b2b-9598-469e070d6b40` e domínio sintético `example.invalid`; sem contas credential, sessões artificiais, emails, Checkout ou chamadas a provedores. Limpeza em finally limitada aos IDs exatos + owner/name/slug/email, com cascades e conferência de zero linhas em restaurants, orders, order_items, menu_items, menu_item_variations, table_sessions, order_feedback, payment_transactions, payment_effect_outbox e user/session/account de Better Auth. Transporte descartado; pool encerrado. O consumo eventual da sequência de display IDs pelos pedidos de teste não foi revertido.

Diagnóstico do operador, sem mudança na aplicação: `Origin:https://vapt.app.br` recebe403/text/plain antes da API no transporte remoto; matriz confirmou health200 e rota owner401 sem Origin, versus403 em ambas com Origin. CORS_ORIGINS remoto contém exatamentevapt.app.br; o handler inspecionado não produz esse403. Teste servidor-a-servidor omite Origin, não desativa CORS/CSRF nem certifica navegador/origem. O parser operacional foi corrigido para ler o JSON do middleware CAPTCHA mesmo sem application/json. Falhas anteriores ocorreram antes do bootstrap; uma execução intermediária não iniciou porque o serviço de aprovação estava em limite, sem contorno da revisão.

Readbacks anterior/posterior confirmaram workers.dev/Preview URLsfalse, nenhum custom domain para o serviço, Hyperdrive production esperado, realtimefalse e Stripe test. Não houve deploy, alteração de secret, DNS, grants, plano ou runtime nesta rodada. Nenhum endpoint público novo.

Gates restantes: login positivo com Turnstile real, cookies/CSRF e pareamento browser; CRUD autenticado/menu/cozinha/caixa e isolamento de proprietário; R2 presigned upload/read/delete e exposição das imagens; entrega Stripe/ciclo Test; CPU Free, observabilidade, recuperação e ensaio de rollback antes do cutover. O isolamento público/cleanup e a ACL verificados acima deixam de ser pendências desta rodada, mas não substituem autorização autenticada nem o restante da Etapa13.

## Gate privado autenticado e R2 em 07/10/2026

CI anterior API857ec248/run37622624174 e frontend7e137115/run37622622487 confirmado success. Mesma versão production4a33769a-1958-484d-9dbc-bcca9d1b0048, sem novo deploy. Operador servidor-a-servidor pelo binding privado, com credenciais somente em memória, uma conta credential sintética bootstrapada e sessão emitida pelo login real — nenhuma sessão artificial, troca de secret CAPTCHA ou proteção desativada. Usuário concluiu o Turnstile do widget existente em página local127.0.0.1; desafio usado uma vez. Os 13 checks aprovados:

- Login Better Auth com desafio real:200; cookie `__Secure-better-auth.session_token` com Secure/HttpOnly/SameSite=Lax, sem valor em logs.
- Resolução `/auth/me`:200 com proprietário correto; restaurante GET/PATCH200 e acesso ao restaurante estrangeiro403/forbidden.
- Cardápio próprio: listagem200, criação201, alteração200 e exclusão204; identidade/vínculo/preço conferidos.
- Presign para item de outro proprietário:403/forbidden. Presign próprio200, chave/bucket/URL/método e validade60s conferidos.
- PUT adulterando chave, Content-Type ou Content-Length:403 nos três casos; PUT correto do PNG sintético:200.
- Leitura privada pelo binding R2: conteúdo e metadados exatos; DELETE pela API:204 e objeto ausente. URL assinada expirada:403 e objeto continuou ausente.
- Dois pedidos sintéticos201; cozinha lista só pedido próprio, altera status200 e rejeita pedido estrangeiro404/order_not_found.
- Caixa: solicitação de conta200, listagem/detalhe próprios200, sessão estrangeira404/table_session_not_found e transferência200.
- Logout Better Auth200; reuso do cookie anterior em `/auth/me`:401/unauthorized, comprovando revogação.

Primeira tentativa de login desta rodada recebeu403/MISSING_OR_NULL_ORIGIN: operador não enviava Referer antes de obter sessão. Cleanup confirmou zero linhas/objetos e transporte foi descartado. Fonte Better Auth inspecionada, corrigido apenas o contexto legítimo do operador (`Referer:https://vapt.app.br/` em todas as requisições); novo desafio humano foi usado no teste final. O header Origin continua indisponível nesse transporte, portanto **não** certifica CORS/pareamento/cookies reais entre browser e domínios de produção. Proteções de aplicação/trustedOrigins permaneceram intactas.

Fixtures exatas do operador `stage13-auth-e3d0db73-ef30-4885-9b35-9d53949aa7ec`: bootstrap owner apenas para controle/limpeza; requisições de negócio no Worker e role limitada/Hyperdrive production. Cleanup final limitado aos UUIDs+owner/name/slug/email e dois prefixos UUID R2; zero resíduos nas mesmas12tabelas e zero objetos conferidos. Cookie/senha/desafio/URLs assinadas descartados, transporte e pool encerrados, helper exit0. Sem email, Stripe Checkout/evento, alteração de grants, secret, DNS, main ou plano pago. Consumo de sequência de display IDs não revertido.

Readbacks antes/depois: workers.dev/Preview URLsfalse, nenhum custom domain, Hyperdrive production próprio, realtimefalse, Stripe test e leitura pública R2false. Esta rodada certifica auth/owner/CRUD e operações R2 privadas, não leitura pública de imagens, entrega Stripe/Resend, ciclo de pagamento Test, browser/CORS, CPU Free, observabilidade ou recuperação/rollback. Esses são os gates restantes antes do cutover; Etapa13 permanece incompleta, sem ativação pública/Stripe Live/Access production ou aposentadoria Coolify/Hetzner.

## CPU/observabilidade — alerta medido em07/10/2026

CI dos handoffs anteriores APIbafc649/run37625756392 e frontend08d09e4/run37625770495 confirmado completed/success. Consulta somente leitura com OAuth existente: settings/subdomain da APIproduction e GraphQL Analytics, sem chamar endpoints de negócio, criar token, habilitar logs ou alterar recursos. `observability:null` no settings; workers.dev/Preview URLsfalse. Leitura API de assinaturas recebeu403/10000; consulta GraphQL independente funcionou, sem ampliar escopos. Painel Workers plans confirmou **Free / Current plan / $0**, não upgrade nem promessa de fatura zero para todos os outros produtos.

Janela GraphQL `2026-10-07T00:00:00.000Z`–`2026-10-07T13:10:55.829Z`: filtro exclusivo `scriptName:vapt-api-production`,19grupos retornados, soma52requests/0invocationErrors, todos os grupos status success; limite1000 não atingido. “Success” é outcome de execução, não afirmação de HTTP200 em testes negativos. Introspecção oficial de `AccountWorkersInvocationsAdaptiveQuantiles` confirmou cpuTimeP50/cpuTimeP99 em **microssegundos**. Exemplos no intervalo da rodada autenticada (UTC; São Paulo UTC−3):

| Grupo UTC | Requests | P50 CPU (ms) | P99 CPU (ms) |
| --- | ---: | ---: | ---: |
| 13:00:54 | 1 | 11.390 | 11.390 |
| 13:01:26 | 6 | 11.524 | 120.784 |
| 13:01:27 | 4 | 14.201 | 33.683 |
| 13:01:29 | 1 | 10.559 | 10.559 |
| 13:01:30 | 5 | 10.679 | 11.641 |
| 13:01:31 | 5 | 9.821 | 14.655 |
| 13:01:32 | 3 | 10.338 | 16.676 |

Gate CPU Free **não aprovado**: há grupos acima dos10ms por HTTP request documentados, apesar do smoke funcional passar e nenhuma invocationError aparecer na janela. [Cloudflare explica a flexibilidade/rollover dos limites e o outcome exceededCpu](https://developers.cloudflare.com/workers/platform/limits/); sucesso eventual não garante comportamento estável com carga. [Métricas usam amostragem/quantis](https://developers.cloudflare.com/workers/observability/metrics-and-analytics/), portanto não somar/médias dos P99, não chamar120.784ms de máximo absoluto nem atribuí-lo ao login sem medição por caminho. O painel resumido mostrou8ms para52requests, mas isso não invalida os quantis de grupos acima do limite.

Diagnóstico inicial somente leitura: serviços são lazy e auth é inicializado por request quando necessário; pacote Better Auth instalado mantém scryptN16384/r16/p1 e export condicional workerd para node:crypto. Isso não prova qual trecho consumiu CPU ou qual caminho foi selecionado no bundle. Nenhuma redução de custo do hashing, cache de sessão/autorização, compartilhamento de pool cross-request ou mudança de algoritmo foi aplicada. Real-time logs padrão documentado não fornece por si só perfil detalhado de CPU; não habilitar coleta persistente/raw headers por conveniência.

Próximo gate: profiling controlado por caminho e separação de cold/warm, composição/consulta/auth/criptografia, preservando isolamento, revogação e força do hashing; então otimização mínima com RED/GREEN se houver causa comprovada e nova medição no runtime alvo. Não comprar Workers Paid, mover auth/banco para outro provedor, reativar legado, alterar architecture/budget ou fazer cutover por inferência. API continua privada; browser/provedores/R2 público/recuperação/rollback ainda pendentes. Nenhuma fixture/processo de teste criada nesta consulta.

Continuação do diagnóstico:12GETs privados sem Cookie/fixtures/provedores, com12grupos Analytics disponíveis ao final e0invocationErrors; correlação por ordem localiza três amostras acima10ms em auth/me (37.512/10.293/13.548ms), sem prova de cold start ou trace individual. Bundle confirmou node:crypto.scrypt, enquanto o caminho sem Cookie não executa senha. Fonte e perfil local complementar apontam criação repetida de contexto/endpoints/schema Better Auth por request; não há cache global seguro pronto para o pool request-local. Perfis locais reais de composição e controle auth memoryAdapter foram encerrados, sem mudança de runtime/deploy/ingress/planos. Gate Free continua não aprovado; detalhes, limites de correlação e próximo passo em [diagnóstico CPU](infra-migration-phase-13-cpu-diagnosis.md). CI anterior b2f7765/run37627330588 e frontendd7791eb/run37627339949 success.

Primeira otimização request-local implementada/revisada: signer R2 criado só no primeiro upload, mantendo native delete e isolamento por gateway. Runtime6339066; RED2falhas esperadas, GREEN4/4focados, API491/491, workerd19/19, build e productionguard7/7; dry-run4484.86KiB/gzip765.04. Implantada **somente na API production privada**, versãod4940da2-d822-4943-92e2-8f64f95ed34c, keep-vars/secrets preservados. Readbacks confirmaram mesmo namespace SQLite/Hyperdrive/bucket, oito secrets por nome, workers.dev/Preview URLsfalse, custom domains/Cron0, R2 públicofalse, realtimefalse, Stripe Test. Doze novas leituras200/200/401/404, sem Cookie/fixtures/provedores, transporte descartado. Analytics inicial4/12 com grupo48.423ms: CPU Free não aprovado, sem alegar ganho percentual ou cobertura warm. Não houve main/DNS/upgrade/Access production. Detalhes/unidades/limites no diagnóstico CPU; o ensaio de rollback posterior está registrado abaixo.

## Rollback privado e restauração em07/10/2026

CI dos handoffs API26d9142/run37632526255 e frontendb135217/run37632523047 completed/success. Ensaio somente da versão do Worker, sem mudar dados, schema ou recursos. Preflight confirmou d4940da2 a100% e isolamento. `wrangler rollback 4a33769a-1958-484d-9dbc-bcca9d1b0048 --yes` implantou a versão anterior a100%; GETs confirmaram a versão e os mesmos bindings/flags privados. Pelo service binding autenticado: health200/ok, ready200/ready, catálogo inexistente404/not_found com SELECT real. Transporte descartado.

Restauração obrigatória em finally via `wrangler versions deploy d4940da2-d822-4943-92e2-8f64f95ed34c@100% --yes`: GETs confirmaram versão otimizada a100%, workers.dev/Preview URLsfalse, domains/Cron0, R2 públicofalse, realtimefalse, Stripe Test, oito nomes secret_text e mesmo namespace SQLite/Hyperdrive/bucket. Mesmos três checks HTTP passaram; transporte descartado, comando completo exit0. Nenhuma fixture, evento, email, pagamento, secret/grant, DNS/main, Access ou plano pago alterado.

Primeira tentativa fez rollback e restauração, mas o caminho relativo do verificador local estava errado; não certificou saúde. Finally restaurou d4940da2. O ensaio completo acima usou caminhos absolutos e passou. Não omitir essa falha operacional nem atribuí-la ao runtime.

Este gate certifica **rollback de código entre essas duas versões compatíveis**, não recuperação de banco/backup, restauração de objetos, rollback de migration ou desastre de Durable Objects. [Cloudflare alerta que rollback não reverte recursos conectados e pode ser incompatível com mudanças de dados/lifecycle](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/). Recuperação ampla, browser/CORS, imagens públicas, entrega Stripe/Resend e CPU continuam pendentes; Etapa13 permanece incompleta.

Analytics relido na mesma janela fechada dos12GETs, sem repetir probes:11grupos/11requests/0invocationErrors disponíveis, limite1000 não atingido. Grupos13:51:29/13:51:45/13:52:02UTC:48.423/11.629/10.128ms, correlacionados por ordem aos três auth/me. Ainda não há cobertura12/12 nem trace individual/cold-warm; gate CPU Free continua **não aprovado**.

## Rejeição anônima antecipada em 07/10/2026

Runtime `b12bfad3b2ad49093190c50b9c43f23a721ddf23`: `requireWorkerAuth` rejeita com 401 somente quando o header Cookie está ausente, antes de inicializar serviços request-local/Better Auth/banco. Verificação de factory ausente permanece primeiro (503); rate limit, autoridade de ingresso e CORS continuam antes desse guard. Qualquer Cookie presente, inclusive vazio/inválido/não relacionado, segue para validação integral. Nenhum parser de nome de cookie, cache de sessão, pool/auth global, redução de hashing, mudança de CAPTCHA, login ou handler `/api/auth/*`.

Baseline 491/491. RED dos sete testes novos: dois 503 em vez do 401 esperado, porque a factory era invocada; cinco controles passaram. GREEN 7/7, suíte API 498/498, build TypeScript e workerd 19/19; production guard 7/7 e CLI com config explícito passaram. Testes de Cookie presente usam Better Auth real, memoryAdapter apenas em lugar do SQL externo, cookie assinado real, consulta de sessão/revogação e handler público. A primeira execução do build encontrou dois erros de tipagem das fixtures (props/ENVIRONMENT), corrigidos só nos testes; primeira CLI de guard omitiu o caminho obrigatório e falhou fechada, repetição passou. Dry-run 4484.96 KiB/gzip 765.06 KiB. Revisão independente focada: nenhum Critical/Important; Minor adiado: falta teste dedicado do 503 para factory ausente, embora a precedência permaneça no código. Não confundir esse caso com binding de rate limit ausente.

Deploy somente privado com keep-vars: versão `db882acc-fdfb-41ce-a783-04ec87954872`, startup 87 ms, sem targets públicos. GET confirmou versão a100%, oito nomes secret_text, mesmo namespace SQLite/Hyperdrive/bucket, workers.dev/Preview URLs false, custom domains/Cron0, R2 público false, realtime false, Stripe Test e observability null. CI dos handoffs anteriores API0e63d0e/run37633845136 e frontend8b437e9/run37633842242 success; não atribuir ao commit posterior.

Operador remoto exit0/dispose: três sequências health200/ready200/auth-me401 sem Cookie/catálogo ausente404, mais três controles negativos (bearer legado sozinho, Cookie não relacionado e cookie de sessão inválido)401/unauthorized. Nenhuma fixture, sessão real, credencial de usuário, email, pagamento ou provider event. Janela dos12probes `2026-10-07T14:16:48.171Z`–`2026-10-07T14:17:42.856Z`; leitura Analytics inicial parcial:8grupos/8requests/0invocationErrors, incluindo 2.865ms no grupo14:16:59UTC correlacionado por ordem ao primeiro auth/me sem Cookie. Grupos14:16:51/14:17:03UTC10.156/15.748ms correlacionados aos primeiros health/catálogo também estão acima10ms. Não há trace individual, cold/warm comprovado, cobertura completa ou ganho percentual certificado.

Os três controles foram chamados após o fim local da janela; a diferença de relógios observada pode colocar o primeiro controle na janela Analytics. Não alegar que eventual grupo extra seja um dos12probes. Operador futuro ganhou intervalo de quietude e timestamps dos controles; não repetimos requests para corrigir uma limitação de atribuição.

Leitura posterior da mesma janela:13grupos/13requests/0erros. Os primeiros12 grupos correspondem por ordem aos12probes; o extra14:17:40UTC0.856ms corresponde por ordem ao primeiro controle bearer. Isso confirma a limitação de sobreposição, não13probes originais. Auth/me sem Cookie correlacionado aos grupos14:16:59/14:17:16/14:17:32UTC: **2.865/1.396/0.908ms**, versus48.423/11.629/10.128ms na rodada anterior. É comparação de amostras isoladas por ordem, não percentual/cold-warm/capacidade sob carga.

Consulta separada somente leitura14:17:39.000–14:17:59.000UTC, sem repetir controles:3grupos/3requests/0erros,40=0.856ms,44=52.908ms,49=17.783ms. Correlacionados por ordem a bearer sem Cookie, Cookie não relacionado e cookie de sessão inválido. Os dois caminhos com Cookie presente continuam caros e recebem401, sem senha. Isso sustenta o foco na inicialização/contexto/SQL, não autoriza reduzir scrypt nem tratar presença de Cookie como autorização.

**Gate CPU Free continua não aprovado.** Essa mudança remove inicialização anônima, não o custo da autenticação com Cookie/senha nem os outros excessos. Próximo gate: design explícito para reduzir composição/contexto/SQL no caminho com credencial, com isolamento/lifetime concorrentes e medição de login, sem comprar Paid ou introduzir cache global simples. Estado final privado; main/DNS/Access/plano/secrets/grants inalterados. Recuperação ampla/browser/CORS/provedores/imagens públicas seguem pendentes.

## Ponte de contexto e engine reutilizável — implementação local em 07/10/2026

O próximo gate de design/local foi executado no worktree existente em D:/Projetos. Design e plano próprios em `docs/superpowers/specs/2026-10-07-worker-auth-context-design.md` e `docs/superpowers/plans/2026-10-07-worker-auth-context.md`. Worker reutiliza apenas engine/schema validado com um único entry por identidade exata de configuração e ambiente. AsyncLocalStorage escolhe pool/email/runner da operação atual; clientes são guardados por ownership, consultas/transações seguem no mesmo cliente e release é idempotente. Encerrar scope remove suas referências de dependências para não reter I/O em tarefas descendentes pendentes. Sessões/revogação continuam autoritativas no banco; Node mantém factory antiga e overrides são respeitados.

Após correção GC RED→GREEN: API514/514, workerd20/20, GC1/1, build e guards production7/7+CLI passaram. Bundle production dry-run4490.24KiB/gzip766.39KiB. Default engine/schema real em testes, transporte SQL/metadados sintéticos; sessão válida/revogação no memoryAdapter. Revisão independente do novo range pendente. **Não houve deploy nem push nesta rodada**; última versão privada observada permanece db882acc. Gate Free, SQL/login/CPU remotos, browser/CORS/provedores/imagens/recuperação e cutover público seguem abertos.

Revisão independente concluída para `72dec1d..e9aa582`, o range integral do experimento, sem reabrir commits históricos: nenhum Critical/Important/Minor. Aceito **somente como experimento local**. Commits36d76df/e9aa582 não foram enviados ao remoto; nenhuma versão Cloudflare alterada. Decisões e limites completos em `docs/superpowers/plans/2026-10-07-worker-auth-context.md` (encerramento abaixo dos passos).
