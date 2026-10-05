# Stage 11 — API Worker paralelo (em andamento)

Status em 05/10/2026: API completa configurada no Preview protegido por Access
e bearer, com health/readiness, identidade Hyperdrive e falha por binding ausente
validados remotamente. Os fluxos sintéticos e a comparação HTTP ainda estão pendentes.
O comparador HTTP foi implementado e executado; o destino Coolify ficou indisponível.
O shell permanece sem bindings/URL de produção. Nenhum tráfego público de produção,
DNS, Cron ou Queue consumer foi alterado nesta etapa. A API pública continua
sob responsabilidade do Coolify; a migração da rota pública pertence à Stage 13.

## Inventário antes do Worker

| Item | Estado observado | Fonte/verificação |
| --- | --- | --- |
| Conta Cloudflare | `3ce69408aa5112617a282957aba71932` | Dashboard/`wrangler whoami` |
| Workers existentes | `vapt-billing-email-production`, `vapt-billing-email-preview`, `vapt-web`; `vapt-api-parallel` ausente | Workers & Pages, 30/09 |
| Zero Trust/Access | Zero Trust Free ativo, US$ 0 devido na ativação, limite de 50 usuários. O proprietário autorizou explicitamente a cobrança no cartão salvo por uso acima da franquia gratuita, exigida pelo checkout | Dashboard Zero Trust, confirmação de compra e Overview, 30/09 |
| R2 | `vapt-assets-preview` e `vapt-assets-production`, distintos | `npx --no-install wrangler r2 bucket list` |
| Hyperdrive preview | `vapt-api-neon-preview` / `0c05fec2924b4f3b9225f3d689ba7ea9`; `vapt_api_preview` em `ep-hidden-bird-b673zocn.c-2.sa-east-1.aws.neon.tech:5432/vapt`, cache desativado, limite 5 | `npx --no-install wrangler hyperdrive list` |
| Neon preview | Projeto `dawn-morning-27332079`, branch `br-rough-dew-b6ydeygb`; role `vapt_api_preview` listada sem ownership | Console Neon, 30/09 |
| Neon ACL/limpeza | Database `vapt`; role com login e sem atributos administrativos, zero memberships, zero relações de sua propriedade, `CONNECT`/`USAGE`/DML amostrados permitidos e `CREATE`/leitura de outbox/`INSERT orders` negados; role production ausente; zero usuários/verificações Stage 10 e zero efeitos pendentes | Dois `SELECT` somente leitura no SQL Editor da branch preview, 30/09 |
| DNS público da API | `api.vapt.app.br` respondeu NXDOMAIN no resolvedor local e em `1.1.1.1` | `Resolve-DnsName ... -Type A`, 30/09 |

Os IDs de namespace `11011`–`11016` aparecem apenas na configuração nova;
os três Workers existentes foram inspecionados no Dashboard, sem rate-limit
bindings. O `vapt-web` tem apenas assets estáticos; os dois Workers de email
têm apenas seus bindings de Queue. Isto é inventário, não prova de isolamento
remoto até o readback do Worker paralelo.

## Shell inerte e Access de Preview

O verificador estático (`node scripts/verify-parallel-preview-config.mjs
wrangler.worker-parallel-preview.jsonc`) e o `wrangler deploy --dry-run` passaram.
O primeiro comando foi inicialmente chamado sem seu argumento obrigatório e
falhou por uso incorreto da CLI; a reexecução correta passou, sem alteração de
código ou configuração.

O shell `vapt-api-parallel` foi publicado pelo Wrangler, deployment
`29cbfb3b-7a76-448e-a984-aeb80fc5bde9`, versão
`ce6f3919-1d9e-4b43-8914-865d7597619c`. O readback da versão mostrou
somente handler `fetch` e **zero bindings**. O Dashboard mostrou “No URLs
enabled”, produção `workers.dev` desativada, Preview URL desativada, zero
domínios/rotas, zero consumidores de Queue e zero invocações na leitura inicial.
Nenhum bearer ou segredo de aplicação foi instalado.

O Access app self-hosted `b319b0a7-bba1-4fbb-b068-7c1cdc8707cd` está
associado ao Worker ID/Scope `vapt-api-parallel` (campo `worker_id` do
Dashboard) com tipo “A Worker's preview URLs”
(`preview_worker` conforme a documentação Cloudflare). A política
`f892e8cf-87d0-4356-b0ec-c646b5047e26` é `Allow` apenas para membros desta
conta Cloudflare, com uma única regra, default-deny e sessão de uma hora. A
lista de membros da conta mostrava apenas o proprietário ativo no momento da
criação. Não há bypass, destino account-wide, `all_preview_workers`, Worker
frontend ou regra de email domain. Se outro membro for adicionado futuramente,
esta regra deve ser revista, pois ele passaria a ser elegível.

