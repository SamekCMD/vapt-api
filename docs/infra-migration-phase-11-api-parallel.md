# Stage 11 — API Worker paralelo (em andamento)

Status em 30/09/2026: shell inerte publicado sem URL de produção, Access de
Preview configurado e um Preview inerte acessível apenas através do Access;
ainda não há Preview da API completa. Nenhum tráfego público de produção, DNS, Cron,
Queue consumer ou segredo da API foi alterado nesta etapa. A API pública continua
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
`PARALLEL_PREVIEW_TOKEN` (teste local: 4/4 PASS, delegate zero nessa condição);
o navegador não expôs o status HTTP diretamente. Portanto, corpo remoto e
teste local juntos sustentam que a requisição autenticada parou antes da API,
Neon ou provider. A tela Settings do Preview mostrou apenas as variáveis
`ENVIRONMENT=preview` e `STRIPE_ENVIRONMENT=test`, sem segredo.

Uma tentativa de usar Service Token temporário também foi interrompida: o
segredo recém-criado apareceu no registro desta sessão antes de ser usado.
Após autorização específica, o token foi **excluído**, com confirmação “Service
token has been deleted” no Dashboard. Ele nunca foi associado a uma política,
nem enviado ao Worker. Nenhum Service Token ativo foi deixado por esta etapa.

## Gate de segurança pendente

O gate de Access e wrapper foi provado sem instalar segredos. Antes do deploy
da API completa, repetir o verificador estático e instalar os segredos
**somente** no Preview nomeado, nunca no shell nem no Base compartilhado.

A amostragem SQL acima não substitui a execução integral do verificador
versionado de ACL durante a aceitação remota.
