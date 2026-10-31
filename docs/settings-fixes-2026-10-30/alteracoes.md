# Download do APK e confirmação de viagem salva

## Verificação

O botão em Settings e no aviso de atualização estava desabilitado pelo bloqueio de recarga do app. Esse bloqueio também fica ativo enquanto o carro está conectado, mesmo sem gravação: portanto o usuário podia ver a atualização disponível e não conseguir baixar.

Os dois links usavam `target="_blank"`. O WebChromeClient do Capacitor Android instalado no projeto não implementa a criação dessa nova janela. O WebViewClient encaminha navegações comuns para outros domínios ao navegador externo por `Bridge.launchIntent` e `Intent.ACTION_VIEW`.

Na consulta pública feita nesta revisão, a release `android-latest` informou **Build 79**, com **Native build 77**. Assim, o aviso para uma instalação live-site build 76 atualizar para pelo menos 77 é coerente. Ambos os arquivos, `xpeed.apk` e `xpeed-offline.apk`, responderam HTTP 200, com MIME `application/vnd.android.package-archive`. A disponibilidade do arquivo foi verificada sem baixá-lo ou instalá-lo.

O aviso de viagem salva era emitido no fim de cada upload/reconhecimento bem-sucedido. As rotinas de recuperação executam na abertura, retorno ao primeiro plano, reconexão e periodicamente. Uma cópia cuja remoção falha pode ser reconhecida novamente, voltando a emitir o aviso mesmo sem um novo salvamento. O importador já distinguia um commit novo de um recibo existente no banco, mas não informava essa distinção ao componente que emitia o aviso.

## Correções locais

- Baixar o APK permanece disponível durante gravação, conexão ou alterações pendentes em Settings. A proteção contra recarga das telas continua ativa.
- Os links do APK usam navegação externa comum, sem nova janela, compatível com o encaminhamento já existente no Android. Nenhuma alteração nativa ou novo plugin.
- O texto distingue baixar de instalar: pode baixar agora, mas deve encerrar a gravação e salvar alterações antes da instalação.
- O callback de persistência informa se publicou uma viagem nova ou reconheceu um recibo anterior, inclusive numa corrida entre duas tentativas.
- A confirmação de salvamento ocorre no recebimento do primeiro recibo de uma viagem nova em uma operação anunciada. Recuperações automáticas, recibos repetidos e tentativas de limpeza não repetem o toast.
- O estado da viagem continua atualizado para salvo, mesmo quando o recibo já existia. Cópias locais só são removidas após a confirmação durável; não foram apagados registros reais nesta revisão.

## Validação

Testes de regressão cobrem download habilitado durante gravação e alterações pendentes, ausência de nova janela, recarga protegida, salvamento novo com uma única confirmação, entrega repetida do callback, recibo preexistente sem nova confirmação e recuperação silenciosa após falha na limpeza.

Os testes de gravação usam adaptador Bluetooth e IndexedDB simulados. O Android físico não foi testado, conforme preferência do usuário. As verificações HTTP da release são leituras públicas; não houve consulta a dados privados do carro, publicação, push ou mudança no banco remoto.

Os três arquivos de atualização/importação passaram com 27 testes. A inicialização do processo de testes de gravação falhou por timeout na primeira tentativa; executado sozinho com `--pool=threads --maxWorkers=1`, o arquivo de gravação passou com 13 testes. Total: **40 testes aprovados**. A preferência do usuário por baixo consumo neste PC foi incorporada: verificações sequenciais, um único worker e sem suíte completa ou build adicional nesta correção.
