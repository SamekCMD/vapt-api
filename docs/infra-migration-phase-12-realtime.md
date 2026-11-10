# Etapa 12 — Durable Objects/WebSockets

Status em 06/10/2026: implementação, publicação privada, smoke, limpeza e revisão independente validados. Integração pelas branches/PRs existentes; sem merge na main ou cutover production.

## Código e validação local

O código compartilhado de backend/frontend implementa admissão owner/order, tickets de uso único, salas SQLite isoladas por restaurante, WebSocket Hibernation, invalidação após commit, reconexão e recuperação HTTP/polling. Não é necessário reimplementar essas funcionalidades para production; os bindings, namespace, cookies e ativação terão gate próprio na Etapa 13.

As telas cozinha, caixa, menu, drawer e delivery usam o cliente compartilhado. Evidência de navegador local, duas identidades/tenants, acompanhamento público filtrado e limpeza está em [prova local das telas](infra-migration-phase-12-realtime-local-screens.md). Não equivale a navegador remoto com Better Auth/Neon.

Verificações repetidas na Task 9 antes de publicar:

- `npm test`: API **488/488**.
- `npm run test:worker`: workerd **19/19**, transporte/SQLite reais.
- Frontend `npm test -- --maxWorkers=2`: **175/175**, 42 arquivos após o fix pass da revisão (170/170 antes).
- API `npm run build`, frontend `npm run typecheck` e `npm run build:preview`: passaram. O root typecheck do frontend não certifica `tsconfig.app.json`; a comparação mais forte da Task 7 encontrou 21 diagnósticos preexistentes e nenhum introduzido.
- Gates scripts realtime/target/parallel config e runner: **22/22**, incluindo nove testes do runner/fixture.
- `node scripts/verify-realtime-preview-config.mjs wrangler.worker-parallel-preview.jsonc`: `ok:true`.
- Wrangler **4.138.0** `deploy --dry-run --config wrangler.worker-parallel-preview.jsonc`: bundle 4486.69 KiB/gzip 765.57 KiB; **No bindings found** no top-level. Dry-run não é publicação/prova de namespace. Um primeiro comando com `--ignore-base-config` foi rejeitado (flag de Preview, não de deploy); o comando válido acima passou.

## Gate ACL real — Task 8

Endurecido somente `infra/neon/verify-worker-preview-role.sql` no frontend/SQL: allowlist exato dos grants atuais, permissões efetivas de coluna, exclusão de rotinas legadas e propriedade `pg_proc`. A única exceção de EXECUTE fora das sete rotinas de aplicação é a extensão pgcrypto já revisada. Nenhum grant persistente foi ampliado; verificador production não foi editado.

`scripts/verify-preview-acl-regression.mjs` aceita credenciais apenas por stdin JSON, com guard do endpoint direto preview, database `vapt`, owner `neondb_owner` e basename exato do verificador. Alvo production é rejeitado antes de criar pool/conectar. Saída só contém status/contagens/SQLSTATE sanitizado.

No Neon real, o verificador antigo aceitou indevidamente três cenários temporários: SELECT de coluna da outbox excluída, EXECUTE de rotina legada e propriedade de função permitida. Após correção, baseline e três negações passaram **4/4**, com rollback e baseline final verificados. Credencial capturada da CLI Neon autenticada existente, somente em memória/stdin, sem URI em logs/argumentos/arquivos. Não houve mudança persistente de grants, ownership, senha ou schema.

## Configuração e readback remoto

`wrangler.worker-parallel-preview.jsonc` usa o facade `parallel-preview-entry.ts`, preservando o wrapper Access/bearer. Binding local `RESTAURANT_REALTIME` em `previews.durable_objects`; flag backend `REALTIME_ENABLED:true` somente em `previews.vars`. Migração SQLite `stage12-realtime-sqlite-v1`. Sem `script_name`, namespace compartilhado, binding/flag top-level, Cron, Queue ou rota nova. Frontend remoto continua com realtime desligado.

Decisão de implementação: checker parallel anterior foi estendido para admitir somente essa variante exata, conservando o contrato legacy sem DO. Config estática não prova a política Access ou namespace remoto; continuam gates separados.

Readback de 06/10/2026:

