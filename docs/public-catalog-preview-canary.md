# Canário limitado de catálogo — preparação23/10/2026

## Resultado24/10 — janela encerrada, não repetir

Controlador único818e361c-9c49-4b88-ad9e-b969047e213c exit0:32→33 `94e5ffe9-75a3-418d-87bc-82eb267614c2`, um rebuild real de8388608bytes chegou a ready/committed/não-retryable;33→34 `55463f0b-4582-46ea-b2c5-475864e3d001` fechou writer. Readerfalse/CPU1000/recursos/controles preservados. Logout/cookie antigo401, três fences privados270bytes confirmados, journal exato removido, strict tenantcleanup e nova conexão TLS READ ONLY11 contagenszero. Sem novo bundle, produção, DNS/main, plano, email ou pagamento. Fonte de preparação9d812a4; resultado/scope detalhados no frontend `docs/infra-migration-catalog-preview-canary-2026-10-24.md`.

Telemetria posterior somente leitura atribuiu o objeto `bd452a8868486ef71a14fb70bc060916f6951b92ce79eddc95e157c858bea8e3`/nome `preview:8572dc6c-84b2-4b12-8099-934204cc21eb`/namespace e versão33 exatos:1jsrpc21,436ms e1alarm517,895ms; Worker2requests/max171,613ms. Todos sampleInterval1/zero erros. P99/P999 DO coincidem por haver uma chamada em cada grupo, não representam um benchmark de carga nem máximo futuro. A lista administrativa DO retornou0 apesar desses eventos: não é prova de ausência de armazenamento; ela impediu a coleta inicial, mas não repetimos o teste para conseguir CPU. Resultado original conservado; análise posterior `publicationCasePassed:true`, `fullCpuGatePassed:false`/`activationReady:false`.

O ensaio cobre publicação da fronteira interna com uma descrição grande, não todas as formas de catálogo nem reader R2/frontend. Não repinar/reexecutar `openCatalogPreviewCanary`, não remover marcador exclusivo e não recuperar bearer write-only. Condições de preparação abaixo são históricas e já foram atendidas nessa janela; leitor/outros formatos/bootstrap/produção permanecem gates próprios. Metadados terminais DO e fences pequenos retidos por segurança, não apagar namespaces para fabricar “cleanupzero”.

## Checkpoint24/10 — limpeza específica pronta localmente

`catalog-canary-fixtures.mjs` prepara um snapshot interno de exatamente8MiB com o DTO real, IDs/tag próprios e próxima versão prevista; não relaxa schema HTTP nem avança a sequência para adivinhar um ID. Segunda preparação, journal/revisão anterior ou identidade divergente são recusados. A chamada real deverá confirmar a versão; nenhuma colisão provoca outro comando automático.

Após admissão fechada e receipt terminal/committed/não-retryable do único comando conhecido, o operador confere snapshot/manifesto/slug exatos. Substitui somente esses três objetos por fences pequenos, com leitura após cada PUT e nova conferência final; não usa DELETE e não apaga o namespace DO. Perda de resposta ou fence não confirmado interrompe antes de remover SQL. As marcas de retirada conservam a proteção create-once contra um PUT atrasado, sem reter o conteúdo8MiB nem tocar imagens.

Só então remove o journal exato por operation/actor/restaurant/version/fingerprint, sob transação/locks/readback. Uma segunda operação mesmo no tenant sintético aborta antes de DELETE. A limpeza tenant anterior permanece intacta e continua recusando journals; após a remoção específica, ela retira as identidades/unidades conhecidas e a revisão cai pela FK. Uma resposta COMMIT perdida é classificada incerta, sem retry ou remoção automática de identidades.

Prova local fresca:9/9 testes de retirement,8/8 novos testes PostgreSQL18.6 real (incluem COMMIT perdido, pendência, versão/receipt/fence incorretos, segunda preparação e comando extra),272/272 scripts,701/701 API, zero skips/falhas, compilação/checks exit0. O helper PG existente ganhou apenas `--only=catalog-canary`, que roda exclusivamente a nova suíte em cluster loopback no scratch deste plano; não repete93 testes antigos, não altera Neon nem instala serviço. Clusters foram parados; dados locais de diagnóstico conservados.

