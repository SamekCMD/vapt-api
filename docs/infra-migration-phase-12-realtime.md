# Etapa 12 — Durable Objects/WebSockets

Status em 06/10/2026: Tasks 1–8 concluídas; Task 9 em preflight, **sem publicação realtime remota ainda**. Não declarar a etapa concluída antes do smoke privado, limpeza e revisão independente final.

## Código e validação local

O código compartilhado de backend/frontend implementa admissão owner/order, tickets de uso único, salas SQLite isoladas por restaurante, WebSocket Hibernation, invalidação após commit, reconexão e recuperação HTTP/polling. Não é necessário reimplementar essas funcionalidades para production; os bindings, namespace, cookies e ativação terão gate próprio na Etapa 13.

As telas cozinha, caixa, menu, drawer e delivery usam o cliente compartilhado. Evidência de navegador local, duas identidades/tenants, acompanhamento público filtrado e limpeza está em [prova local das telas](infra-migration-phase-12-realtime-local-screens.md). Não equivale a navegador remoto com Better Auth/Neon.

Verificações repetidas após Task 8:

- `npm test`: API **488/488**.
- `npm run test:worker`: workerd **19/19**, transporte/SQLite reais.
- Frontend `npm test -- --maxWorkers=2`: **170/170**, 42 arquivos.
- API `npm run build`, frontend `npm run typecheck` e `npm run build:preview`: passaram. O root typecheck do frontend não certifica `tsconfig.app.json`; a comparação mais forte da Task 7 encontrou 21 diagnósticos preexistentes e nenhum introduzido.
- Gates scripts realtime/target/parallel config: **13/13**.
- `node scripts/verify-realtime-preview-config.mjs wrangler.worker-parallel-preview.jsonc`: `ok:true`.
- Wrangler **4.138.0** `deploy --dry-run --config wrangler.worker-parallel-preview.jsonc`: bundle 4486.69 KiB/gzip 765.57 KiB; **No bindings found** no top-level. Não publicou nem comprovou namespace Preview resolvido.

## Gate ACL real — Task 8

Endurecido somente `infra/neon/verify-worker-preview-role.sql` no frontend/SQL: allowlist exato dos grants atuais, permissões efetivas de coluna, exclusão de rotinas legadas e propriedade `pg_proc`. A única exceção de EXECUTE fora das sete rotinas de aplicação é a extensão pgcrypto já revisada. Nenhum grant persistente foi ampliado; verificador production não foi editado.

`scripts/verify-preview-acl-regression.mjs` aceita credenciais apenas por stdin JSON, com guard do endpoint direto preview, database `vapt`, owner `neondb_owner` e basename exato do verificador. Alvo production é rejeitado antes de criar pool/conectar. Saída só contém status/contagens/SQLSTATE sanitizado.

No Neon real, o verificador antigo aceitou indevidamente três cenários temporários: SELECT de coluna da outbox excluída, EXECUTE de rotina legada e propriedade de função permitida. Após correção, baseline e três negações passaram **4/4**, com rollback e baseline final verificados. Credencial capturada da CLI Neon autenticada existente, somente em memória/stdin, sem URI em logs/argumentos/arquivos. Não houve mudança persistente de grants, ownership, senha ou schema.

## Configuração e readback remoto, somente leitura

`wrangler.worker-parallel-preview.jsonc` usa o facade `parallel-preview-entry.ts`, preservando o wrapper Access/bearer. Binding local `RESTAURANT_REALTIME` em `previews.durable_objects`; flag backend `REALTIME_ENABLED:true` somente em `previews.vars`. Migração SQLite `stage12-realtime-sqlite-v1`. Sem `script_name`, namespace compartilhado, binding/flag top-level, Cron, Queue ou rota nova. Frontend remoto continua com realtime desligado.

Decisão de implementação: checker parallel anterior foi estendido para admitir somente essa variante exata, conservando o contrato legacy sem DO. Config estática não prova a política Access ou namespace remoto; continuam gates separados.

Readback de 06/10/2026:

- Conta `3ce69408aa5112617a282957aba71932`: Dashboard Workers plans mostra **Free / US$ 0 / Current plan**. GET subscriptions com OAuth retornou 403; não se ampliaram permissões para lê-lo.
- Access app `b319b0a7-bba1-4fbb-b068-7c1cdc8707cd`: scope `vapt-api-parallel`, tipo exclusivo `A Worker's preview URLs`, uma policy Allow/default-deny `f892e8cf-87d0-4356-b0ec-c646b5047e26`, duração 1h. Nenhuma política editada.
- Shell `vapt-api-parallel`: GET settings com **zero bindings**; nenhum deploy production executado.
- Named Preview `stage11-inert`, ID `56efdbf131174b8fba43387369c6f1e3`, deployment existente `9d020e2c-13b8-490c-be9f-5a5223f18305`. Nenhuma atualização remota nesta Task.
- GET namespaces Durable Objects: lista vazia. O namespace realtime ainda **não foi criado/publicado**.
- Hyperdrive preview `0c05fec2924b4f3b9225f3d689ba7ea9`: endpoint direto `ep-hidden-bird-b673zocn.c-2.sa-east-1.aws.neon.tech:5432/vapt`, role `vapt_api_preview`, cache desativado, limite 5 conexões.
- Neon preview em transação read-only: users/sessions/restaurants/orders/billing events/billing email outbox/payment effect outbox: **todos 0**. Nenhum dado sintético remoto criado nesta execução.

## Pendências da Task 9

O bearer do Preview é write-only e não está disponível na memória local. Foi solicitada autorização para substituí-lo somente no named Preview, sem Access/production/DNS; nenhuma substituição executada. Recuperação de sessão Access expirada deve usar login normal do usuário, sem Service Token persistente ou bypass.

Após esse gate: implementar/testar runner remoto limitado a dois tenants e dois pedidos por tenant; revalidar perímetro/recursos, publicar somente named Preview, inspecionar namespace SQLite isolado, provar WS + escritas Neon + HTTP + revogação/reconexão e limpar exclusivamente fixtures/coordenação do smoke. Depois uma revisão independente da branch completa e handoff com evidências reais.

Não há aceitação production, paridade Coolify nem integração de navegador remoto certificadas. Não mudar planos pagos, domínio, DNS, tráfego ou Cron nesta etapa. Falta consolidar billing PR 3 com API PR 1/frontend PR 4; nenhuma main recebe automaticamente todos os commits. Sem push/merge nesta execução até agora.

Rollback previsto: desligar flags/restaurar somente named Preview; manter polling. Não apagar namespace, branch ou bucket amplamente, nem executar migração destrutiva de classe como rollback trivial.