- Conta `3ce69408aa5112617a282957aba71932`: Dashboard Workers plans mostra **Free / US$ 0 / Current plan**. GET subscriptions com OAuth retornou 403; não se ampliaram permissões para lê-lo.
- Access app `b319b0a7-bba1-4fbb-b068-7c1cdc8707cd`: scope `vapt-api-parallel`, tipo exclusivo `A Worker's preview URLs`, uma policy Allow/default-deny `f892e8cf-87d0-4356-b0ec-c646b5047e26`, duração 1h. Nenhuma política editada.
- Shell `vapt-api-parallel`: GET settings com **zero bindings**; nenhum deploy production executado.
- Named Preview `stage11-inert`, ID `56efdbf131174b8fba43387369c6f1e3`: publicado por `wrangler preview --name stage11-inert --config wrangler.worker-parallel-preview.jsonc --ignore-base-config --json`. Deployment após a rotação equivalente final do bearer: `cede8793-b761-4124-b326-e0016614e295`; main module `parallel-preview-entry.js`, migration tag `stage12-realtime-sqlite-v1`.
- Namespace `69fbe1f54ad64a93b7cb761910da094a`, nome `vapt-api-parallel_stage11-inert_RestaurantRealtime`, classe `RestaurantRealtime`, `use_sqlite:true`. Binding local apenas no Preview; não compartilhado com production. GET shell settings permaneceu zero bindings.
- Hyperdrive preview `0c05fec2924b4f3b9225f3d689ba7ea9`: endpoint direto `ep-hidden-bird-b673zocn.c-2.sa-east-1.aws.neon.tech:5432/vapt`, role `vapt_api_preview`, cache desativado, limite 5 conexões.
- Neon preview em transação read-only antes e depois do smoke: users/sessions/restaurants/orders/billing events/billing email outbox/payment effect outbox: **todos 0**. A limpeza do driver confirmou zero linhas dos IDs criados; nenhum objeto R2/compra/email foi criado pelo smoke.

## Smoke privado real — Task 9

Autorização de substituição do bearer aceita na continuação. Valor aleatório somente em memória/stdin do Wrangler, nunca no Git/logs. O controlador foi reiniciado para carregar o runner final; houve uma segunda rotação equivalente, ainda somente nesse Preview. Login normal pelo `cloudflared access login --quiet` no app Access existente; sem Service Token, nova policy, túnel ou mudança de permissões. JWT capturado em memória. Exceção operacional documentada: o CLI nativo grava seu cache temporário de Access (1h), fora do Git; os dois arquivos desse app (`token`/`token.url`) criados pelo teste foram removidos após a prova, sem ler/imprimir conteúdo ou tocar outras credenciais. O bearer remoto permanece write-only no Preview autorizado.

`scripts/verify-realtime-preview.mjs` recebe apenas stdin JSON `{baseUrl,origin,accessJwt,bearer}`; os dois destinos são literais e production é negado antes de IO. Usa `ws` existente, headers Access/bearer separados da sessão Better Auth/token de pedido; tickets apenas no subprotocol, nunca query. `WRANGLER_WRITE_LOGS=false`/`WRANGLER_SEND_METRICS=false`. Saída contém status/contagens, não credenciais.

Decisão: módulo operador `scripts/realtime-preview-fixtures.mjs` adicional captura da CLI Neon autenticada existente a URI direct/verify-full apenas em memória. `NEON_CLI_PATH` e `VAPT_REALTIME_FIXTURE_DRIVER` são caminhos de programa, não secrets. O guard exato preview precede construção do pool; não lê/escreve production, schema ou grants. Cria duas contas verificadas com hash Better Auth, evitando email; deleções usam manifest privado, UUID + etiqueta, não arrays editáveis do chamador. Nenhum código fixture é importado pelo Worker.

Resultado remoto: `ok:true`, `cleaned:true`, checks perimeter/admission/tenantIsolation/publicIsolation/kitchen/cashier/reconnect/revocation todos true; **2 tenants, 4 pedidos, 5 upgrades WebSocket 101**.

- Sem Access: 302; com Access sem bearer: 401; com ambos: health200. Ticket sem cookie401, owner de outro tenant403, public token inválido404.
- `public/orders`201 → commit Neon → owner recebe invalidação; nunca pedido do outro restaurante.
- Kitchen PATCH preparing200 → owner topic kitchen + public topic orders apenas do próprio pedido; snapshots HTTP público/cozinha confirmam estado/2 pedidos.
- Atualização do pedido vizinho não chega ao socket público; sequência pública começa1, independente de volume owner.
- Pedido de conta200 → topic table_sessions/check_requested → snapshot caixa check_requested/2 pedidos.
- Desconexão → novo ticket/101 → snapshot HTTP com dois pedidos. Sign-out → cookie antigo ticket401; login novo do mesmo owner + commit ready → socket antigo fecha1008 sem evento novo.
- Conexões fechadas pelo runner; accounts/sessions/restaurants/items/orders/table_sessions criados removidos por cascata/IDs. Segunda consulta read-only confirmou contagens zero, incluindo outboxes.

