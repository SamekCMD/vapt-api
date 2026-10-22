# Gate autenticado tenant — preview, 22/10/2026

Escopo aprovado pelo usuário após desenho pontual: renovar somente o bearer de `stage11-inert`, login transitório no Access existente (1h, sem Service Token), fixtures verificadas e limpeza restrita. Não autoriza produção, frontend, main, flags, recursos adicionais ou mudanças de schema/grants.

## Operadores preparados

- `tenant-preview-fixtures.mjs`: alvo direto Neon preview fixo, TLS verificado, role owner existente, cinco contas sintéticas com hashes Better Auth, duas organizações e três unidades. Business tem duas unidades; Pro está no limite de uma. Manifesto interno imutável; colisão aborta antes de INSERT. Não envia emails nem chama Stripe/R2/DO.
- `verify-tenant-preview.mjs`: perímetro Access/bearer, login real, bootstrap dos quatro papéis, leitura explícita das unidades, ausência de campos privados de billing, capacidades, entitlements, isolamento entre organizações, preferência persistida/rota explícita e negação de PATCH por staff; logout e cookie revogado. Não é prova de todas as mutations de admin/manager, onboarding, navegador ou CPU/workload.
- Requisições espaçadas em 3300ms, respeitando o rate limit existente de20/min/IP, sem desativá-lo. Sem retries automáticos. Saída somente status/contagens, nunca cookies/tokens/passwords ou corpos de erro.
- `rotateTenantPreviewBearer` no operador existente: PATCH merge-patch exclusivo de `PARALLEL_PREVIEW_TOKEN`, clonando explicitamente implantação28 `fca1102f-05b4-488e-bc6a-11d1f82e0bd9`. Nenhum upload de bundle. Exige29, mesmo metadata de runtime/bindings/CPU1000/flagsfalse, Access, R2 privado, Hyperdrive preview/cacheoff e controles production/web/top-level idênticos. Falha ou resultado incerto nunca autoriza retry/repair/rollback.

Limpeza só após seed confirmado: locks e comparação exata de usuários, organizações, membros e restaurantes; efeitos inesperados de onboarding/billing/catalog/payment abortam antes de DELETE. Exclusão por UUID+owner+marcadores privados, sem filtros editáveis pelo chamador. Resíduos conferidos antes do COMMIT e em statement independente após liberar a única conexão do pool. Falha de limpeza reprova o smoke; não se descarta efeito aceito para fazê-lo passar.

## Evidência local

- Novos módulos: testes de ausência observaram RED antes da implementação. Regressão adicional de pool max1 observou RED e foi corrigida liberando o client antes do readback independente.
- Operadores MJS completos: **218/218**, exit0. A tentativa sob sandbox encontrou `spawn EPERM` nos testes de CLI; execução autorizada com subprocessos passou.
- API: **701/701**, exit0; build TypeScript exit0. Nenhum runtime de produto alterado por este gate.
- PostgreSQL18.6 local descartável: **1/1**, zero skips, schema real009–012, hash Better Auth verificado, seed real de5 usuários/2 organizações/3 unidades, preferência+sessão e limpeza commitada com zero resíduos. Só o limite externo owner/TLS foi substituído pelo pool loopback do harness; não prova o Neon/Hyperdrive remoto.
- O runtime/harness existente foi reutilizado em memória, apontando o scratch para o plano de catálogo. Nenhum workspace do plano tenant encerrado foi recriado.

## Estado remoto

**Pendente neste checkpoint.** GET de metadados confirmou implantação28 como baseline. Nenhuma rotação, fixture ou chamada autenticada de aplicação foi executada ainda. Publicação compatível anterior permanece documentada em `public-catalog-preview-compatible-verification.md`. Catálogo7/10 formalmente; Etapa13 aberta.

O executável portátil cloudflared2026.10.3 foi obtido do link Windows64 da [documentação oficial](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/) e conferido contra o SHA256 publicado na [release oficial](https://github.com/cloudflare/cloudflared/releases/tag/2026.10.3): `76b2805253d0d6ffacb092a7acfbee99e7af6917835c0c5410e23f3ef5052da2`. Restrito ao scratch ignorado, sem instalação global/serviço/túnel. Cache nativo transitório do app, se criado pelo login, deverá ser tratado separadamente; nenhuma credencial persistente nova foi autorizada.
