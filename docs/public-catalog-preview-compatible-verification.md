# Atualização compatível do Preview — 22/10/2026

## Escopo aprovado e preparação

O usuário respondeu “continuar” à proposta explícita de ajustar o publicador e, após testes, publicar uma única vez somente no Preview existente`stage11-inert`. Não autoriza produção/frontend/main/DNS, flags, bootstrap, SQL adicional, credenciais novas, namespace/bucket/plano novo ou observabilidade persistida.

Contexto anterior: gate SQL preview009–012/quatro grants concluído em22/10, com backup/restore/PG93 e conexão limitada comprovados no relatório do repositório produto`docs/infra-migration-preview-schema-gate-2026-10-22.md`. Não repetir migrations. A API ainda publicada no Preview é a implantação27, anterior à paridade tenant; a nova publicação usa o código tenant já presente neste branch.

`node scripts/catalog-preview-inert.mjs publish-compatible` é ação distinta e **one-shot**. Exige o mesmo PreviewID`56efdbf131174b8fba43387369c6f1e3`, baseline27`7b51fca2-207e-4e29-948e-159761b362ea`, tag já registrada e namespace catálogo`eeda94fea90349be8b62b82067c79b27`. Depois exige geração28, novo deploymentID e os mesmos namespaces. Uma segunda tentativa recusa o baseline diferente. `inspect` e o `apply` antigo preservam o comportamento somente-leitura quando já preparado; aliases genéricos continuam bloqueados.

Antes/depois: vars/flagsfalse, nove secret_text por nome/tipo, seis rates, CPU1000, Hyperdrive e buckets exatos, namespace realtime`69fbe1f54ad64a93b7cb761910da094a`, telemetry/logpush/tails desligados. GET anônimo sem seguir redirect deve levar ao login Cloudflare Access; bucket catálogo deve ter r2.devfalse/zero domínios; Hyperdrive deve usar databasevapt/rolevapt_api_preview/origem direta do endpointpreview/cachefalse. Origem e papéis não são inferidos somente do ID do binding. Metadados ficam em memória; nenhum valor de secret/token/Location é impresso.

São feitas somente consultas GET de controle e uma chamada Wrangler preview fixa, com stdout/stderr capturados, logs em disco/métricas desativados. Produção API, web e top-level paralelo são comparados antes/depois. Não cria Service Token, sessão persistente, fixture ou efeito de email/pagamento. Erro depois de tentar publicar resulta em estado incerto e exige readback manual; nunca retry/repair/rollback automático ou retorno cego a código owner-only.

## Provas locais desta alteração

- TDD:23pass/11fail com a ação ainda ausente →34/34; sete casos de Access/R2/Hyperdrive ausentes falharam →41/41.
- Suíte completa de scripts202/202, API701/701 e buildTypeScript exit0. Testes de provedor usam respostas sintéticas; não são deploy real nem smoke autenticado.
- Código de runtime/config/schema não foi alterado por este ajuste de operador. F383/PG93/workerd30 continuam evidências anteriores, não novas execuções desta alteração.

## Situação antes da publicação

Operador/testes preparados e verificados; publicação ainda não executada neste checkpoint. Revalidar o baseline e salvar commit antes da única chamada autorizada. Mesmo após sucesso de control plane, smoke autenticado/CPU-workload/writers/bootstrap/produção continuam gates próprios; `activationReady=false` e ambas as flags devem permanecerfalse.
