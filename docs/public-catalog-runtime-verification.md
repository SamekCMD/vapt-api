# Catálogo público — prova local e limites

Checkpoint atualizado17/10/2026. Nenhum deploy/recurso/secret/plano criado. Configs `wrangler.worker-catalog-preview.jsonc` e `wrangler.worker-catalog-production.jsonc` são **candidatas**, com reader/writer false, CPU1000ms e migração SQLite append-only após RestaurantRealtime. Ajuste aprovado: snapshots usam `PUBLIC_CATALOG_BUCKET`, candidatos `vapt-catalog-preview`/`vapt-catalog-production` ainda não provisionados; recursos de imagens `R2_BUCKET` permanecem intactos. Não há namespaceID inventado. O entry de preview exporta a classe, sem ligá-la nas configurações legadas.

## Evidência local

`npm run test:catalog-worker`: sete testes aprovados em workerd real:

- Upgrade101, protocolo, heartbeat estático sem handler JS, hibernação/eviction, versão acima de2**53 e rejeição de escrita/binary/frame acima de512bytes no canal público.
- Reinício do executor após quatro interrupções: intenção aceita, resposta perdida após journal externo, dois PUTs R2 parciais, ready antes do sinal. SQLite/alarmes são reais; journal PostgreSQL é **simulado no R2 exclusivamente local**. Cada caso aplica uma única gravação simulada, apaga resultado privado dos chunks e não volta a aplicar/consultar journal em alarme ocioso.
- Snapshot JSON exatamente8MiB pode ser publicado/lido;8MiB+1 é rejeitado mantendo a versão anterior. Imagem otimizada1MiB aceita e1MiB+1 rejeitada pelo budget SQLite real.
- Duzentas conexões públicas permanecem contabilizadas após hibernação; a201ª é rejeitada. Nenhum serviço SQL/auth é composto e não existe binding Hyperdrive na fixture.

Reexecutado17/10 com dois buckets locais distintos: publicação não escreveu no bucket de imagens; catálogo falso versão99 colocado nesse bucket não foi servido por GET ou ready do socket (revisão correta12), nem ganhou precedência após hibernação. Revisão posterior9007199254740993 continuou somente no bucket de catálogo. Reader sem binding privado/incompleto retorna503 sem SQL ou sala; erros de socket também têm no-store. A limpeza de imagens conserva seu binding antigo e usa a projeção privada para verificar referências retidas. Isso não comprova privacidade de recursos remotos ainda inexistentes.

Verificação completa17/10:663/663 unitários API,29/29 workerd (incluindo os7 de catálogo),35/35 guards; compilação TypeScript da API e bundle candidato production em dry-run aprovados. Nenhuma fonte frontend foi alterada nesta separação; suas pendências de tipos/lint do checkpoint anterior continuam abertas.

Os endpoints `/_test/*`, a classe `CatalogExecutionProbe` e seu journal sintético só existem no entry da fixture local. Não exportar a fixture de um entry implantável. Interrupções são injetadas em fronteiras persistidas e seguidas por eviction; não equivalem a matar o processo em qualquer instrução possível. O teste não certifica a transação PostgreSQL.

`npm run test:catalog-config`:35 testes de configuração/deriva. Guard preserva baselines estritas, recursos de imagens, rates, nomes/escopos, migrações anteriores, CPU e flagsfalse; exige bucket de catálogo separado por ambiente. Rejeita credencial em vars, namespace inventado, ausência/alias/cross-env do novo bucket, troca de Hyperdrive, remoção da classe antiga e ativação de flag. Só imprime códigos fixos. **Exit0 significa preparação estrutural válida**, com `activationReady:false` e gates pendentes; nunca autorização para implantação. Opção de ativação é rejeitada. Bundle production candidato gerado apenas em dry-run, com flagsfalse; isso não cria nem verifica os buckets.

## Gates ainda abertos

1. PostgreSQL real **validado localmente em17/10**: sete testes com PostgreSQL18.6 em cluster descartável loopback, incluindo concorrência, rollback, revogação durante lock, tamanho e retenção. Ambos os grants009 foram aplicados sem edição em outra base do mesmo cluster local e negaram DDL/privilégios extras. Nenhuma conexão Neon; servidor encerrado, sem serviço Windows. [Evidência, reprodução e limites](public-catalog-postgresql-verification.md). Não comprova CPU Workers, Hyperdrive nem permissões remotas; estes gates permanecem próprios.
2. CPU8MiB: leitura/publicação funcional passou, mas o harness usado não forneceu medição CPU compatível com o limite1000ms. Tempo de parede **não** é CPU. Precisa de instrumentação suportada/canário limitado após as outras aprovações, sem elevar limite.
3. Privacidade R2: inspeção remota **somente leitura** em16/10 confirmou preview de imagens com `r2.dev` público, production com esse acesso desligado e nenhum custom domain em ambos. Em17/10 o usuário aprovou separar snapshots nos buckets privados candidatos acima, preservando as imagens. Código/configuração preparados; criação e verificação de privacidade dos novos recursos continuam pendentes, sem URL/ACL/objeto remoto alterado. Não basta o nome conter “catalog” ou ser outro binding; confirmar `r2.dev` desligado e ausência de custom domains antes da ativação. Referências oficiais: [public buckets](https://developers.cloudflare.com/r2/buckets/public-buckets/) e [pricing](https://developers.cloudflare.com/r2/pricing/); limites compartilhados de uso não garantem teto monetário.
4. Cobertura de writers ativos: a implementação Worker está coberta, mas o inventário real de consumidores e ausência de escrita paralela Node/Coolify ainda exigem prova. Não investigar Easypanel/Vercel legado.
5. Deploy/rollback: após registrar a nova migração, não publicar configs legadas que omitam o novo binding. As candidatas preservam a classe; os comandos antigos continuam pré-catálogo e **não são o caminho de cutover**. É necessário consolidar o caminho definitivo de deploy e validar seu readback antes de implantar. Este checkpoint não certifica que qualquer comando antigo seja seguro após ativação.
6. Revisão final, gate remoto e qualidade integral do frontend ainda pendentes. Local aprovado não é CI remoto aprovado.

Os limites de200 sockets,512bytes,1MiB/8MiB e CPU1000ms reduzem custo por unidade, não limitam financeiramente toda a conta. Persistem custos de requests, DO/R2, conexões, operações aceitas e uso legítimo/abusivo. Não há promessa de teto de US$20.
