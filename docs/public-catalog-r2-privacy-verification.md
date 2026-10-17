# Catálogo — criação e privacidade dos buckets R2

Evidência de17/10/2026, após autorização explícita do usuário para **criar e conferir somente os dois buckets privados**, sem deploy, flags, URLs públicas ou novo plano. Conta conferida e fixada: `3ce69408aa5112617a282957aba71932`.

## Readback remoto confirmado

| Bucket | Criado em (UTC) | Região / classe | Objetos / bytes reportados | r2.dev | Custom domains |
| --- | --- | --- | --- | --- | --- |
| `vapt-catalog-preview` | 2026-10-17T19:01:27.327Z | ENAM / Standard | 0 / 0 B | desativado | nenhum |
| `vapt-catalog-production` | 2026-10-17T19:01:30.140Z | ENAM / Standard | 0 / 0 B | desativado | nenhum |

Antes da criação, `r2 bucket info` de cada nome retornou Cloudflare10006 (bucket inexistente), não falha de autenticação. Wrangler4.138.0 criou cada bucket com `--storage-class Standard --update-config=false`, usando a conta fixada e a configuração local candidata; nenhum arquivo de binding foi gerado/alterado. Não instalamos a atualização de Wrangler sugerida pelo CLI.

Depois da criação, estes comandos de leitura retornaram exit0 para **cada** bucket:

```text
wrangler r2 bucket info <bucket> --json
wrangler r2 bucket dev-url get <bucket>
wrangler r2 bucket domain list <bucket>
```

Respostas: nomes/timestamps/classe/localização acima, `Public access via the r2.dev URL is disabled` e `There are no custom domains connected to this bucket`. Não foi habilitada URL, associado domínio, configurado CORS, criado token S3 nem gravado objeto de teste. Contagens são o readback daquele momento, não monitoramento contínuo.

## Imagens preservadas

Readback GET posterior confirmou o mesmo estado documentado em16/10:

- `vapt-assets-preview`: acesso r2.dev habilitado, nenhum custom domain.
- `vapt-assets-production`: acesso r2.dev desativado, nenhum custom domain.

Nenhum comando de escrita foi dirigido a esses buckets. Essa diferença de exposição é justamente o motivo da separação; não gravar snapshots no bucket de imagens.

## Alcance e limites

Confirma privacidade dos **recursos R2 nesses mecanismos públicos e nesse instante**, não implantação do Worker nem revisão de todas as credenciais da conta. Buckets privados continuam acessíveis por credenciais/bindings autorizados; não houve teste S3 nem criação de capability. [Documentação de buckets privados por padrão](https://developers.cloudflare.com/r2/buckets/create-buckets/) e [formas de acesso público](https://developers.cloudflare.com/r2/buckets/public-buckets/).

Os nomes já constam como `PUBLIC_CATALOG_BUCKET` nas candidatas preview/production; **nenhum binding foi implantado**. Namespace/migração doDO, schema remoto, autorização de rollout, CPU1000ms, writers ativos, revisão final, bootstrap e readback do runtime continuam gates próprios. Os aliases de deploy permanecem bloqueados e os checks locais seguem `activationReady:false`; a lista conservadora do checker não consulta este histórico.

Nenhum serviço existente foi publicado/revertido, nenhum segredo/DNS/ACL de imagens foi alterado e nenhum plano foi contratado. Os recursos estão provisionados; isso não garante teto de fatura nem mede economia ou consumo futuro.
