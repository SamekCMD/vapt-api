# Etapa 13 — Workers Paid e CPU limitada, 07/10/2026

## Atualização de ingresso — 07/10/2026

Após autorização explícita, APIeeb0d212 passou a ser pública somente em api.vapt.app.br; CPU1000 e mesmos recursos/secrets/StripeTest/realtimefalse confirmados, workers.dev/VersionURLs API continuam off. Frontendvapt.app.br/deb94199, HTTPS/CORS/SQL e login real no Brave passaram; reload/logout interrompidos por extensão ainda pendentes. Fixture própria removida/pool fechado. Sem main/novo plano/StripeLive/ZeroTrustproduction. Runbook de pareamento e rollback no repositório produto: `docs/infra-migration-phase-13-browser-pairing.md`. Evidência privada abaixo permanece histórica, não descreve ingresso atual nem certifica cutover final.

## Estado confirmado

Workers Paid ativado na conta Cloudflare existente após autorização financeira e aceite contratual explícitos. Checkout confirmou assinatura ativa, US$5/mês mais uso excedente. Assinatura por conta, não por Worker: inclui os Workers existentes e não é teto de fatura. Nenhum serviço Images/Stream foi configurado; checkout exibiu essa linha a US$0/mês. Zero Trust de produção, Neon Paid, Stripe Live, DNS, main e aposentadoria Coolify/Hetzner não foram ativados por esta autorização.

Configuração production agora contém `limits: { cpu_ms: 1000 }`. Commit `d9fead0084bc6e58b1c31f150da1cac04ba7a3e1`; runtime de aplicação preservado. Deploy keep-vars criou versão **privada** `eeb0d212-ad66-4c0a-90ec-7117b89a4266`, confirmada a100% e com `limits.cpu_ms=1000` pela API Cloudflare. Nenhum deploy preview/billing/frontend nesta rodada.

Readbacks pré/pós e pós-teste preservaram workers.dev e Preview URLs desligados, zero custom domains/Cron, R2 público desligado, realtimefalse, Stripe Test, mesmos oito nomes de secrets e mesmos Hyperdrive/bucket/namespace DO. Nenhum valor de secret lido/logado. Observability continua null; nenhum logging pago habilitado. Guard impede ingress e mudanças de orçamento não deliberadas.

## Verificação

- Baseline guard7/7; novos testes RED com duas falhas esperadas, depois GREEN8/8+CLI. Ausência, tipo incorreto, CPU diferente e campos extras de limits são rejeitados. Ingress/credenciais/bindings/flags/rate continuam fail-closed.
- API539/539, TypeScript e dry-run production passaram; bundle4491.08KiB/gzip766.76KiB. Warning SQLite experimental existente, nenhuma falha. Revisão focada Astra medium sem Critical/Important/Minor; CLI/14mutações independentes aprovadas, teste completo do reviewer bloqueado por spawnEPERM (não atribuído como8/8 dele). CI executa guard+config real; novos heads exigem leitura própria.
- Health200, readiness200 com SQL real e catálogo ausente404 passaram após deploy; operador encerrado.
- Com Turnstile humano real, 13checks sintéticos passaram: login, cookie Secure/HttpOnly/SameSite=Lax, sessão, owner/CRUD/menu/cozinha/caixa, R2 tamper/upload/leitura privada/delete/expiração, logout e reutilização rejeitada401. Vinte e quatro requisições de API entre login e revogação, via binding remoto e role SQL limitada; bootstrap/cleanup owner restritos às fixtures próprias.
- Cleanup confirmou zero resíduos em12tabelas e zero objetos próprios. Processo exit0, receiver/transporte/pool encerrados. Nenhum email, cobrança Stripe ou fixture permanente; desafio, senha, cookies, tokens e URLs assinadas não foram registrados.

## CPU observada

Janela UTC `2026-10-08T00:30:29.179Z`–`2026-10-08T00:30:40.174Z` (noite de07/10 em São Paulo). Analytics:6grupos/24invocações/0invocationErrors, outcome success, limite1000grupos não atingido. Outcome não é status HTTP:403/404/401 esperados também são execução bem-sucedida. Microssegundos originais convertidos emms:

| Grupo UTC | Requests | CPU P50 (ms) | CPU P99 (ms) |
| --- | ---: | ---: | ---: |
| 00:30:31 | 2 | 16.913 | 270.107 |
| 00:30:32 | 7 | 13.626 | 16.614 |
| 00:30:33 | 1 | 38.440 | 38.440 |
| 00:30:35 | 2 | 9.762 | 11.980 |
| 00:30:36 | 6 | 11.223 | 17.351 |
| 00:30:37 | 6 | 8.755 | 24.148 |

Maior P99 de grupo270.107ms, abaixo do teto configurado1000ms. Grupos amostrados, não máximo absoluto, quantil global, trace por endpoint ou prova cold/warm. Relógio Analytics antecede timestamps locais; não atribuir270.107ms exclusivamente ao login. Smoke sequencial aprovado, não capacidade sob concorrência/carga alta nem garantia para todos os endpoints.

## Limites e próximos gates

Teto inicial1000ms evita aceitar silenciosamente o padrão Paid30s. Espera de rede/SQL não conta como CPU; não é timeout HTTP. Cloudflare permite flexibilidade ocasional e pode encerrar execução com1102/exceededCpu ao atingir o limite consistentemente. Não executar loop abusivo em produção para provar comportamento do fornecedor.

Preservar body/CAPTCHA/rate por IP e instância, SQL8s/lock2s/checkout5s, hash/sessões. Não são quota global por identidade nem teto financeiro: volume de requisições pequenas, provedores, R2/DO e outros Workers podem gerar excedentes. Não enfraquecer segurança para perseguir Free10ms. Ajustes futuros de CPU exigem configuração/guard/verificação deliberados; rollback de código/configuração não cancela assinatura nem reverte banco/objetos/efeitos externos.

Antes de cutover continuam browser/CORS/cookies reais, imagens públicas deliberadas, entregas/ciclo de provedores, observabilidade e controle de volume conforme plano. Nenhum ingress público, merge ou cutover foi autorizado por esta ativação; Etapa13 aberta. Reutilizar produção já preparada, sem recriar infraestrutura. Registros anteriores sem Paid/limite são históricos e supersedidos somente neste escopo.

Fontes oficiais: [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [CPU/runtime limits](https://developers.cloudflare.com/workers/platform/limits/), [Wrangler limits](https://developers.cloudflare.com/workers/wrangler/configuration/).
