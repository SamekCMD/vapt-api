# Canário limitado de catálogo — preparação23/10/2026

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
