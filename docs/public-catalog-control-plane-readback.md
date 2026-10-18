# Catálogo — readback preparatório do control plane

Atualização posterior ao readback preparatório: a autorização específica foi recebida e a preparação inerte do Preview concluída. [Deployment/namespace/limites e alcance](public-catalog-preview-inert-verification.md). O top-level não foi modificado; a proposta no final deste registro não é mais uma pendência de autorização para essa preparação já executada. Ativação/workload e os demais ambientes continuam fora do escopo.

18/10/2026. Consultas somente leitura via Wrangler local4.138.0, conta `3ce69408aa5112617a282957aba71932`. Sem endpoints de negócio, SQL, download do código publicado, secrets, logs de requisições ou escrita no provedor. Valores/identidades de usuários e credenciais não foram emitidos. Heads locais: API `385b74f`, frontend `1395ce5`.

## Metadados encontrados

`deployments list --json` não deve ser interpretado como “o primeiro é o atual”: a resposta observada estava em ordem cronológica crescente. Para estes resultados, a seleção usou a maior `created_on` entre as dez implantações retornadas, depois `versions view --json`. Não é um novo validador completo de runtime/tráfego.

| Worker | Implantação mais recente entre as retornadas | Versão / percentual | Data UTC |
| --- | --- | --- | --- |
| `vapt-api-production` | `68828632-0b50-4c80-b6d1-2c43a6736760` | `914f79f0-b679-45a2-a0c0-069acd87aa23` /100% | 09/10/2026 17:12:06.784913 |
| `vapt-web` | `24d1b0fc-dda0-4789-a426-4146c9cad04d` | `e77339dd-59ea-44dd-a790-660076570810` /100% | 09/10/2026 16:57:06.260981 |

Na versão da API, o readback encontrou:

- `ENVIRONMENT=production`, `REALTIME_ENABLED=true`, `STRIPE_ENVIRONMENT=test`.
- Hyperdrive `HYPERDRIVE` ID `2885c609a66641b3b716190c2d467902`.
- Imagens `R2_BUCKET` → `vapt-assets-production`.
- `RESTAURANT_REALTIME` → classe `RestaurantRealtime`, namespace `d3ad7a4008c64124b765f934986956da`.
- Nenhum `PUBLIC_CATALOG_BUCKET` ou `PUBLIC_CATALOG_COORDINATOR` na lista retornada; as duas vars novas do catálogo também não estavam presentes. Não inventar valores observados nem tratar ausência como prova do código interno publicado.

O Worker web não retornou esses bindings/vars. Flags compiladas no bundle não são verificadas por isso; não inferir quais clientes estão ativos ou cobertura de writers.

Uma consulta separada ao **top-level** `vapt-api-parallel` retornou a implantação `29cbfb3b-7a76-448e-a984-aeb80fc5bde9`, versão `ce6f3919-1d9e-4b43-8914-865d7597619c`, de30/09/2026. Isso **não** é readback do Preview nomeado `stage11-inert`; não usar esse ID para publicar ou validar seu rollback.

## Preparação local conferida

Os checks das candidatas preview/production passaram; continuam `activationReady:false`, com lista conservadora de pendências que não consome automaticamente o ledger. `npm run build:worker-catalog-production` passou no head acima, terminou em `--dry-run: exiting now`, `deployed:false` e `activationReady:false`. Isso empacota as correções recentes, mas não prova os bindings do Preview nomeado ou CPU por invocação. Nenhum teste unitário foi rerodado para esta atualização documental; as suítes completas do checkpoint anterior permanecem evidência datada, não uma execução nova.

## Próximo limite operacional

Para avançar além da preparação local será necessária autorização específica para uma implantação **inerte somente no Preview existente**: registrar a migração append-only/classe SQLite e ligar o bucket privado já criado, mantendo reader/writerfalse. Não executar esse passo a partir de um “check verde”, contornar o operador bloqueado ou confundir registro de classe com ativação do catálogo. Produção/frontend, tráfego/DNS, secrets, schema/SQL, bootstrap e flags não entram nessa autorização proposta.

Esse passo não exige outro plano pago, mas recursos/uso Cloudflare não têm teto financeiro global garantido. Não apagar ou recriar namespace para rollback. Só depois do readback próprio do Preview e dos demais gates considerar a validação do workload/CPU e bootstrap; capacidade Neon não foi consultada ou modificada nesta leitura.

Não comprovado aqui: consumo/CPU1000ms, schedules ativos, ingress/Access, ACL atuais dos buckets, código/hash publicado, grants/Hyperdrive em execução, ausência de writers Node/Coolify, paridade de consumidores, CI ou rollback remoto. Total formal permanece7/10; não houve ativação.
