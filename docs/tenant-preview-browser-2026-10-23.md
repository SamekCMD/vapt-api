# Gate privado do frontend candidato — 23/10/2026

## Resultado final18:56UTC — aprovado e encerrado

Uma execução do controlador5766, exit0, runId`800edee6-0aea-4113-8bfe-e7ea6417a488`. Renovação31→32/`35fd7ac3-2601-46bb-adec-39ef46813131` passou todos os guards; código/recursos/CPU1000/flagsfalse e controles preservados. Nenhum upload de código API ou publicação F. Owner: cozinhaA→B por1PATCH204, recarga e reabertura sem parâmetro preservaramB, Business2/25, logout→login e navegação nova permaneceu sem sessão. Staff: cozinha/Equipe, gestão oculta, criação bloqueada, cobrança com UUIDpróprio bloqueada sem consultar endpoint de assinatura. Primeira rota staff sem seleção foi corretamente ao seletor; teste específico de cobrança usou unidade explícita.

Adaptador encerrou com `ok:true`, `cleaned:true`, `logoutVerified:true`,77chamadas/120máximo,73HTTP200/1HTTP204/3HTTP401, `sessionsRetained:0`, `retainsCredentials:false`. Revogação verificou ambas as sessões com cookie antigo401; driver conferiu cleanup de15relações/efeitos. Nova conexão TLS READ ONLY confirmou8contagensglobaiszero/ROLLBACK/close. Cinco contas/duas organizações/três unidades sintéticas próprias removidas e recriáveis; nenhum cliente ou dado preexistente apagado. HTTP e auxiliares estáticos fechados; zero listeners restantes nas portas deste gate.

Primeiro ingresso da extensão chegou como cross-site e foi recusado antes do adaptador; navegação por âncora em página estática loopback sem credenciais admitiu same-site normalmente, sem relaxar guards/Access/CORS. As38leituras de cozinha no teste usaram o fallback com realtime localfalse, não são benchmark/custo de produção. Nenhum email/pagamento/R2/DO de produto/schema/grant/flag/produção/main/plano novo. Scratch F contém resultado/manifesto/capturas e teste local; relatório F`docs/infra-migration-frontend-preview-browser-2026-10-23.md` detalha as observações e limites. Não repetir esta renovação ou smoke68; baseline32 é rejeitado pelo operador. Catálogo7/10/Etapa13aberta, cpuWorkloadVerifiedfalse/activationReadyfalse.

Código do adaptador qualificado no checkpoint`f049819`,244/244 operadores/701/701 API após última correção, zero skips. Seções de preparação abaixo descrevem o checkpoint anterior à execução. A prova mantém logins/cookies server-side e **não** certifica login/cookies/CORS diretos do navegador na futura publicação.

## Autorização e desenho limitado

Usuário respondeu “continuar” à proposta explícita de uma renovação única de `PARALLEL_PREVIEW_TOKEN` somente em `stage11-inert`, uso das fixtures sintéticas próprias e limpeza verificada, após preparar/testar adaptador local. Não autoriza frontend remoto, publicação de código API, mudanças em produção, schema/grants/flags, ServiceToken, email/pagamento, recursos/plano, main/push ou replay do smoke de68checks.

Operador de renovação agora fixa exclusivamente deployment31/`6110a9fe-0ee6-4faa-920e-23f73f7a504d`→32. Preserva código, nove nomes/valores dos demais secrets, HD/R2/DO/Access/CPU1000, flagsfalse, exposição e controles existentes; rejeita31alterado ou aprovação30já consumida. Mesmo único PATCH de secret já qualificado; sem upload de bundle, retry/reparo/rollback automático. Renovação não é execução concluída: conferir relatório real antes de atualizar o estado abaixo.

`scripts/tenant-preview-browser-adapter.mjs` é ferramenta de teste **fora do runtime do produto**, sem CLI/env fallback. Destino fixo no preview, allowlist de métodos/rotas/UUIDs do manifesto, body1KiB/resposta128KiB, no máximo120chamadas HTTP (reserva para logout), fila8 e espaçamento3,3s, validade no máximo30min/Access. Cookies Better Auth de owner/staff, AccessJWT e bearer ficam apenas na memória do processo servidor. Login das duas fixtures acontece no servidor, com o mesmo token Turnstile de teste do smoke anterior. Passwords emprestadas são apagadas das referências; não há promessa de zeragem forense da memória JavaScript.

Adaptador local admite apenas Host/Origin127.0.0.1 exatos; não encaminha cookies/headers de admissão fornecidos pelo navegador. Contextos separados, identidade capturada antes da fila e projeção explícita de DTOs: GETsession não devolve token/IP/UserAgent, login/Set-Cookie/Location/erros brutos nunca são enviados ao navegador. Staff continua sujeito à autorização real do backend. Únicas mutações HTTP: preferência com organização/unidade consistentes no manifesto e logout com JSONobjeto vazio, seguido deGET/auth/me com o cookie antigo exigindo401. Checkout, portal, signup, uploads, catálogo e outros writes não são aceitos. Cozinha aceita apenas resultado vazio esperado das fixtures, não pedidos preexistentes.

Servidor/harness frontend permanece no scratch ignorado do plano catálogo em D:. Build isolado sem envfiles/injeção VITE ambiente, API na mesma origem loopback e flags locais inativas. CSP bloqueia conexões/scripts externos, sem mudar Access/CORS/trustedOrigins/cookies do backend. Isso testa UI→adaptador→HTTP real com autorização real, **não** login/cookies/CORS diretos do navegador na publicação final, realtime, catálogo, carga ou CPU8MiB.

## Verificação local

- Adaptador:12casos, incluindo isolamento owner/staff, ausência de tokens no conteúdo/erros, rejeição de rotas/origens/bodies, respostas grandes/redirect, abort/fechamento, reserva de chamadas e logout que falha se o cookie antigo ainda funciona. Novos comportamentos reproduzidos antes da implementação/correção, inclusive logoutJSONscalar/array e pin31→32.
- Suítes finais após a última correção: operadores244/244, zero skips, exit0; API701/701, zero skips, exit0. Logs locais `browser-gate-final-mjs.log` e `browser-gate-final-api.log` no scratch do plano.
- Servidor loopback:4casos de indisponibilidade antes da admissão, rejeição de origem, não encaminhamento de headers e entrada limitada. Implementação inicial foi retirada, contrato reproduzido em4falhas e reimplementado; resultado4/4. Não apresentar a primeira execução verde isolada como provaRED.
- Nenhum código em `src` mudou. CI inclui teste do adaptador sem credenciais ou acesso remoto; resultados CI antigos não cobrem estes commits locais.

## Execução remota

Procedimento do checkpoint anterior, agora executado conforme resultado final acima: build, preview31, autenticação Access transitória e quota216000/endpoint0,25CU, credenciais somente em memória e banco inicial sem resíduos. Marcador público exclusivo precedeu uma única renovação; manifesto UUID próprio e seed com o driver já qualificado. Não recriar/aplicar migrations ou investigar infraestrutura legada.

Servidor só admite o navegador após logins server-side. Operador confere unidadeA→B/preferência/reabertura, Business2/25, logout→login e restrições de staff; comando `finish` exige contadores mínimos e zero leitura de cobrança por staff. Ao terminar, fechar HTTP, revogar/verificar sessões, executar cleanup UUID/marcador com guards do driver e readback independente, fechar pool e limpar referências. SeedCOMMIT incerto proíbe cleanup/retry cego; cleanup incerto proíbe retomada. Resultado e readback têm de ser registrados sem tokens. Não iniciar outro controlador se o resultado da renovação for incerto.
