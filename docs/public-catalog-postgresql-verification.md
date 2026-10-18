# Catálogo — integração PostgreSQL local

Evidência inicial de17/10, revalidada em18/10/2026 com **11/11** testes. PostgreSQL **18.6**, Windows x64, listener somente `127.0.0.1`, cluster descartável dentro da pasta ignorada do projeto. Nenhum SQL, credencial, role, branch ou recurso remoto foi usado ou alterado. Sem instalação global, serviço Windows ou alteração de PATH; instância encerrada em `finally` depois dos testes.

## Execução reproduzível

O teste versionado é `src/modules/catalog-publication/transaction.pg-integration.ts`. Em um PostgreSQL local descartável, criar uma base vazia de nome `vapt_catalog_test_<sufixo>` e fornecer sua conexão por `CATALOG_TEST_DATABASE_URL`, apenas no ambiente do processo de teste. Não imprimir o valor nem usar credenciais de produção. Executar a partir da raiz da API:

```text
node --import tsx --test src/modules/catalog-publication/transaction.pg-integration.ts
```

`CATALOG_SCHEMA_ROOT` aponta para `infra/neon` do repositório frontend; o padrão `../../infra/neon` atende ao worktree atual. O teste recusa conexão ausente, remota, base de outro nome, parâmetros de redirecionamento e fragmentos. Não usa `DATABASE_URL` implicitamente. Aplica os SQLs001/003/004/009 somente quando a base isolada está vazia; limpa apenas as linhas da fixture identificada por UUID.

O harness operacional desta execução inicializou um cluster novo, gerou senha aleatória em memória, entregou-a ao `initdb` por named pipe efêmero, escolheu porta local livre e encerrou o servidor ao final. Binários obtidos pelo [link oficial de ZIP do PostgreSQL](https://www.postgresql.org/download/windows/) para a [EDB](https://www.enterprisedb.com/download-postgresql-binaries): pacote `postgresql-18.6-5-windows-x64-binaries.zip`. SHA256 local `e2246ba91d22345bc3d017586c09ede52d9df180b1eeb480f050445f1cad84e2` é apenas identificação do download, **não** comparação com checksum independente publicado; executável sem assinatura Authenticode. Nenhum pacote ou dado de cluster entra no Git.

## Resultado SQL real

Dez testes, zero falhas (teste principal e nove subtestes; os três cenários imagem/SQL foram acrescentados na continuação de17/10):

- Onboarding concorrente: três tentativas, um restaurante, um primeiro item e um journal; mesma resposta recuperada. Falha SQL no journal reverte o domínio e não deixa operação gravada.
- Criação e exclusão concorrentes de item: efeito único por operação, sem duplicação; mesma chave com outro payload retorna409.
- Snapshot UTF8 acima de8MiB: alteração de domínio, revisão e journal não são confirmados. Snapshot aceito permanece dentro do limite.
- Dois donos disputando o mesmo slug: um sucesso e um409; após liberação, o novo dono recebe revisão global maior que a do anterior.
- Sessão realmente expirada no banco: rejeição antes da mutação, mesmo com expiry futuro no comando aceito.
- Sessão apagada enquanto o comando realmente aguarda advisory lock: nenhuma mutação/journal. Trabalho já confirmado continua recuperável após revogação; nova operação é recusada.
- Limpeza oportunística de101 entradas expiradas remove somente100; chave vencida pode ser reaplicada com revisão nova, não é tombstone permanente.

### Concorrência entre imagem e catálogo

`src/worker/catalog/image-service.pg-test-support.ts` é importado somente pelo teste de integração acima. Exercita o applier e o serviço reais contra o mesmo PostgreSQL, com conexões concorrentes e SQLite real de quota. **Sem fila JavaScript compartilhada** entre as duas operações: a serialização precisa ocorrer pelos locks SQL, cuja espera é observada em `pg_stat_activity`. Armazenamento e leitura dos snapshots são adapters controlados, não R2 real ou emulação de consistência do provedor.

- Exclusão primeiro: a remoção física é pausada por uma barreira de I/O; a associação concorrente realmente espera no PostgreSQL e ainda não valida a imagem. Ao concluir a exclusão, a associação é recusada com410, sem logo/journal novo e sem ressuscitar o objeto. A quota só é liberada após a remoção.
- Associação primeiro: a validação de imagem é pausada sob a transação SQL; a exclusão concorrente espera. Depois do commit, a exclusão relê a revisão e é recusada enquanto a projeção está atrasada. A imagem segue protegida quando referenciada pelo snapshot atual **ou pelo anterior**. Só depois de duas revisões sem referência a limpeza passa e libera quota.
- Logout concorrente: a exclusão da sessão espera a limpeza já autorizada terminar sua alteração física. Uma nova limpeza depois da revogação retorna401, sem nova mutação de armazenamento.

Em18/10 o primeiro cenário foi executado também pela nova **reconciliação manual de leases expiradas**, sem filaJS compartilhada. O attachment realmente espera o lock SQL enquanto a reconciliação está pausada no DELETE físico; após a retirada, recebe410 sem gravar logo/journal ou ressuscitar objeto. A quota é liberada depois da retirada. O relógio da seleção de candidatos é controlado, mas PostgreSQL, espera do lock, applier e SQLite são reais. O harness voltou a aplicar os dois grants009 e confirmou privilégios extras negados; servidor local encerrado ao final.

Esses testes passaram contra o comportamento já implementado; não foi necessária alteração da lógica de produção. São prova de integração/locks, não red→green de correção nova. Testes R2/SQLite/hibernação em workerd continuam em harness separado. Não equivalem à composição completa DO+Hyperdrive+R2 remotos nem comprovam deadlines/CPU sob carga.

## Grants009 — prova separada no mesmo cluster descartável

Os arquivos de grants exigem o nome `vapt`. Para não enfraquecer esse guard nem apontar o teste transacional para uma base normal, o harness criou **outra base `vapt` apenas no cluster recém-inicializado**, mais duas roles locais `NOLOGIN`, sem superuser, criação de roles/bases, replicação, bypassRLS ou membership. Não são as roles remotas.

SQL001/003/004/009 e ambos `009_worker_*_catalog_grants.sql` foram executados sem edição. `verify-public-catalog-publication.sql` confirmou journal, revisões, sequência e os acessos de ambas as roles. Asserções SQL adicionais confirmaram SELECT/INSERT/DELETE no journal e USAGE na sequência, com UPDATE/TRUNCATE/TRIGGER do journal, reset da sequência e CREATE no schema negados. Tentativas reais de DDL, UPDATE no journal e `setval` sob cada role falharam com42501.

Isso valida os grants incrementais009, não substitui auditoria das permissões anteriores006/007 nem prova Hyperdrive/Neon remoto. Não há autorização de migração ou ativação implícita.

## Limites desta evidência

Transações foram exercitadas pelo pool administrativo **local da fixture**, não por credenciais remotas. Os grants009 têm prova separada acima. A suíte normal `npm test` não inclui este arquivo; é obrigatório executá-lo explicitamente. A prova workerd usa outro harness e journal sintético, não deve ser confundida com este PostgreSQL real. CPU8MiB sob o limite Workers1000ms, privacidade dos buckets remotos, writers ativos, deploy, bootstrap e revisão final continuam gates independentes.
