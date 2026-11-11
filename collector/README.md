# Coletor Xpeed (Windows)

Programa pequeno em Rust que lê a telemetria de um jogo de corrida no Windows e grava cada volta no **formato de arquivo de volta** do Xpeed ([FORMATO-DE-VOLTA.md](../docs/telemetria-virtual-2026-11-10/FORMATO-DE-VOLTA.md)). O primeiro jogo é o **Le Mans Ultimate**; como ele expõe os dados está em [LMU-TELEMETRIA.md](../docs/telemetria-virtual-2026-11-10/LMU-TELEMETRIA.md).

**Estado: primeira versão, ainda não testada com o jogo aberto.** O que está provado: o arquivo gerado bate byte a byte com o vetor de teste da especificação e é aceito pelo leitor estrito do app; a leitura da memória compartilhada funciona contra um "jogo falso" que cria os mesmos objetos do Windows; a lógica de cortar voltas passa em 14 cenários sintéticos. O que **não** está provado: que os números do layout correspondem ao jogo ao vivo e que a distância e a validade da volta saem certas com dados reais. Para isso existe o comando `probe`.

Não há envio para o Xpeed, pareamento, ícone de bandeja nem outros jogos ainda: o coletor só grava arquivos numa pasta.

## Compilar

Precisa de um Rust recente (testado com a 1.99; o clippy do CI usa o estável mais novo) e do MSVC Build Tools.

```powershell
cd collector
cargo build --release
# o programa fica em target\release\xpeed-collector.exe
```

## Comandos

```powershell
xpeed-collector probe [--seconds N]    # confere a conexão e mostra o que o jogo envia (nada é gravado)
xpeed-collector record --out DIR       # grava cada volta em DIR como .xlap.gz (Ctrl+C para parar)
xpeed-collector inspect ARQUIVO        # resume um arquivo de volta (funciona em qualquer sistema)
```

## Como validar com o jogo aberto (o próximo passo)

1. Abra o Le Mans Ultimate e entre numa sessão com o carro (garagem ou pista). **Settings > Gameplay > "Enable external plugins"** precisa estar ligado (já está na sua instalação).
2. Rode `xpeed-collector probe --seconds 10`. Confira:
   - "Connected" e o tamanho da memória marcado como **same size**. Se disser DIFFERENT, o layout do jogo mudou: não grave nada e regenere o arquivo de posições (abaixo);
   - telemetria perto de **100 Hz** e pontuação de poucos Hz;
   - o carro e a pista corretos, e a velocidade, a rotação e a marcha mudando como no jogo.
3. Dê duas ou três voltas completas com `record`:
   ```powershell
   xpeed-collector record --out $env:USERPROFILE\Documents\xpeed-laps
   ```
   e abra o resultado: `xpeed-collector inspect <arquivo>`. Compare o tempo de volta e os setores com os do jogo. Confira que `dist` termina perto do comprimento da pista e nunca diminui.
4. Anote o que não bate. Os pontos mais prováveis de erro estão em [LMU-TELEMETRIA.md](../docs/telemetria-virtual-2026-11-10/LMU-TELEMETRIA.md) (distância por amostra, volta válida, eixos de x/y/z).

## Como a volta é cortada

Veja o comentário no topo de `src/recorder.rs`. Em resumo: a volta vai de uma troca do número de volta do jogo até a próxima; `t` vem do relógio da própria volta; `dist` é a integral da velocidade, reancorada em cada atualização de pontuação; a volta espera até 3 segundos pelo tempo oficial; volta em que o coletor entrou no meio, com menos de 5 s ou menos de 50 amostras é descartada. **`valid` é um julgamento nosso** (tempo oficial confere com a telemetria e o carro não passou pelo box), não o veredito do jogo sobre pista cortada.

## Posições dos campos (`src/lmu/layout.rs`)

Arquivo **gerado**, só com números (tamanhos e posições em bytes). Vem de um programa em C++ (`tools/layout_check.cpp`) compilado contra os cabeçalhos que o próprio jogo instala. **Os cabeçalhos não ficam no repositório**: a licença deles não permite redistribuir. Depois de uma atualização do jogo, ou quando o `probe` disser DIFFERENT:

```powershell
pwsh collector/tools/regen-layout.ps1 -GameDir 'F:\SteamLibrary\steamapps\common\Le Mans Ultimate'
```

Precisa do jogo instalado e do Visual Studio C++ Build Tools. O script foi conferido: reproduz o arquivo atual idêntico.

## Testes

```powershell
cargo test            # 43 testes
cargo fmt --check
cargo clippy --all-targets -- -D warnings
```

Os testes do leitor criam objetos do Windows **com nomes próprios** (nunca `LMU_Data`), então não tocam na memória de um jogo que esteja rodando. O teste `writes_a_sample_lap_to_disk` é opcional (`--ignored`): grava uma volta de exemplo para apontar outro programa, como o leitor do app, para o que o gravador produz.

## Segurança e limites

- A memória do jogo é aberta **somente para leitura**. A única escrita é na trava que o próprio protocolo do jogo exige.
- O tamanho do mapa é conferido antes de ler; um tamanho diferente do conhecido faz o `record` recusar.
- Só o carro do jogador é lido, e o **nome do piloto nunca é guardado**.
- O arquivo é gravado em `.part` e renomeado ao final, então um arquivo incompleto nunca aparece com o nome final.