Etiqueta `stage12-0094ad59-7261-4c08-825e-59b236ca2130`; rooms (nomes públicos, não credenciais): A `66081117-c6d9-4de2-b283-2e055f53c790`, B `1e2ff4f7-84ec-4338-983c-8d5a68abc333`. Usuários removidos: `4a8189ae-c065-40c4-bb66-43083a161595`/`9557e586-ae39-47c5-8e47-15b969d8c2c6`. Nenhum identificador de cliente.

Data Studio confirmou **tickets0/sequences0 em ambos os rooms**, sem DELETE manual/namespace-wide. SELECT: `SELECT (SELECT count(*) FROM realtime_tickets) AS tickets, (SELECT count(*) FROM realtime_sequences) AS sequences;`. IDs reais A `fbd29ab709b92aa45c773803096ae39f5853c8a29914be44d077e66681d891ae`, B `9aa3002ff771a85463fd4d860051df0a38851438c70525c68639a7ba60a1d844`; Overview listou só essas duas instâncias, error rate0% em ambas. Screenshots `vapt-stage12-remote-room-a.jpg`/`vapt-stage12-remote-room-b.jpg` estão fora do Git na pasta de evidências do chat. Namespace retido, sem exclusão/migração destrutiva. Alarmes remotos não são visíveis pelo Data Studio; limpeza de alarmes tem prova workerd local, sem alegar readback remoto desse campo. Métricas do Dashboard têm atraso, não certificam consumo final/fatura futura; nenhum upgrade foi executado.

## Revisão independente e correções finais

Uma revisão fresh-context Astra medium cobriu todos os arquivos da Etapa 12 nos dois repos e integrações relevantes; etapas anteriores mantêm suas revisões separadas. Resultado: zero Critical, dois Important e um Minor. O revisor não executou novamente testes nem mutações remotas. Os dois Important foram confirmados e corrigidos pelo implementador em um único fix pass, sem segunda revisão:

- HTTP pendente podia bloquear a fila de resync ou a admissão indefinidamente. GET agora tem deadline de 15s; ticket POST explícito de 10s; cancelamento inclui leitura do corpo e rejeita conclusões tardias. Troca de identidade/unsubscribe cancela a admissão antiga. Mutations sem deadline explícito mantêm o comportamento anterior. Três regressões observaram RED, depois HTTP/client/hook22/22 GREEN.
- A conta do caixa aberta retinha pedidos/pagamentos antigos. Cada snapshot das mesas invalida também o detalhe selecionado, mantendo divisão/transferência e diálogo de pagamento; transferência externa atualiza mesa e fechamento remoto remove o modal. Leituras descartadas são canceladas. Duas regressões observaram RED, depois cashier7/7 GREEN.

A primeira suíte completa encontrou duas regressões de timing (`realtime-auth` e `stripe-billing`): o wrapper adiava o início do fetch por um microtask. Corrigido preservando a chamada imediata, sem afrouxar testes. Suíte final frontend175/175; API488/488, workerd19/19, guards22/22, builds e root typecheck passaram. Comparação in-memory de `tsconfig.app.json`: baseline21, atual21, introduzidos0. Diff atual passou; whitespace histórico de três documentos frontend permanece explicitamente fora desta correção.

Minor adiado: limites superiores baseados no relógio local podem rejeitar ticket/lease válidos quando o dispositivo está atrasado alguns segundos. Mantém fallback HTTP/polling; tolerância de clock skew não alterada nesta etapa. Browser remoto/Coolify/cutover e dívida TypeScript preexistente continuam gates separados, não certificações desta revisão.

Controlador operador encerrado após limpar referências em memória; cache nativo temporário deste app removido. Nenhuma credencial foi adicionada aos commits.

Não há aceitação production, paridade Coolify nem integração de navegador remoto certificadas. Não mudar planos pagos, domínio, DNS, tráfego ou Cron nesta etapa. Integração proposta em API PR 1/frontend PR 4; falta consolidar billing PR 3, pois nenhuma main recebe automaticamente todos os commits. Worktree preservado para feedback; nenhum merge/main/cutover autorizado neste gate.

Rollback previsto: desligar flags/restaurar somente named Preview; manter polling. Não apagar namespace, branch ou bucket amplamente, nem executar migração destrutiva de classe como rollback trivial.

Atualização posterior, preparação Etapa13 em06/10/2026: frontend/SQL incorporou integralmente billing c890f9d pelo merge558ae83 à branch codex/infra-foundation. PR4 agora contém billing+realtime; PR3 original preservado. API runtime/grants e recursos remotos não alterados. Frontend175/175, API488/488, billing45pass/2Postgres não executados e dry-runs billing preview/production passaram; revisão focada sem achados. A pendência histórica de consolidação acima foi resolvida, não o cutover. Registro atual no frontend docs/infra-migration-phase-13-consolidation.md.
