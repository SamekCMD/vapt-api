# Etapa 13 — preparação de logging seguro

## Gate remoto de metadata — reprovado em 15/10/2026

**Não executar `deploy:worker-production-observability` com base apenas no guard/dry-run.** A configuração estática passou, mas não satisfez o contrato de persistir somente códigos fixos sem dados sensíveis de requisição. A coleta na API real permanece ausente; o logger sanitizado local não foi implantado nesta rodada.

Sonda descartável `vapt-log-metadata-probe-20261014`, sem ingress público, Cron, DB/R2/DO/Queue/serviços ou secrets; apenas marcador próprio, CPU25ms. Readback confirmou logs persistidos, invocation_logsfalse, traces/Issuesoff, queryredactiontrue e nenhum destino externo. Sampling100% **somente na sonda** para obter evidência positiva com uma chamada; configuração candidata da API segue1%, não ativada. Nenhum novo plano ou aceite de novos termos de preço.

CLI não tinha WorkersObservabilityWrite (preflight403/10000 antes de criar recurso); não houve ampliação de token ou repetição da query recusada. Leitura foi feita no dashboard já autenticado, dataset CloudflareWorkers, filtro exato `$metadata.service` somente dessa sonda. Guard local de preflight UI recente/vazio rejeitou timestamp velho/futuro, conta/domínio/Worker/dataset/filtro divergentes: REDfeaturemissing→GREEN5/5 no conjunto. Nenhum cookie/header de sessão do navegador ou fetch interno foi usado; somente UI normal/DOM renderizado.

Primeira tentativa falhou antes da confirmação do receipt; causa não determinada e nenhum sucesso inferido. Transporte encerrado, Worker próprio removido/404 e produção inalterada. Segunda tentativa acrescentou somente diagnóstico de status/flags:HTTP200, chegada das nove sentinelas fictícias confirmada e três códigos emitidos. Não houve mudança funcional que permita chamar a primeira falha de corrigida. UI retornou os três registros de error às03:09:47.125UTC (`auth_operation_failed`, `worker_request_failed`, `auth_email_failed`), com janela15min/filtro próprio. No detalhe renderizado do primeiro código, a URL de requisição reteve a sentinela de **email fictício no caminho**. Logo, queryredaction+invocation_logsoff não removem todo conteúdo do path; não aprovar o contrato com base em console sanitizado.

Somente labels/booleans, status, códigos fixos e campos públicos de controle foram emitidos pelo operador. Nenhum log bruto, token/cookie/CAPTCHA/PII real foi impresso ou salvo. Não foi certificado que todos os outros campos estão ausentes; inspeção de UI não substitui auditoria exaustiva. A evidência negativa de um marcador já basta para reprovar essa policy. Nenhuma segunda chamada de exceção intencional foi feita; o caminho uncaught permanece não testado.

Operador90645 encerrouexit0 após finish de lifecycle: transporte fechado, remoção somente da sonda própria confirmada404, pre/post API914f79f0/frontend e77339dd preservados, realtime ligado/CPU1000/rates/recursos/secrets por nome/ingress/StripeTest/R2privado intactos e coleção ausente. O operador não autocertifica privacy; a evidência UI acima é separada. A tentativa71223 anterior encerrouexit1 e também limpou o próprio recurso. Registros exclusivamente sintéticos podem permanecer pela retenção Cloudflare; não houve purge de logs alheios.

Próximo passo: manter métricas agregadas existentes e coleta automática desligada; decidir um desenho capaz de sanitizar ou excluir metadata de requisição **antes** de qualquer persistência real. Não criar novo pipeline/serviço/destino ou aceitar exposição por inferência. Logging persistente/alertas/capacidade e Etapa13 global continuam abertos. NeonFree/cota e Cron billing30min não foram alterados por este ensaio; gates SQL dependem da recuperação de capacidade.

## Preparação local em 14/10/2026

Desenho limitado aprovado pelo usuário: somente códigos fixos de falha, sem mensagens brutas/tokens/PII, sem logs automáticos de requisições ou traces, e amostragem de 1% na API production após verificação. Esta rodada prepara o código e as guardas; **não habilita coleta nem implanta o Worker**.

