# Catálogo — Preview inerte implantado

Atualização SQL22/10: autorização específica permitiu backup/restore local e aplicação009–012/quatro grants somente na branch preview`br-rough-dew-b6ydeygb`. F383/A701/PG93/buildA0, readback de integridade/ACL e conexão real limitada com dez negações aprovados. Report no repositório produto:`docs/infra-migration-preview-schema-gate-2026-10-22.md`. Preview30tabelas/0linhas; produção apenas READ ONLY, hash antes/depois igual. **Código publicado permanece a mesma implantação27**, flagsfalse/activationReadyfalse; SQL não publicou a API tenant. Não repetir migrations nem inferir autorização de deploy/flags/bootstrap/production. O registro18/10 abaixo permanece histórico. Checkpoints anteriores à escrita:F058a359/A60799eb, sem push/main/deploy neste gate.

18/10/2026. Autorização humana específica: preparação inerte **somente no Preview existente** `stage11-inert`, com registro append-only da classe SQLite e binding do bucket privado já criado. Nenhum SQL/schema, bootstrap, frontend/produção, segredo, DNS ou plano novo incluído. Esta preparação não ativa o catálogo nem encerra a tarefa9.

## Implantação e readback

| Campo | Resultado conferido |
| --- | --- |
| Conta / Worker | `3ce69408aa5112617a282957aba71932` / `vapt-api-parallel` |
| Preview preservado | `56efdbf131174b8fba43387369c6f1e3` / `stage11-inert` |
| Deployment anterior | `cede8793-b761-4124-b326-e0016614e295`, número26 |
| Deployment novo | `7b51fca2-207e-4e29-948e-159761b362ea`, número27 |
| Data UTC | `2026-10-18T17:26:43.628115Z` |
| Migration tag | `catalog-publication-preview-sqlite-v1` |
| Novo namespace | `eeda94fea90349be8b62b82067c79b27` |
| Classe / tipo | `PublicCatalogCoordinator` / `use_sqlite:true`, confirmado por GET do namespace |
| Realtime anterior | `69fbe1f54ad64a93b7cb761910da094a`, preservado |
| Catálogo / imagens | `PUBLIC_CATALOG_BUCKET=vapt-catalog-preview`; `R2_BUCKET=vapt-assets-preview` |
| Flags API | Reader e writer **false** |
| CPU configurada | `limits.cpu_ms=1000`, confirmado pelo GET do deployment novo |

Operador versionado em `31ba023` antes da publicação. Executado `node scripts/catalog-preview-inert.mjs apply` **uma vez**, exit0. O operador fixou conta, configuração, Worker, nome/ID existentes e argumentos; não reabriu os aliases genéricos de deploy. Comparou antes/depois as implantações de `vapt-api-production`, `vapt-web` e top-level `vapt-api-parallel`: **sem alteração**. Não substituir este readback pelo top-level antigo ou pelo dry-run production.

Foram preservados os nove secrets por nome/tipo, o Hyperdrive de preview, bucket de imagens, seis rates11011–11016 e namespace realtime. Nenhum secret foi enviado/reescrito. Observabilidade, logs, traces e logpush continuam desativados; nenhum Tail Consumer. Credencial OAuth existente somente em memória via stdout capturado do Wrangler, com `WRANGLER_WRITE_LOGS=false` e métricas desativadas; valores não emitidos, salvos no projeto ou incorporados aos relatórios.

O helper passou a verificar explicitamente a CPU retornada após descobrir que o deployment novo inclui `limits`, ausente no anterior. Esse ajuste local **não** gerou outra publicação. `inspect` confirmou o mesmo deployment27 com `cpuLimitVerified:true`, `cpuWorkloadVerified:false`, `activationReady:false`.

## Acesso e armazenamento

GETs sem cookie/bearer, sem seguir o redirect, retornaram302 para Cloudflare Access tanto na URL estável `stage11-inert-vapt-api-parallel.autoistloko.workers.dev` quanto na URL imutável retornada pelo provedor `7b51fca2-vapt-api-parallel.autoistloko.workers.dev`. Nenhum login, teste autenticado ou endpoint de negócio executado. Isso prova bloqueio anônimo observado, não todas as políticas/identidades de Access.

Antes e depois, readback do bucket `vapt-catalog-preview`: r2.dev desativado e nenhum custom domain. Nenhum objeto R2 foi enviado/apagado e nenhuma ACL alterada. O namespace foi registrado; não houve comando de catálogo, SQL Neon, bootstrap ou medição de workload nesta etapa.

## Verificação e limites

- API `npm test`:670/670; `npm run build`: exit0.
- Scripts operacionais completos:177/177, incluindo18 casos do operador inerte e os aliases anteriores bloqueados; grupo de configuração/operador69/69.
- TDD: operador ausente RED→GREEN; proteção contra expulsão automática de histórico RED→GREEN; readback com CPU ampliada RED→GREEN. Post-checks sintéticos rejeitam perda de secret, reader ligado, bucket production, troca do namespace anterior e drift dos deployments de controle, sem retry/reparo automático.
- Uma tentativa inicial de teste foi bloqueada por spawnEPERM antes de executar; a execução permitida depois reproduziu a falha real. Não contar erro de ambiente como regressão coberta.
- Não houve nova execução de frontend, workerd ou PostgreSQL nesta etapa de scripts/deploy inerte; evidências anteriores permanecem datadas. Não há CI remoto certificado.

Decisão: a autorização separada permite **registro inerte** antes da prova de workload/CPU, não dispensa nenhum gate de ativação. Custo se a preparação falhar: readback manual e preservação do namespace; nunca apagá-lo, reimplantar configuração pré-classe ou fazer retry cego. O operador recusa cumulativo de implantação≥100 para não provocar expulsão automática de histórico; pré-readback26 passou. [Isolamento e persistência dos Previews](https://developers.cloudflare.com/workers/previews/resources/), [configuração e secrets](https://developers.cloudflare.com/workers/previews/configuration/), [limites](https://developers.cloudflare.com/workers/previews/).

**Pendentes:** capacidade/permissões/schema no preview existente, writers ativos/Node-Coolify, workload8MiB dentro de1000ms, recuperação funcional/rollback remoto, bootstrap e ativação controlada; produção tem gate próprio. CPU configurada não é CPU consumida nem teto de fatura. Sem nova contratação, sem promessa de tetoUS$20. Total formal7/10 e migração principal na Etapa13.
