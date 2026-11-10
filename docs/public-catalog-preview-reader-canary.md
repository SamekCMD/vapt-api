# Canário privado de leitura — escopo aprovado em 24/10/2026

**Executado e encerrado24/10:** run07a61a7b-ce1b-4960-a720-bc3185886ed2, baseline34→janela35`64e88a89-7904-4568-a2f0-daa4f63f51c1`→fechado36`97af4604-7bc0-4dba-b867-a757d28d6ee0`, ambasflagsfalse/CPU1000. QuatroGETs200, doisformatos8MiB/conteúdointegral; Worker4requests/0errors/sampleInterval1/maxCPU245,860ms. Seisobjetosretiradospara530bytesdefences, readbackindependenteexit0 conferiuhashes/privacidade/36/trêscontroles. Controllerexit0, semNeon/APIwrites/novoPaid/prod/main/push. `readerCasePassed:true`, `fullCpuGatePassed:false`, `activationReady:false`. Relatório frontend `docs/infra-migration-catalog-reader-canary-2026-10-24.md`. **NÃO reexecutar este operador/controlador:** baseline34consumido/marcadorexiste. As instruções inferiores descrevem a execução histórica, não uma próxima autorização.

O usuário aprovou explicitamente ambas as flags temporárias no preview privado, corrigindo a proposta anterior reader-only: a proteção existente exige writer=true quando reader=true. Não remover essa proteção.

## Operação limitada

- Baseline fechado **34 / 55463f0b-4582-46ea-b2c5-475864e3d001** no Preview nomeado `stage11-inert` de `vapt-api-parallel`.
- Uma renovação write-only do bearer, somente em memória do controlador, e flags reader/writer=true: implantação35. Mesmo código, CPU1000, recursos, secrets restantes, rates e executor. Nenhum upload do entry de testes, alteração de DNS/base config, main/push ou produção.
- Cloudflare Access existente, JWT temporário com audience deste preview e duração máxima1h. Nenhum Service Token persistente. Confirmar bucket de catálogo privado antes de gravar; buckets de imagens intocados.
- Dois restaurantes UUID aleatórios **somente como snapshots R2**, sem contas, sessão de aplicação, seed/migration/consulta Neon ou mutação de API. Cada snapshot exatamente8MiB, gerado pelo mesmo suporte testado localmente: muitos itens simples e muitas variações, com limites HTTP por item preservados.
- Seis chaves conhecidas inicialmente ausentes; PUT/readback exato. Controlador faz estritamente quatro GETs allowlisted, duas rotas por formato (`catalog-state` e `catalog`), sem repetir requisições. Valida conteúdo completo, tamanho e no-store.
- Fechar **ambas** as flags na implantação36 antes da limpeza. Não remover executor, DO, classe ou migração; accepted permanece recuperável.
- Substituir somente os seis objetos conhecidos por fences pequenos com validação prévia de todo o escopo e readback. Nunca DELETE, listagem ampla ou sobrescrita de conteúdo inesperado. PUT incerto interrompe sem retry/reparo/limpeza especulativa.
- Telemetria Worker filtrada por preview, versão35 e janela exata: quatro requests, sampleInterval1, zero erros e `max.cpuTime<1000000`µs para certificar somente estes GETs. CPU ausente não autoriza repetir workload. Não usar tempo de parede, quantil como máximo ou promessa de teto financeiro.
- Readback independente da implantação fechada, produção/controles e fences. Nenhum novo plano ou serviço pago; operações R2/Workers continuam sujeitas ao consumo já contratado.

## Implementação e verificação

`scripts/catalog-preview-reader-canary.mjs` não possui CLI genérico. Pin34→35→36 exclusivo; janela anterior32→33→34 permanece consumida/intocada. Testes cobrem CPU/flags/recursos/credenciais, drift, PATCH incerto, fechamento único e fechamento mesmo após falha em controle externo.

`scripts/catalog-reader-probe.mjs` não autentica provedores, não sabe conectar ao banco e não tem entrada de deploy. Testes verificam seis chaves/fences, quatro leituras, isolamento, conteúdo inesperado, não-replay e falha incerta. O gerador TS permanece exclusivamente no grafo local de testes, com identidades sintéticas explícitas.

Controlador one-shot e artefatos ficam no scratch ignorado do plano de catálogo, sob `catalog-reader-controller-2026-10-24.mjs` e marcador exclusivo `catalog-reader-approved-2026-10-24-start.json`. Marcador existente significa **não reiniciar**, inclusive depois de falha. Não recuperar bearer write-only ou apagar marcador para repetir.

Este documento define o escopo, **não comprova execução remota**. Resultado e verificação serão registrados após execução. Gate amplo de ativação permanece aberto; não implica integração/main, reader de produção ou aposentadoria da API anterior.

Preflight local24/10:20 testes de janela e6 de probe novos RED→GREEN, mais teste de identidade isolada RED→GREEN. Finais298/298 operadores,704/704 API,9/9 workerd, zero falhas/skips; TypeScript e syntaxcheck do controlador exit0. Não reexecutar esses gates sem alteração relevante; o próximo passo é a única janela remota já aprovada.
