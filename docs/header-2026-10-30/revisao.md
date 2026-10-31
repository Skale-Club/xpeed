# Header — status e Bluetooth unificados

Publicado em 30/10/2026 no domínio https://xpeed.skale.club, commit `f243ac42d5cf022f59abcfb628b665f59532b0de`. Main, Dev e suas referências remotas estão nesse commit. A publicação contém somente os componentes e traduções do header; as demais correções da revisão permanecem locais.

O header agora tem dois controles à direita: o status do carro com o ícone de Bluetooth dentro do mesmo botão e o sino de notificações. Ambos têm superfície visual de 32 px dentro de uma área de toque de 44 px, fundo e borda suaves, ícones de 16 px e o mesmo tratamento de foco. O espaço entre os controles também foi reduzido. O menu separado de Bluetooth e o estado compartilhado dos dois antigos menus foram removidos.

## Comportamento

- Desconectado: o clique abre a seleção do adaptador no próprio gesto do usuário, antes de navegar para o painel ao vivo. Isso preserva a ativação exigida pelo Web Bluetooth. O painel mostra o progresso e eventuais erros.
- Conectado: o clique abre o painel ao vivo sem reiniciar a conexão.
- Conectando, reconectando ou aguardando o carro: o clique também abre o painel, sem interromper a tentativa em andamento.
- Gravando: o status indica a gravação e abre o painel sem encerrá-la.
- Desconectar permanece no card do adaptador, abaixo dos instrumentos do painel ao vivo, com confirmação.
- O sino continua abrindo um painel compacto, sem bloquear a página. Escape fecha o painel e devolve o foco ao sino.
- Navegadores sem Bluetooth continuam mostrando as notificações.

Desconectado:

![Status e Bluetooth compactos, desconectado](compacto-desconectado.png)

Conectado:

![Status e Bluetooth compactos, conectado](compacto-conectado.png)

Os arquivos `conectado.png` e `desconectado.png` documentam a proposta anterior com três controles. Os arquivos `unificado-*.png` registram a primeira unificação, com superfícies de 44 px, substituída pela versão compacta.

## Verificação

- 30 testes nos cinco arquivos de header, notificações, gravação e painel ao vivo.
- Após o ajuste visual, os 14 testes de header e notificações passaram novamente; build também verificado.
- Typecheck e build passaram; lint sem erros, com os 13 avisos react-refresh preexistentes.
- Navegador com conta e adaptador simulados: clique no status desconectado conectou e abriu o painel; clique no status conectado voltou ao painel preservando a conexão; desconexão no card do adaptador encerrou o vínculo após confirmação.
- Primeira unificação conferida em 390, 320 e 1280 px. Versão compacta conferida novamente no navegador em 390 e 320 px, em português. A medição do DOM confirmou área de toque com 44 px e superfície visual com 32 px (recuo vertical de 6 px em cada lado).

As verificações usaram o adaptador simulado do ambiente local, sem acessar o Bluetooth físico do usuário. Não houve alteração no APK nativo ou no banco para esta mudança.

## Publicação

- Deploy Vercel: `dpl_ERHwu75ruGomHhJzGtCFrSyjRE6w`, estado READY e domínio de produção atribuído.
- A versão isolada publicada passou em 29 testes de header, notificações, gravação e painel ao vivo, além de typecheck, lint e build. Os 13 avisos react-refresh do lint já existiam.
- Conferência no domínio de produção: página, service worker, JavaScript do layout e CSS responderam HTTP 200. Os arquivos publicados contêm o controle unificado, o alvo de toque de 44 px e a superfície compacta de 32 px.
- Consulta inicial aos logs do novo deploy não retornou erros/falhas. Isso não substitui validação no Android físico; o navegador de verificação não estava autenticado para visualizar o header real em produção.
- Nenhuma migração de banco foi aplicada. O APK que carrega o site ao vivo recebe a mudança pela atualização das telas do aplicativo.
