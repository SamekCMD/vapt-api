# Gate privado do frontend candidato — 23/10/2026

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

Ainda não iniciada neste checkpoint. Controlador do scratch deve primeiro concluir build, conferir preview31, autenticação Access transitória e quota216000/endpoint0,25CU, obter credenciais somente em memória e confirmar banco inicial sem resíduos. Grava marcador público exclusivo antes de uma única renovação, manifesto UUID próprio e depois seed com o driver já qualificado. Não recriar/aplicar migrations ou investigar infraestrutura legada.

Servidor só admite o navegador após logins server-side. Operador confere unidadeA→B/preferência/reabertura, Business2/25, logout→login e restrições de staff; comando `finish` exige contadores mínimos e zero leitura de cobrança por staff. Ao terminar, fechar HTTP, revogar/verificar sessões, executar cleanup UUID/marcador com guards do driver e readback independente, fechar pool e limpar referências. SeedCOMMIT incerto proíbe cleanup/retry cego; cleanup incerto proíbe retomada. Resultado e readback têm de ser registrados sem tokens. Não iniciar outro controlador se o resultado da renovação for incerto.