Controlador one-shot privado preparado no scratch `catalog-canary-controller-2026-10-24.mjs`: marcador exclusivo,15min, até20 HTTP, um rebuild, até3 GETs de status sem resubmissão, closer em finally, logout, fences, cleanup e nova conexão TLS READ ONLY. Credenciais em RAM; sem conexão PG mantida enquanto aguarda Access. Fonte/limpeza local pronta não significa execução remota concluída: o relatório do controlador será a evidência da janela. Gate CPU ainda aberto e reader permanecefalse; a medição planejada cobre publicação, não leitura R2 via frontend.

## Autoridade e estado atual

O usuário respondeu **continuar** ao pedido específico de preparar e executar um canário somente no preview, com writer temporário, reader desligado, dados sintéticos, limpeza verificada, CPU1000ms e nenhum novo serviço pago. Essa autorização foi registrada e não precisa ser pedida novamente para o mesmo escopo. Não autoriza produção, main/push, recurso pago, alteração de schema/grants ou publicação de fixture `/_test/*`.

**Nesta passagem houve apenas preparação local e consultas Cloudflare somente leitura.** Preview32 `35fd7ac3-2601-46bb-adec-39ef46813131` foi conferido, CPU1000 e flagsfalse. Não houve PATCH, nova credencial, autenticação Access, seed/SQL/Neon, R2/DO write ou ativação. Os gates encerrados não foram repetidos.

## Operador preparado e testado, ainda não invocado remotamente

`scripts/catalog-preview-canary.mjs` exporta somente `openCatalogPreviewCanary`; não cria alias CLI de ativação nem enfraquece os blockers genéricos. O controlador deverá fornecer bearer aleatório somente em RAM e consumir a função `close` em `finally`, inclusive quando uma abertura confirmada retornar falha de pós-conferência externa.

- Abertura exige exatamente Preview32/ID acima, CPU1000, reader/writerfalse, mesma migração/DOs/segredos/bindings/rates, Access exigido, bucket privado e Hyperdrive direto/restrito/cache desligado. Valida novamente o deployment imediatamente antes de escrever.
- Único PATCH de abertura: writertrue e renovação write-only do bearer deste Preview, clonando o código atual; resultado deve ser33/novoID. Nenhum bundle ou override de CPU/reader é enviado. A identidade/recursos/limites são comparados no readback; deployments production/web/paralleltop-level permanecem controles.
- Fechamento único exige o ID33 efetivamente confirmado e o mesmo estado do deployment; PATCH somente writerfalse, resultado34. Mantém executor/migração de comandos já aceitos. Não depende de disponibilidade das métricas para fechar a admissão.
- Falha de controle/metadados externos depois de confirmar o próprio33 conserva um closer estritamente limitado a esse deployment. Se o34 for confirmado, informa `admissionClosed:true` mesmo quando uma pós-conferência externa falhar, sem declarar o canário aprovado. Não sobrescreve esses metadados externos.
- Resposta perdida, deployment concorrente, binding/CPU inesperados ou escrita não confirmada não são reparados/repetidos automaticamente. `writerMayBeActive:true` exige diagnóstico somente leitura antes de qualquer ação adicional; não equivale a rollback realizado.
- `cleanupVerified:false`, `cpuWorkloadVerified:false` e `activationReady:false` são preservados: este operador só controla admissão, não certifica o workload nem a remoção das fixtures.

19 testes novos passaram, incluindo rejeições pré-write, corrida antes do PATCH, deriva de recursos/segredos/reader/CPU/controle, close incerto, ausência de retry e fechamento limitado após falha externa. Testes incluídos no alias `test:catalog-config` já consumido pelo CI. Execução local não é CI remoto aprovado. Os primeiros11 testes foram vistos falhar por ausência da função; os dois casos de closer foram RED→GREEN separadamente. O teste inicialmente bloqueado pelo spawnEPERM foi executado com `--test-isolation=none`, não contado como RED funcional.

Verificação final desta preparação: **263/263** testes de scripts, **701/701** testes unitários API, zero skips/falhas e exit0; compilação TypeScript, `node --check` do operador e `git diff --check` também exit0. Logs `catalog-canary-all-mjs-final-2026-10-23.log`, `catalog-canary-api-final-2026-10-23.log` e `catalog-canary-build-2026-10-23.log` no scratch próprio. Suítes frontend/PG/workerd históricas não foram repetidas: nenhum produto/SQL/fixture runtime foi alterado. Não é prova de canário remoto.

