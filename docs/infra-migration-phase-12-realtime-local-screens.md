# Etapa 12 — integração das telas e prova local

Data: 06/10/2026. Escopo: Task 7 do plano de realtime. **Não é certificação remota, ativação em produção ou cutover.**

## Implementação

- Cozinha: owner do restaurante resolvido por `fetchOwnedRestaurant`; invalidações `orders`/`kitchen` refazem a leitura HTTP. Relógio de 1 s e autoarquivamento preservados.
- Caixa: `table_sessions`/`payments`/`orders`; leitura inicial em paralelo ao lookup, sem duplicação quando o scope é descoberto. Tick de 1 min preservado.
- Menu: apenas pedidos da sessão atual com acesso armazenado, até 24. Aviso ready deduplicado por pedido. Polling de catálogo de 8 s preservado e independente da sala privada.
- Drawer: até 24 acessos armazenados; nenhum consumidor ou polling enquanto fechado. Compartilha a conexão por pedido com o menu, sem assinatura ampla do restaurante.
- Delivery: somente último pedido/token existente; status recebido por sinal exige nova leitura HTTP e mantém recuperação por polling.
- Refresh manual passa pela mesma fila de resync; cliques durante uma leitura deixam uma única leitura subsequente. A fila é conservada somente na transição de lookup vazio → scope descoberto. Inatividade, troca de scope e unmount continuam limpando recursos.
- Flag real permanece desligada; opt-in local por variáveis efêmeras, sem editar `.env.preview`.

## Evidências no navegador local

Frontend real Vite em `localhost:5179`; Worker local em `localhost:8789`. Foram usados os componentes reais, cliente compartilhado, hook, AuthProvider e WebSocket do navegador. A fixture substitui **somente autoridade/HTTP de negócio** por dados sintéticos persistidos no SQLite do DO de teste. Ela não acessa Neon, Better Auth server ou providers e não é importada por entrypoints de publicação.

1. Restaurante A: cozinha recebeu criação sintética com `101 Switching Protocols` registrado; status alterado pela tela real.
2. Caixa A: criação atualizou 3 pedidos/R$70,50 para 4/R$94,00. Disconnect de teste foi seguido de nova admissão e `101`; uma criação sem publicação foi recuperada pelo resync de segurança (5/R$117,50).
3. Logout real: sala A ficou com zero sockets, tickets, sequências e alarme nulo.
4. Restaurante B: segunda identidade mostrou apenas seu pedido, sem os cinco pedidos de A. Teste workerd também prova negação de proprietário errado e filtragem de publicação entre as salas.
5. Público: pedido #6 criado pela interface do menu A; mudança ready gerou aviso e leitura HTTP somente desse pedido. Drawer mostrou apenas #6, embora a sala tivesse outros cinco pedidos. Menu + drawer mantiveram **um** socket; fechar o drawer preservou somente o consumidor do menu.
6. Limpeza: seis pedidos de A e um de B removidos da fixture; um acesso sintético removido do navegador, sessão sintética encerrada. Ambas as salas ficaram com zero sockets/tickets/sequências e alarme nulo antes da limpeza de negócio. Vite/Worker encerrados; nenhuma porta 5179/8789 em escuta.

Os primeiros sinais visuais ocorreram com fallback: o navegador revelou o builder sem o sufixo `/socket`. A correção foi verificada com dois testes RED→GREEN e depois `101`/socket real. Não se atribui a observação inicial a WebSocket.

Capturas locais guardadas fora do Git no diretório de visualizações da conversa: `vapt-stage12-local-cashier.jpg` e `vapt-stage12-local-order.jpg`.

## Verificações e limites

- Frontend: 170/170 testes, 42 arquivos; build preview e comando `typecheck` passam.
- Checagem adicional do app contra HEAD: baseline 21 diagnósticos/current 21; nenhum introduzido. O root `typecheck` com `files: []` não equivale a typecheck limpo do app. Dívida preexistente registrada no ledger da Task 6, sem ampliação desta tarefa para corrigi-la.
- API Node: 488/488. Workerd: 19/19, incluindo a nova fixture de navegador. Build TypeScript passa.
- Tests novos cobrem status ready/dedupe, catálogo, drawer fechado, delivery, refresh manual concorrente, lookup e URL do endpoint real com base path.
- Nenhuma chamada a serviços externos, secret real, deploy remoto, binding production, DNS ou plano pago nesta tarefa.

Próximos gates: ACL/config preview (Task 8), publicação e smoke remoto privado (Task 9), revisão final da branch. Pareamento de navegador remoto e produção continuam na Etapa 13. API PR 1/frontend PR 4 e billing PR 3 não são integrados automaticamente à main.
