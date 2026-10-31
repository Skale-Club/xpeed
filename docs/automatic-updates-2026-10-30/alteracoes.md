# Atualizações automáticas e Settings simplificado

## Experiência

- Removidos de Settings o painel de atualizações técnicas, os botões Check APK/Reload screens e o painel Trip synchronization. A sincronização das viagens permanece no serviço interno.
- No APK instalado, a seção de instalação não aparece mais. **Sobre o Xpeed** concentra versão/build, estado de atualização e botão **Atualizar aplicativo**, quando necessário.
- O aviso de uma nova versão funciona em todas as telas autenticadas. Pode ser ignorado. A escolha fica neste dispositivo para aquela versão necessária, entre navegações, recargas e reaberturas. Uma versão necessária diferente pode gerar novo aviso; o acesso em Sobre continua disponível.
- Checagem de APK automática e compartilhada: abertura/retorno ao primeiro plano, reconexão e intervalo de 30 minutos. Uma consulta em andamento e um temporizador são compartilhados pelo aviso e Sobre; não há botão manual. Fora do APK, nenhuma consulta de versão nativa é feita.
- A versão instalada continua visível sem internet. Uma falha ao consultar a release não é apresentada como aplicativo atualizado. A conexão restabelecida força uma nova consulta para não reutilizar o resultado offline.
- O download continua disponível durante a gravação. O texto orienta a terminar a gravação e salvar alterações antes de instalar por cima do aplicativo existente.

## Atualizações das telas

O mecanismo existente consulta o service worker periodicamente e ao retornar ao aplicativo. Uma versão nova aguarda **30 segundos sem interação** antes de ativar/recarregar. Toques, teclado, entrada de texto, rolagem e movimento do ponteiro/toque reiniciam a espera. A preparação pode acontecer em segundo plano; a recarga volta a conferir a inatividade depois da ativação.

Gravação/conexão em uso, persistência de viagem, alterações pendentes protegidas, editores focados, menus, seletores e diálogos abertos seguram a troca. Uma aba oculta ou sem internet não é recarregada automaticamente. O controle de atividade não renderiza React a cada evento: usa um único timeout enquanto há atualização aguardando, com movimento limitado a uma atualização por segundo.

A recarga mantém a URL atual, incluindo parâmetros e fragmento. Salva a posição de rolagem e a restaura quando o conteúdo da mesma página tiver carregado. Desiste da restauração se o usuário assumir o controle ou se o registro pertencer a outra página. Mantidas as proteções contra loop de atualização e contra recarga durante gravação. Não são feitas recargas periódicas sem uma atualização nova apenas para buscar novamente o mesmo código.

## Advanced Tools

- Continua como preferência que exige Salvar. A rota e a navegação do Scanner já verificam essa preferência, além de ocultar o atalho.
- Scanner apresentado como ação clara; descrição restrita às ferramentas de diagnóstico realmente disponíveis.
- Integrações de desenvolvedores ficam em uma área separada e recolhida. O módulo de tokens só carrega quando a pessoa a abre, evitando consultas e código desnecessários na visita normal a Settings.
- Retirado desse grupo o texto interno sobre chave compartilhada de IA/cotas. O endpoint das integrações usa o host público também no APK offline, em vez de apresentar localhost.

## Validação e limites

Testes focados cobrem Settings sem painéis duplicados, versão e ação de atualização, aviso ignorável, monitor compartilhado, funcionamento offline/reconexão, ativação da preferência avançada, carregamento das integrações sob demanda, inatividade, editores/diálogos, gravação/rascunhos, ativação concorrente com interação e preservação da página/rolagem.

Executados em um único worker, sequencialmente. Sem navegador, suíte completa, build Android ou deploy nesta revisão, respeitando a preferência por baixo consumo no PC. O Android físico não foi testado. Resultados registrados em `validacao.txt`.

As mudanças continuam locais na branch `codex/reliability-regional-preferences`. Nenhum push, migração ou publicação em produção.
