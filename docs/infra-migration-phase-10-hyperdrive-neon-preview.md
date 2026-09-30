# Stage 10 — API Worker → Hyperdrive → Neon preview

Status em 30/09/2026: aceite de **preview** concluído. A API em Coolify
continua servindo o produto. Esta etapa não moveu tráfego, criou rota pública,
configurou Cron ou alterou DNS, Stripe Live, R2 ou o Worker de produção.

## Recursos e isolamento

- Projeto Neon: `dawn-morning-27332079`; branch `preview`:
  `br-rough-dew-b6ydeygb`; database: `vapt`.
- Role de login dedicada: `vapt_api_preview`, sem atributos administrativos,
  ownership ou membership herdado. Os grants versionados estão no repositório
  principal, em `infra/neon/006_worker_preview_role_grants.sql`; o verificador
  é `infra/neon/verify-worker-preview-role.sql` (commit `973eaaf`).
- Hyperdrive de preview: `vapt-api-neon-preview`, ID
  `0c05fec2924b4f3b9225f3d689ba7ea9`, conta Cloudflare
  `3ce69408aa5112617a282957aba71932`. O alvo lido de volta pela API é o
  endpoint **direto** `ep-hidden-bird-b673zocn.c-2.sa-east-1.aws.neon.tech`,
  database `vapt`, role `vapt_api_preview`, cache de query desativado e limite
  configurado de cinco conexões de origem. Não há endpoint Neon `-pooler` em
  cascata.
- O ID está somente em `wrangler.worker-probe-preview.jsonc`. Essa configuração
  isolada mantém `workers_dev: false`, `preview_urls: false`, sem rota ou Cron.
  O Worker de produção não recebeu esse binding.
- A branch Neon `production` (`br-odd-term-b6j2n9ms`) foi consultada apenas
  para verificar que `vapt_api_preview` não existe nela. Nenhum grant, schema
  ou dado de produção foi alterado na Stage 10.

## Evidência de execução

O pool `pg` é criado por invocação, com `max: 1`, e alimenta o mesmo contrato
`Database` usado por Kysely, Better Auth e `withTransaction`. O diagnóstico
é uma entrada separada com operações fixas e token obrigatório validado antes
da criação do pool. Ele não aceita SQL, URL, email ou provider do solicitante.

Verificações locais finais:

| Comando / verificação | Resultado |
| --- | --- |
| `npx tsx --test src/worker/hyperdrive-probe-operations.test.ts` | 9/9 |
| `node --test scripts/verify-hyperdrive-preview.test.mjs` | 4/4 |
| `npm test` | 436/436 |
| `npm run test:worker` | 15/15 |
| `npm run build` | exit 0 |
| `npm run build:worker` | exit 0 |
| `npx wrangler deploy --dry-run --config wrangler.worker-probe-preview.jsonc` | exit 0; binding preview esperado |

Um ensaio direto com a role limitada, antes do Hyperdrive, já havia confirmado
`INSERT`/`SELECT`/`UPDATE`/`DELETE` reversíveis em Better Auth, função
permitida e rejeição de DDL/leitura alheia com SQLSTATE `42501`. Esse ensaio
**não** foi contabilizado como prova do Hyperdrive.

Três sessões temporárias de `wrangler dev --remote` usaram o Hyperdrive real:

1. SQL: POST sem token retornou `401` com `no-store`; o autenticado confirmou
   database `vapt`, usuário `vapt_api_preview`, query parametrizada, ausência
   após rollback, visibilidade após commit e limpeza da linha sintética.
2. Better Auth e conexões: uma invocação criou usuário/sessão sintéticos; uma
   nova invocação resolveu a sessão pelo `AuthRuntime.getSession`; após
   revogação, outra invocação a encontrou ausente. A consulta administrativa
   confirmou zero usuários e sessões sintéticos. Cinco invocações seriais
   concluíram em 397 ms no total e três queries concorrentes em 363 ms,
   todas sem erro ou espera indefinida. `pg_stat_activity` observou 3 conexões
   da role antes e 5 depois, dentro do limite configurado de origem. Pooling
   pode manter conexões abertas; esse dado não significa vazamento nem prova
   comportamento sob carga sustentada.
3. Agendamento equivalente: depois de confirmar outbox de efeitos vazia, a
   operação fixa `reconcile` chamou `runScheduledReconciliation` uma vez.
   O resultado reclamou zero efeitos, e a outbox terminou com zero linhas;
   nenhum provider foi chamado e nenhum intervalo ou Cron foi iniciado.

A auditoria final repetiu o verificador SQL na preview, confirmou zero
usuários/sessões/linhas de verificação sintéticos e zero efeitos de pagamento,
leu a ausência da role na branch production e releu os metadados do
Hyperdrive. Todas as sessões remotas foram encerradas. Cada token aleatório
foi fornecido por arquivo `.dev.vars` ignorado pelo Git, criado somente para
a sessão e removido no encerramento; a ausência do arquivo foi conferida em
disco. Nenhuma senha, URI completa, token de sessão, destinatário ou segredo
foi incluído em código, Git, saída do verificador ou neste handoff. A senha da
role foi rotacionada em memória e enviada diretamente ao campo write-only da
API Cloudflare na criação do Hyperdrive; não há cópia local recuperável.

## Limites e próximo gate

O aceite cobre seis critérios do design de preview: isolamento/ACL, conexão
Hyperdrive remota real, SQL/transação, persistência Better Auth, invocações
repetidas/concorrentes mais passe agendado limitado, e higiene de segredos.
Ele não valida tráfego de clientes, throughput sustentado, rota pública da API
completa nem Worker de produção. O smoke opcional da entrada de produção foi
omitido porque não se comprovou que sua URL temporária poderia ser restringida
**antes** de qualquer request; abrir todas as rotas não era necessário para
este gate.

Para a Stage 11, revisar este handoff e planejar separadamente a role e o
Hyperdrive da branch Neon `production`, os secrets/bindings de produção, a
execução paralela da API e o cutover controlado. Não reutilizar o ID de preview
como binding de produção. Coolify permanece o caminho ativo enquanto isso.
