# Etapa 13 — preparação da API production

## Status em 06/10/2026

API production implantada sem entradas públicas, com quatro secrets instalados e CORS do bucket configurado. Cutover ainda pendente: credenciais R2/Stripe, pareamento funcional, CPU Free e rollback precisam dos próximos gates. Main, DNS, plano pago e Access de produção não foram alterados. O runtime da Etapa12 é reutilizado, sem uma segunda implementação da API.

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

Pendentes: `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `STRIPE_SECRET_KEY` Test e `STRIPE_WEBHOOK_SECRET` do endpoint próprio; origem/entrega webhook, upload/leitura/delete, auth/cookies/Turnstile, conectividade/ACL SQL e orçamento CPU Free. Sem configuração completa, não declarar readiness ou saúde remota. A API segue sem tráfego público e a Etapa13 não está concluída.

Rollback operacional: manter ingress/realtime desligados; escolher uma versão anterior quando necessário, preservando secrets válidos e o namespace SQLite. Não apagar namespace/objetos ou executar migration destrutiva. Reverter somente documentação não desfaz recursos remotos.