Depois do readback do Access, foi criado o Preview `stage11-inert`, ID
`56efdbf131174b8fba43387369c6f1e3`, deployment
`70e47b94-a724-4235-a7a1-83dbf3f77731`. O comando usou
`--ignore-base-config` e não enviou arquivo de secrets. Seu inventário remoto
mostrou somente `ENVIRONMENT=preview`, `STRIPE_ENVIRONMENT=test`, os seis rate
limits `11011`–`11016`, Hyperdrive preview
`0c05fec2924b4f3b9225f3d689ba7ea9` e R2 `vapt-assets-preview`; não há
`PARALLEL_PREVIEW_TOKEN` nem outro segredo de aplicação. Esses bindings
existem **somente no Preview**, não no shell de produção. A URL de Preview
`https://stage11-inert-vapt-api-parallel.autoistloko.workers.dev/` foi
habilitada depois da aprovação específica do proprietário. O Dashboard
confirmou “An Access policy applies to this URL”; `workers.dev` de produção
permaneceu desligado, sem rota ou domínio customizado.

Uma requisição HTTP nova, sem cookies e sem seguir redirecionamentos, recebeu
`302` para `shy-mouse-d86f.cloudflareaccess.com`, sem corpo de erro do wrapper.
A URL individual do deployment também respondeu `302` para o mesmo Access,
sem executar o wrapper. Isso comprova o bloqueio no Access antes da execução
do Worker, inclusive sem bypass pela URL do deployment. A primeira tentativa
de login interativo parou porque o Brave bloqueou o consent screen OAuth
(`ERR_BLOCKED_BY_CLIENT`); não houve bypass. Após autenticação manual pelo
proprietário, o navegador mostrou exatamente
`{"error":{"code":"service_unavailable","message":"Service unavailable"}}`.
O wrapper versionado só emite essa resposta com status `503` quando falta
`PARALLEL_PREVIEW_TOKEN` (teste local: 4/4 PASS, delegate zero nessa condição).
Uma segunda requisição autenticada pela sessão local do `cloudflared` confirmou
diretamente HTTP `503`, `service_unavailable` e `Cache-Control: no-store` em
`/health`, sem bearer. Portanto, o gate parou antes da API, Neon ou provider.
A tela Settings do Preview mostrou apenas as variáveis
`ENVIRONMENT=preview` e `STRIPE_ENVIRONMENT=test`, sem segredo.

Uma tentativa de usar Service Token temporário também foi interrompida: o
segredo recém-criado apareceu no registro desta sessão antes de ser usado.
Após autorização específica, o token foi **excluído**, com confirmação “Service
token has been deleted” no Dashboard. Ele nunca foi associado a uma política,
nem enviado ao Worker. Nenhum Service Token ativo foi deixado por esta etapa.

## API completa no Preview — Task 4

Em 30/09, antes dos providers, a instalação write-only do bearer foi seguida
por HTTP `401` sem bearer e `503` com bearer correto/config incompleta. Na
retomada de 05/10, a sessão local em memória e as chaves one-time haviam sido
descartadas. O bearer foi substituído por novo valor aleatório de 48 bytes e o
token R2 `vapt-api-preview-r2` foi novamente rotacionado com o mesmo escopo:
Object Read & Write apenas em `vapt-assets-preview`. As chaves antigas foram
invalidadas. As novas chaves foram transferidas diretamente entre as telas R2
e Preview, sem imprimir valores, e confirmadas como `Value encrypted`.

Foi criada a chave Resend `vapt-api-parallel-preview-2026-10-05`, com Sending
access somente para `vapt.app.br`, e instalada diretamente no Preview. A chave
Stripe reutilizada foi validada pelo prefixo Test do arquivo local ignorado do
projeto. Better Auth e public-order token receberam segredos aleatórios novos.
Turnstile usa a chave pública de testes documentada pela Cloudflare.

`STRIPE_WEBHOOK_SECRET` é um segredo sintético aleatório para o ensaio de
requisições assinadas pelo operador através do Access. Não corresponde a um
destination público Stripe; entrega originada pelo provider continua não provada.

Os nove secrets estão apenas no Preview nomeado `stage11-inert`:

```text
BETTER_AUTH_SECRET        PARALLEL_PREVIEW_TOKEN     PUBLIC_ORDER_TOKEN_SECRET
R2_ACCESS_KEY_ID          R2_SECRET_ACCESS_KEY      RESEND_API_KEY
STRIPE_SECRET_KEY         STRIPE_WEBHOOK_SECRET     TURNSTILE_SECRET_KEY
```