O engine Better Auth do Worker agora utiliza um logger explícito de nível error que descarta mensagem e argumentos da dependência e emite somente `auth_operation_failed`. Opções comuns da API Node/Coolify, autenticação, CAPTCHA, hash, sessão/revogação, SQL, cache/contexto e rate limit permanecem inalterados. Não há monkey-patching de console no produto nem novo SDK de logging.

Regressões usam o engine real, cookie assinado sintético e Kysely; apenas o transporte SQL é controlado. Falha SQL carrega email, token e senha fictícios: antes da correção, dois testes falharam pela saída não limitada ao código fixo; após a mudança, ambos passaram e a falha operacional permanece 500/rejeição. A prova workerd também exercita handler e getSession reais e exige que todos os argumentos de console sejam exatamente o código fixo. Capture de console ocorre somente nos testes e na fixture local, que não entra no bundle production.

## Configuração separada, não padrão

`wrangler.worker-production-observability.jsonc` difere da configuração realtime atual somente pelo bloco observability. Exige coleta habilitada com sampling 0.01, query redaction explícita, logs persistidos sem invocation logs, traces e Issues desabilitados e nenhum destino externo. Sampling não garante captura de uma falha rara nem teto financeiro; métricas agregadas continuam necessárias.

Guarda `verify-observability-production-config.mjs` valida formato/chaves/valores estritos e então reutiliza integralmente a guarda realtime original. Recusa sampling ausente/100%/tipo incorreto, invocation logs/traces, query redaction ausente/desligada, destinos e campos adicionais; preserva CPU de 1000 ms, rates, conta/rotas/flags/recursos, Stripe Test e ausência de credenciais em vars. As guardas/configs de preparation/public/realtime antigas continuam recusando observability e não foram relaxadas.

Comandos explícitos: `verify:production-observability`, `build:worker-production-observability` (dry-run) e `deploy:worker-production-observability` (mutação remota; **não executada nesta rodada**). CI testa guarda e bundle sem deploy. Não usar o último comando como se a validação estática fosse uma autorização ou prova de privacy da plataforma.

## Verificação local

- Baseline API 550/550; RED dois casos de logger → GREEN 10/10 no arquivo; suíte API 552/552.
- Guarda nova: RED cinco testes pela feature ausente → GREEN 5/5, com mutações de privacy/custo/isolamento e CLI sanitizada.
- Conjunto de guardas preparation/public/realtime/observability/readback: 25/25.
- Workerd 22/22, incluindo os dois consumidores reais de logging; retention 1/1 e TypeScript aprovados.
- Dry-run da configuração exata aprovado: 4496.19 KiB/gzip 768.02 KiB. Nenhum upload/deploy/provedor; warning experimental SQLite existente não foi falha.

## Gate remoto ainda aberto

Esses testes certificam a saída de logging nos consumidores exercitados, não todos os SDKs, exceções não tratadas ou metadados acrescentados pela Cloudflare. A API de telemetria documenta enriquecimento de eventos e URL; desligar invocation logs não constitui, sozinho, prova de que todo metadado sensível está ausente. [Workers telemetry](https://developers.cloudflare.com/api/resources/workers/subresources/observability/subresources/telemetry/), [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/).

Antes de persistir: readback estrito da versão/policy e controles existentes, verificar metadados somente com sentinelas sintéticas e orçamento fechado, analisar caminhos de exceções da plataforma e dependências. Não ler headers/tokens reais para testar sanitização. Se a policy não puder cumprir o contrato, manter a coleta desativada e resolver a limitação; não declarar sucesso por ausência de evento numa amostra de 1%.

Retenção e preço são controlados pelo fornecedor, não configurados como teto por este arquivo. A documentação consultada em 14/10 informa inclusão no Workers Paid e cobrança excedente, além de mudança de preço anunciada para 01/12/2026; conferir condições vigentes antes da ativação. [Pricing de Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/#pricing).

Sem alteração de produção/preview/billing, secret, recurso, plano, DNS, main, fixture remota, email, pagamento ou desligamento Coolify/Hetzner nesta rodada. Último par remoto confirmado continua API 914f79f0/frontend e77339dd, realtime ligado, observability null. Alertas/capacidade/estabilidade e outros gates da Etapa 13 permanecem abertos.
