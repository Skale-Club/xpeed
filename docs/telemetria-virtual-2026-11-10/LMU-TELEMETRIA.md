# Telemetria do Le Mans Ultimate (LMU)

Pesquisa de 10/11/2026. Objetivo: saber como um programa externo (o coletor do Xpeed) lê os dados do LMU e o que falta decidir antes de escrever o leitor. **Nenhum código de leitor foi escrito**; nada foi lido de um jogo em execução (o LMU estava fechado).

## Resumo

- O LMU **publica a própria memória compartilhada**, chamada `LMU_Data`, com telemetria (**100 Hz** por padrão) e pontuação (cerca de 5 Hz, segundo um projeto da comunidade). **Não precisa do plugin antigo do rFactor 2.**
- A fonte primária são os cabeçalhos que o próprio jogo instala em `Support\SharedMemoryInterface` (três arquivos). Eles definem o nome do mapa, os eventos de sincronização, a trava e as estruturas.
- Na sua máquina a opção do jogo que habilita isso (**"Enable external plugins"**) já está **ligada**.
- Ponto de atenção: a **licença dos cabeçalhos proíbe copiá-los ou redistribuí-los**. O coletor deve ter definições próprias dos campos que usa (ver "Licença").
- O jogo também tem gravador próprio de telemetria (arquivos `.ld` e `.csv`), mas **ainda não há nenhum nesta máquina**.

## Como o jogo expõe os dados

### Fonte primária: `Support\SharedMemoryInterface` (instalada com o jogo)

Em `F:\SteamLibrary\steamapps\common\Le Mans Ultimate\Support\SharedMemoryInterface\`: `SharedMemoryInterface.hpp` (arquivo de 22/09/2026), `InternalsPlugin.hpp` e `PluginObjects.hpp` (ambos de 12/04/2026). Versão do jogo conferida: **1.4.2.0**.

**Nomes (objetos do Windows):**

| O quê | Nome |
|---|---|
| Memória compartilhada | `LMU_Data` |
| Evento "segure" | `LMU_Data_HoldEvent` |
| Evento "dados novos" | `LMU_Data_DataEvent` |
| Trava (mapa de 8 bytes) | `LMU_SharedMemoryLockData` |
| Evento da trava | `LMU_SharedMemoryLockEvent` |

**Protocolo de leitura que o próprio cabeçalho documenta:**

1. Abrir `LMU_Data` e os dois eventos. Se não abrir, o jogo não está rodando ou é uma versão sem essa interface.
2. Esperar o `HoldEvent` e depois o `DataEvent` (nessa ordem, a única sem corrida). Esperar com tempo limite curto, só para poder reverificar se o jogo ainda existe.
3. Pegar a trava (dois contadores, `busy` e `waiters`, com troca atômica), **copiar** os dados e soltar a trava. Nunca processar direto na memória compartilhada.
4. A cópia depende dos eventos do quadro: só copia a telemetria quando o evento de atualização de telemetria veio, e o mesmo para pontuação e caminhos.

**Organização (`SharedMemoryObjectOut`):** quatro blocos em sequência: geral (fila de eventos, versão do jogo, torque do volante, estado da aplicação), caminhos (cinco textos de `MAX_PATH`), pontuação e telemetria. Estruturas empacotadas de 4 em 4 bytes (`#pragma pack(4)`); `long` tem 32 bits no Windows de 64.

**Telemetria** (até 104 carros): contagem de carros ativos, índice do carro do jogador e se o jogador tem carro. Por carro, os campos que nos interessam: tempo decorrido e variação de tempo, número da volta, instante em que a volta começou, nomes do carro e da pista, posição no mundo, velocidade em coordenadas locais (m/s), marcha (-1 ré, 0 neutro), rotação, acelerador, freio, volante e embreagem **sem filtro** (0 a 1; volante -1 a 1) e combustível (litros).

**Pontuação** (até 104 carros): dados da sessão (nome e comprimento da pista) e, por carro: **distância percorrida na volta**, posição lateral, tempo da última volta (outro projeto cita também tempos de setor; não conferi no cabeçalho), "é o jogador", "está no box", quem controla (0 = jogador local), classe e piloto. **Atenção:** os ponteiros dentro dessas estruturas só valem dentro do processo do jogo e devem ser ignorados na cópia.

### Alternativas e outras fontes

| Fonte | Situação |
|---|---|
| Plugin `rFactor2SharedMemoryMapPlugin64.dll` (mapas `$rFactor2SMMP_*$`) | Caminho antigo. O arquivo existe na pasta `Plugins` do jogo (versão 3.7.15.1, de 2023), mas **não está ativado** nesta máquina. Um projeto da comunidade informa que não é mais usado |
| API REST local na porta 6397 | Só para estratégia e garagem (uso de energia virtual, desgaste). Fora do que precisamos. Usar `127.0.0.1` (IPv6 foi recusado em um relato) |
| Gravador do próprio jogo (`.ld` do MoTeC e `.csv`) | Segundo o wiki do jogo, vão para `Documents\Le Mans Ultimate\Telemetry`. **Não existe essa pasta aqui.** Daria uma segunda via de entrada: importar o arquivo depois da sessão, sem leitura ao vivo. Formato ainda não estudado |
| UDP | **O jogo não tem saída UDP nativa**; só ferramentas de terceiros que reencaminham |

## O que há nesta máquina