## Medição remota disponível sem ligar logs

A introspecção autenticada do GraphQL oficial confirmou:

- Worker: dimensões `isPreview`, `previewSlug`, `scriptVersion`; `max.cpuTime` em **microssegundos**, quantis CPU e `avg.sampleInterval`.
- Durable Object: mesmas dimensões, `namespaceId`/`objectId` e quantis CPU em microssegundos. O tipo `max` desse dataset **não oferece máximo de CPU**; não inventar esse campo nem chamar P99 de máximo. Há CPU periódica agregada, que também não é CPU exata por chamada.
- Consulta real filtrada por script `vapt-api-parallel`, `isPreview:1`, slug `stage11-inert`, namespace de catálogo `eeda94fea90349be8b62b82067c79b27` e janela22/10 20:01:14Z–23/10 20:01:14Z foi aceita. Não criou tráfego de workload.

Nessa janela histórica, a versão32 apresentou75 requests estimados, zero erros, sampleInterval1 e P99/P999153073µs (=153,073ms); a31 teve sampleInterval1,13636. São dados anteriores ao canário, **não benchmark do catálogo8MiB nem teto financeiro**. O dataset DO do catálogo estava vazio. O teste de amostragem deve rejeitar ausência de dados, versão/instância incorretas e cobertura insuficiente, não reportar zeroCPU.

Uma CPU baixa no Worker HTTP não certifica a CPU do coordenador DO. O resultado deverá separar ambos, relacionar os contadores locais à telemetria atrasada/amostrada e manter o gate aberto se não houver atribuição/cobertura suficientes. Não elevar limite para forçar sucesso. A [documentação oficial de preview](https://developers.cloudflare.com/workers/previews/test-and-debug/) descreve as métricas filtradas e informa que `wrangler tail` não suporta Previews; não criar Tail Worker/log persistente/plano pago por inferência.

Artefatos próprios no scratch do plano frontend: `catalog-canary-metrics-preflight-2026-10-23.mjs`, `catalog-canary-metric-schema-2026-10-23.json`, `catalog-canary-metric-baseline-2026-10-23.json` e logs de RED/GREEN/suítes. Nenhuma credencial foi serializada. Os payloads de introspecção contêm apenas schema público; resultados contêm IDs públicos, contagens e CPU.

## Condições restantes antes do primeiro PATCH

1. Preparar controlador one-shot com marcador exclusivo, deadline de sessão, limite de requests/operações, sem reprise cega e closer em `finally`. Não chamar o operador isoladamente só para ligar uma flag. Guardar resultado/IDs públicos da abertura antes de qualquer teste; não recuperar bearer de logs/cache/UI.
2. Preparar fixture/limpeza **específicas de catálogo**, com teste local das novas queries. A limpeza existente `tenant-preview-fixtures.mjs` intencionalmente recusa journal de catálogo/outbox inesperados e permanece intacta. Não apagar seu guard nem simplesmente chamá-la após criar comandos.
3. A fixture precisa de IDs/tag próprios, seed confirmado, apenas comandos conhecidos e limites sintéticos. Distinguir snapshot interno de8MiB de dados aceitos pelo formulário normal; não relaxar schemas HTTP. O caso remoto de excesso não deve ser disparado apenas para repetir a fronteira já provada localmente.
4. Antes de remover SQL/objetos, comprovar estado terminal de todos os comandos e admissão fechada; definir readback independente, objetos/versões exatos e retenção de fences quando necessária para impedir ressurreição por PUT tardio. Incerteza de seed/comando/cleanup interrompe o fluxo sem deleção especulativa ou segundo seed. Nenhum cliente/tenant externo entra na limpeza.
5. Somente então obter sessão Access temporária se necessária e executar uma única janela autorizada. Produção/Coolify não precisa ser alterada para essa janela privada; inventário dos writers de produção continua necessário antes do reader de produção.

Catálogo7/10/Etapa13 continuam abertos. O próximo trabalho é completar esse controlador e a prova de limpeza; não solicitar outra aprovação genérica nem repetir migrations, API/Bpublish, tenant68, browser ou os perfis locais encerrados.
