# Atualização compatível do Preview — 22/10/2026

Último estado23/10: Preview30 `e14728f8-0b1e-4e14-bb36-ae64cbe33321`, após renovação adicional de bearer aprovada e verificada. Sem upload de bundle; flagsfalse/CPU1000/recursos/controles preservados. Smoke começou, mas parou no primeiro owner por assert do operador sobre campo ausente no DTO operacional; cleanup e conexão READ ONLY independente confirmaramzero. Corrigido localmente, diagnóstico pontual Astra medium e regressões225operadores/701API passaram; matriz remota permanece incompleta. Relatório atual: `tenant-preview-smoke-2026-10-22.md`. Não repetir publicação/SQL/rotação por inferência; implantação29 e28 abaixo são histórico.

## Atualização de credencial23/10

Após a publicação compatível28, a renovação aprovada do bearer de teste criou somente o Preview29 `0adb3258-57f0-4ef6-a155-1259780d17b4`, por PATCH de secret, sem upload de bundle. Campos de runtime/bindings/limites preservados; Access/R2privado/HDpreviewcacheoff e inspect conferidos independentemente. Reader/writerfalse, CPU1000; produção/web/top-level sem novas implantações. O smoke autenticado não começou porque o operador confundiu amostra de startup e URL por implantação com configuração estável. Correção local RED→GREEN/221operadores/701API; credencial em memória descartada na parada. Nova renovação para o smoke precisa de aprovação própria, sem replay de SQL ou deploy. Registro atual: `tenant-preview-smoke-2026-10-22.md`. As referências a28 abaixo descrevem a publicação de código anterior.

## Resultado final: atualização aprovada concluída

Uma única chamada de publicação, a partir do commitAPI`7689ec5d3bcef1e6e3d7ad6ff47872927f4e4b73`, atualizou o Preview existente para **implantação28**, ID`fca1102f-05b4-488e-bc6a-11d1f82e0bd9`; anterior27`7b51fca2-207e-4e29-948e-159761b362ea`. Upload e GET independente do provedor coincidiram; um `inspect` adicional somente-leitura confirmou a28 depois. Não executar `publish-compatible` novamente: o guard one-shot rejeita esse novo baseline; `inspect` continua disponível.

Preservados namespace catálogo`eeda94fea90349be8b62b82067c79b27`, realtime`69fbe1f54ad64a93b7cb761910da094a`, nove secrets por nome/tipo, seis rates, CPU1000, mesmos Hyperdrive/buckets/vars e URL. Reader/writerfalse/activationReadyfalse; workload/CPU não certificado. Antes/depois passaram GET anônimo302→login Access, r2.devfalse/zero domínios no bucket de catálogo e origem Hyperdrive direta do endpointpreview/databasevapt/rolevapt_api_preview/cache desativado. Não significa verificar identidade SQL através do Worker, fluxos autenticados ou ACL de imagens.

Os controles de deployments da APIproduction, frontendweb e paralelo top-level permaneceram idênticos. Não houve novo namespace/bucket/secret/token/plano, SQL, fixture, email/pagamento, alteração de DNS/main, publicação de frontend/consumidor ou produção. A autorização foi só essa atualização inerte; a28 contém a API tenant candidata, mas não equivale a smoke remoto aprovado. Próximo gate: validar o fluxo autenticado e compatibilidade dos clientes/consumidor, mantendo catálogo desligado; CPU/workload/writers/bootstrap e produção continuam separados. Catálogo7/10/MainEtapa13 ainda abertos.

Testes frescos antes da publicação: operador41/41, todos os scripts202/202, API701/701 e buildTypeScript0. Não se atribui CI novo aos commits locais; não houve push/merge neste gate. Os relatos seguintes preservam o desenho e a preparação anteriores à publicação, não indicam uma chamada ainda pendente.

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

## Checkpoint anterior à publicação — histórico

Operador/testes preparados e verificados; publicação ainda não executada neste checkpoint. Revalidar o baseline e salvar commit antes da única chamada autorizada. Mesmo após sucesso de control plane, smoke autenticado/CPU-workload/writers/bootstrap/produção continuam gates próprios; `activationReady=false` e ambas as flags devem permanecerfalse.