- LMU 1.4.2.0 em `F:\SteamLibrary\steamapps\common\Le Mans Ultimate`; o jogo **não estava rodando**.
- `UserData\player\Settings.JSON`: **"Enable external plugins": true**. **"Plugin Mask": 4**, que o próprio arquivo descreve como a taxa de atualização dos plugins: "100Hz default". Nada foi alterado.
- `CustomPluginVariables.JSON` contém `null`: o plugin antigo não está habilitado (e não precisa estar).
- Ferramentas: **Rust** (`cargo`) instalado; **.NET** só com runtimes 6, 8 e 9, **sem SDK** (dá para rodar, não para compilar); Python 3.11; Node; Visual Studio Installer instalado, mas `cl`, `g++` e `clang++` não estão no PATH (não verifiquei se há as ferramentas de C++ instaladas dentro do Visual Studio).

## Licença dos cabeçalhos

`SharedMemoryInterface.hpp` diz que faz parte do Studio 397 Plugin SDK, que só pode ser usado para desenvolver plugins ou extensões de produtos da Studio 397 e que **redistribuição ou modificação não é permitida**. Consequências:

- **Não copiar os cabeçalhos para o repositório** nem para a documentação. Este documento descreve a interface em palavras próprias.
- O coletor deve ter **definições próprias, mínimas**, só dos campos usados, escritas à mão e conferidas contra o jogo (tamanho do mapa, posições dos campos). Projetos abertos (Pitwall, MIT; TinyPedal, GPL-3.0) fazem assim, o que mostra que é prática comum, mas não é um parecer jurídico.
- Vale decidir se o dono quer consultar a Studio 397 antes de distribuir o coletor para terceiros. Para uso próprio, o risco é baixo; para um produto, é uma decisão do dono.

## Riscos e pontos em aberto

1. **O layout pode mudar com o jogo.** Os próprios avisos da comunidade dizem que o layout de memória não tem garantia de estabilidade. O campo de versão do jogo e uma conferência do tamanho do mapa na conexão devem fazer o coletor recusar uma versão desconhecida em vez de ler lixo.
2. **`dist` por amostra não vem pronto.** A distância na volta está na pontuação (poucas vezes por segundo), enquanto a telemetria chega a 100 Hz. Proposta: ancorar em cada atualização da pontuação e integrar velocidade × variação de tempo entre elas; recomeçar a cada troca de número da volta. **A validar com um jogo real.**
3. **Volta válida ou anulada** (`lap.valid`): não achei um campo direto na pontuação. A verificar (penalidades, ou a volta ter sido fechada no box).
4. **Eixos de `x`, `y`, `z`:** o arquivo de volta descreve leste, cima e norte; os eixos reais do jogo precisam ser conferidos antes de desenhar o mapa da pista.
5. **Valores zerados esporádicos** (combustível 0 por um quadro) e campos que o rFactor 2 preenchia e o LMU pode não preencher foram relatados por outros projetos. Tratar zero suspeito como NaN.
6. **Dois carros do jogador** apareceram em uma captura de outro projeto (mesmo "lugar" em duas linhas). Identificar o jogador pelo índice da telemetria e por "é o jogador", não pela posição na corrida.
7. Nada aqui foi testado ao vivo. O primeiro passo real é um leitor mínimo que despeje uma volta com o jogo aberto.

## Escolha da linguagem do coletor

**Decidido em 10/11/2026: Rust.** A primeira versão está em [`collector/`](../../collector/README.md): grava as voltas no formato de arquivo de volta e traz o comando `probe` para validar com o jogo aberto. Ainda não foi testada com o jogo rodando. O restante desta seção registra por que a escolha foi essa.

O plano previa .NET. Mudou o que há instalado:

| Opção | Prós | Contras |
|---|---|---|
| **Rust** (já instalado) | Pronto para compilar agora; executável único sem runtime; um projeto aberto de LMU já usa uma ponte em Rust | Menos familiar em apps de bandeja; interface gráfica simples fica para depois |
| **.NET 8** | Boa para app de bandeja e atualização; ótimo para quem for manter | Falta o SDK: `winget install Microsoft.DotNet.SDK.8` (instala software na máquina) |
| Python (já instalado) | Muito rápido para uma sonda de descoberta | Distribuição para outras pessoas é pior |

A especificação do arquivo de volta vale para qualquer uma: o vetor de teste de 396 bytes é o critério de aceite.

## Fontes

- Cabeçalhos do jogo: `Support\SharedMemoryInterface` na instalação (leitura local).
- [Telemetry, Le Mans Ultimate Wiki](https://lemansultimate.wiki.gg/wiki/Telemetry): gravador próprio (`.ld`, `.csv`) e aviso de compatibilidade por versão.
- [TinyPedal](https://github.com/TinyPedal/TinyPedal): "no plugin required" no Windows, com "Enable Plugins" ligado; GPL-3.0.
- [LMU Pitwall](https://github.com/Swizzjack/lmu-pitwall): lê `LMU_Data` (100 Hz telemetria, 5 Hz pontuação), REST na 6397; MIT.
- [race-engineer, LMU integration](https://github.com/Alexander-Gro/race-engineer/blob/main/docs/03-LMU-INTEGRATION.md): nomes de campos, unidades, armadilhas conhecidas.
- [irdashies PR 778](https://github.com/tariknz/irdashies/pull/778) e [LMUTelemetry](https://github.com/pavva94/LMUTelemetry): outros leitores de LMU (não lidos a fundo).
