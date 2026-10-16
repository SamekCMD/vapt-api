# Catálogo público — prova local e limites

Checkpoint 16/10/2026. Nenhum deploy/recurso/secret/plano criado. Configs `wrangler.worker-catalog-preview.jsonc` e `wrangler.worker-catalog-production.jsonc` são **candidatas**, com reader/writer false, CPU1000ms, recursos existentes e migração SQLite append-only após RestaurantRealtime. Não há namespaceID inventado. O entry de preview agora exporta a classe, sem ligá-la nas configurações legadas.

## Evidência local

`npm run test:catalog-worker`: sete testes aprovados em workerd real:

- Upgrade101, protocolo, heartbeat estático sem handler JS, hibernação/eviction, versão acima de2**53 e rejeição de escrita/binary/frame acima de512bytes no canal público.
- Reinício do executor após quatro interrupções: intenção aceita, resposta perdida após journal externo, dois PUTs R2 parciais, ready antes do sinal. SQLite/alarmes são reais; journal PostgreSQL é **simulado no R2 exclusivamente local**. Cada caso aplica uma única gravação simulada, apaga resultado privado dos chunks e não volta a aplicar/consultar journal em alarme ocioso.
- Snapshot JSON exatamente8MiB pode ser publicado/lido;8MiB+1 é rejeitado mantendo a versão anterior. Imagem otimizada1MiB aceita e1MiB+1 rejeitada pelo budget SQLite real.
- Duzentas conexões públicas permanecem contabilizadas após hibernação; a201ª é rejeitada. Nenhum serviço SQL/auth é composto e não existe binding Hyperdrive na fixture.

Os endpoints `/_test/*`, a classe `CatalogExecutionProbe` e seu journal sintético só existem no entry da fixture local. Não exportar a fixture de um entry implantável. Interrupções são injetadas em fronteiras persistidas e seguidas por eviction; não equivalem a matar o processo em qualquer instrução possível. O teste não certifica a transação PostgreSQL.

`npm run test:catalog-config`:25 testes de configuração/deriva. Guard preserva baselines estritas, recursos, rates, nomes/escopos, migrações anteriores, CPU e flagsfalse. Rejeita credencial em vars, namespace inventado, troca de bucket/Hyperdrive, remoção da classe antiga e ativação de flag. Só imprime códigos fixos. **Exit0 significa preparação estrutural válida**, com `activationReady:false` e gates pendentes; nunca autorização para implantação. Opção de ativação é rejeitada.

## Gates ainda abertos

1. PostgreSQL real: gate executado novamente e falhou antes de conectar, pois falta `CATALOG_TEST_DATABASE_URL` local isolada. `postgres`, `pg_ctl`, `psql`, Docker e Podman não foram encontrados no PATH. Nenhum fallback Neon, banco production ou instalação foi feito. Tarefa2 permanece parcial.
2. CPU8MiB: leitura/publicação funcional passou, mas o harness usado não forneceu medição CPU compatível com o limite1000ms. Tempo de parede **não** é CPU. Precisa de instrumentação suportada/canário limitado após as outras aprovações, sem elevar limite.
3. Privacidade R2: inspeção remota **somente leitura** em16/10 com `wrangler r2 bucket dev-url get` e `domain list` confirmou preview com acesso público `r2.dev` ligado, production com esse acesso desligado, e nenhum custom domain em ambos. O bucket preview, portanto, não pode receber os snapshots do desenho atual sem exposição direta. Nenhuma URL/ACL/objeto foi alterado. Reader/writer permanecem desligados; foi solicitada aprovação para separar snapshots em buckets privados por ambiente, mantendo imagens intactas. Não criar recursos antes da decisão. Referências oficiais: [public buckets](https://developers.cloudflare.com/r2/buckets/public-buckets/) e [pricing](https://developers.cloudflare.com/r2/pricing/); limites compartilhados de uso não garantem teto monetário.
4. Cobertura de writers ativos: a implementação Worker está coberta, mas o inventário real de consumidores e ausência de escrita paralela Node/Coolify ainda exigem prova. Não investigar Easypanel/Vercel legado.
5. Deploy/rollback: após registrar a nova migração, não publicar configs legadas que omitam o novo binding. As candidatas preservam a classe; os comandos antigos continuam pré-catálogo e **não são o caminho de cutover**. É necessário consolidar o caminho definitivo de deploy e validar seu readback antes de implantar. Este checkpoint não certifica que qualquer comando antigo seja seguro após ativação.
6. Revisão final, gate remoto e qualidade integral do frontend ainda pendentes. Local aprovado não é CI remoto aprovado.

Os limites de200 sockets,512bytes,1MiB/8MiB e CPU1000ms reduzem custo por unidade, não limitam financeiramente toda a conta. Persistem custos de requests, DO/R2, conexões, operações aceitas e uso legítimo/abusivo. Não há promessa de teto de US$20.
