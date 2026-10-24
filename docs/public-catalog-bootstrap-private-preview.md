# Bootstrap privado e alvo vazio — 24/10/2026

O CLI `bootstrap-public-catalog.ts` já usava UUID explícito, sessão protegida, GET de autorização e um POST de rebuild. O preview exige também Access e bearer. Preparado `scripts/bootstrap-private-preview.mjs` para compor esses headers **em memória**, sem alterar runtime, CLI público ou proteção do preview.

O transporte é exclusivo de `stage11-inert`: valida UUIDs, audience e expiração curta do JWT; a assinatura continua sendo validada pelo Cloudflare Access. Admite somente GET `/restaurants/:restaurantId` seguido de POST `.../catalog/rebuild`, para um único restaurante/operationId/sessão, protocolo1 e body `{}`. Destino/Origin fixos; redirects proibidos, credentials omit e no-store. Rejeita overrides/headers extras/queries, outro alvo, ordem errada e replay. Falha descarta referências de credenciais sem retry/refresh; `dispose()` no finally também cancela I/O pendente. Não recebe segredos por argv/env/arquivo e não descobre/renova credenciais.

Uso por futuro operador aprovado: obter credenciais pelo fluxo protegido já existente; criar transporte com `{restaurantId,operationId,accessJwt,bearer}`; chamar o CLI importado pelo `tsx/esm/api` instalado, injetando `request:transport.request` e `readSession` em memória; sempre `transport.dispose()` no finally. As confirmações de readiness/writers do CLI continuam obrigatórias e **não são prova** dos gates. O transporte não liga flags, não faz login, não altera produção nem justifica reutilizar bearers descartados.

## Verificação local

18 testes novos RED→GREEN para composição com o cliente real de bootstrap e limites de segurança, mais dois testes HTTP reais loopback127.0.0.1. Estes últimos validam o consumo de resposta POST após receber os headers e o cancelamento de um fetch pendente, não apenas objetos Response sintéticos. Destinos externos nesses testes são doubles; não certificam autorização ou publicação remota do CLI.

Finais24/10: **318/318 testes de operadores e704/704 da API**, zero falhas/skips; typecheck/syntax/diff-check exit0. `test:catalog-bootstrap` agora inclui os dois arquivos de testes. Nenhum código do Worker/frontend/billing foi alterado e não foi necessário repetir workerd, migrations, smoke tenant, canários ou revisão de branch encerrados.

## Aplicação não é necessária no preview vazio

Conferência real em transação REPEATABLE READ READ ONLY na branch preview:0restaurantes,0onboardings concluídos,0itens,0journals e0revisions. Portanto **não há alvo para carga inicial neste instante**. Não criar fixture apenas para executar apply, não afrouxar o requisito de UUID explícito e não chamar bootstrap com lista vazia. A aplicação atual é no-op por ausência de dados, não um rebuild remoto executado.

Banco/role e TLS1.3 do cliente verificados; conexão encerrada/ROLLBACK. Produção teve somente conferência agregada READ ONLY:0restaurantes/itens/users/sessions/outboxes de billing/pagamento, mas as tabelas-marcadoras canônicas ainda estão ausentes. Isso não dispensa backup/restauração, migrações/grants e promoção pareada próprios de produção. O relatório completo está no frontend `docs/infra-migration-catalog-bootstrap-readiness-2026-10-24.md`.

Preview permanece na última implantação verificada36, ambasflagsfalse/CPU1000; não foi consultado ou alterado na Cloudflare nesta passagem. Catálogo7/10 e Etapa13 abertos; ausência de alvos não comprova cobertura de writers, ausência futura de dados, recursos/ACLs de produção ou ativação global.