O bulk via stdin retornou exit `0`, com verificação de que nenhum valor foi
ecoado. Nenhum arquivo com os segredos foi criado no worktree. A configuração
versionada contém somente URLs de Preview, IDs dos planos Test, templates,
sender, conta/bucket/base pública R2 e os marcadores de ambiente.

O primeiro deploy completo foi `379f15d6-0b7c-4eee-b5da-9ad3f5884f9b`.
O readback mostrou os nove `secret_text`, seis namespaces `11011`–`11016`,
Hyperdrive `0c05fec2924b4f3b9225f3d689ba7ea9`, bucket `vapt-assets-preview`,
`ENVIRONMENT=preview` e `STRIPE_ENVIRONMENT=test`. O shell `ce6f3919` continuou
com `bindings: []` e somente `fetch`, sem rota pública ou trigger.

| Requisição remota | Resultado |
| --- | --- |
| `/health`, sem Access/bearer | `302` para o Access, `no-store` |
| `/health`, Access sem bearer | `401 unauthorized`, `no-store` |
| `/health`, Access+bearer | `200`, `status=ok` |
| `/health/ready`, Access+bearer | `200`, `status=ready` |
| `/auth/me`, Access+bearer sem cookie de aplicação | `401 unauthorized` |
| Probe SQL protegido `POST /identity` | `200`, database `vapt`, role `vapt_api_preview` |
| Catálogo público, Access+bearer com `PUBLIC_RATE_LIMIT` ausente | `503 service_unavailable` |

Para verificar a identidade SQL, somente o Preview nomeado foi temporariamente
publicado com o probe já versionado, mesmo Hyperdrive e token diagnóstico em
memória. A primeira chamada imediata pelo alias ainda atingiu a API anterior
(`404 not_found`); o readback mostrava `hyperdrive-probe.js`. A reexecução pela
URL imutável do deployment recebeu `200` e a identidade exata. A API foi
restaurada em `finally` e `PROBE_TOKEN` removido do deployment corrente.

O teste negativo removeu somente `PUBLIC_RATE_LIMIT` de uma configuração
temporária ignorada. Sua URL imutável, também protegida pelo Access, retornou
`503` antes da rota de catálogo. A configuração completa foi restaurada em
`finally`, deployment `435ecc62-ad83-4fcc-b008-215b059a9e50`. Os deployments
anteriores continuam sujeitos ao Access; secrets removidos do deployment
corrente não são apresentados como apagados retroativamente do histórico.

Validação: checker estático e seus 5 testes passaram; `npm test` 450/450,
`npm run test:worker` 15/15, build TypeScript e ambos os dry-runs passaram.
O dry-run paralelo mostrou zero bindings top-level. O sandbox inicialmente
bloqueou os subprocessos Node com `EPERM`; as execuções autorizadas passaram.

Estas provas não certificam signup/login, R2 signed PUT ou checkout. Esses
fluxos e a limpeza de fixtures pertencem à Task 6. A amostragem SQL inicial
não substitui o verificador integral de ACL durante a aceitação remota.

## Matriz HTTP somente leitura — Task 5

`scripts/compare-parallel-api.mjs` aceita somente os dois hosts aprovados,
cinco caminhos fixos `GET`, sem corpo, cookies ou redirect automático. Somente
o Preview recebe as credenciais Access/bearer; Coolify recebe apenas a origem
CORS de Preview. O resultado contém status, media type, nomes conhecidos das
chaves de erro, código de erro allowlisted e booleanos dos headers relevantes,
sem corpos, cookies, IDs, mensagens arbitrárias ou URLs de redirect.

Os cinco testes foram escritos antes da implementação (RED: módulo ausente),
depois passaram: matching contracts, IDs voláteis, divergência status/error/CORS,
Access redirect, rejeição de mutações/body/hosts/cookies e erro de transporte
sanitizado. A suíte Node permaneceu 450/450.

Uma execução remota limitada em 05/10 produziu:

| GET | Coolify | Preview | Resultado |
| --- | --- | --- | --- |
| `/health` | indisponível | `200` | comparação não comprovada |
| `/auth/me` | indisponível | `401` | comparação não comprovada |
| `/restaurants/me` | indisponível | `401` | comparação não comprovada |
| `/public/restaurants/__stage11_missing__/catalog` | indisponível | `404` | comparação não comprovada |
| `/__stage11_missing__/%not-hex` | indisponível | `400` | comparação não comprovada |

A indisponibilidade é erro de transporte, não status HTTP inventado, e não
certifica divergência da aplicação. A resposta `400` ao caminho malformado
também não prova que essa requisição chegou à API. Nenhum esforço de mudança
de DNS ou reconfiguração Coolify foi feito para tornar o comparador verde.
Paridade com a referência permanece um gate não comprovado; os fluxos de
Preview isolados podem continuar.
