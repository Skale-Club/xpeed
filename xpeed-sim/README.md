# Xpeed Companion (Windows)

Programa para Windows, em Rust, que lê a telemetria de um jogo de corrida e a leva para a sua conta Xpeed. Grava cada volta no **formato de arquivo de volta** do Xpeed ([FORMATO-DE-VOLTA.md](../docs/telemetria-virtual-2026-11-10/FORMATO-DE-VOLTA.md)) e, se estiver conectado, envia as voltas para a nuvem. O primeiro jogo é o **Le Mans Ultimate**; como ele expõe os dados está em [LMU-TELEMETRIA.md](../docs/telemetria-virtual-2026-11-10/LMU-TELEMETRIA.md).

Os outros jogos têm leitores em `src/games/` (Assetto Corsa e família, AC EVO, Automobilista 2, **Project CARS 2 e 3**, F1 25, **F1 24 e F1 23**, Stock Car Extreme, **Automobilista e rFactor**, **RaceRoom**, **Forza Motorsport e Forza Horizon 4/5**, Wreckfest 2 e **iRacing**). O Forza manda os dados pela rede: no jogo, Data Out ligado, IP 127.0.0.1 e porta **5301**. Os leitores de RaceRoom, Forza, F1 24/23, Automobilista e rFactor ainda não foram testados com os jogos abertos. Os Project CARS 2 e 3 usam o leitor do Automobilista 2: os três gravam a mesma memória compartilhada, e o que o leitor usa fica na parte comum. Ainda falta testar com os jogos abertos. O iRacing é lido pelo SDK oficial do próprio jogo, sem instalar nada. Como a telemetria ao vivo dele não traz a posição do carro, o mapa da volta é estimado pela velocidade e pelo rumo. Ainda falta testar esse leitor com o jogo aberto; o que falta confirmar está no início de `src/games/iracing.rs`.

**Estado: primeira versão, ainda não testada com o jogo aberto.** O que está provado: o arquivo gerado bate byte a byte com o vetor de teste da especificação e é aceito pelo leitor estrito do app; a leitura da memória compartilhada funciona contra um "jogo falso" que cria os mesmos objetos do Windows; a lógica de cortar voltas passa em 14 cenários sintéticos; o envio funciona contra os handlers do servidor; o ícone na bandeja abre, mostra o estado e fecha. O que **não** está provado: que os números do layout correspondem ao jogo ao vivo e que a distância e a validade da volta saem certas com dados reais. Para isso existe o comando `probe`.

## Como se usa

Sem argumentos (menu Iniciar, ou ao ligar o Windows), o Xpeed Companion roda como um **ícone na bandeja**. A bolinha no canto do ícone mostra o estado: cinza (gravação pausada), âmbar (esperando o jogo), verde (conectado ou gravando), vermelho (precisa de atenção). O ícone é a marca verdadeira do Xpeed ([branding/README.md](../branding/README.md)).

Clicar no ícone abre o **painel**; o botão direito abre o menu. Menu do ícone: o estado do jogo e da conta, **Abrir o painel**, **Conectar à sua conta…**, **Abrir a pasta das voltas**, **Pausar/Retomar a gravação**, **Iniciar com o Windows**, **Idioma** e **Sair**. Um balão avisa cada volta gravada, um lote de voltas enviado de uma vez, a conexão e uma chave recusada.

**Idioma:** o programa abre em **inglês** (decisão do dono, 12/11/2026: inglês primeiro). Português e espanhol aparecem só se a pessoa escolher em **Language**, no menu. A escolha fica gravada no arquivo `language`, em `%APPDATA%\Xpeed Companion`.

**O painel** (`src/panel.rs`) é uma janela com duas abas:

- **Dashboard:** o que aparece enquanto se dirige, no lugar do SimHub:
  - marcha, velocidade, barra de giro (verde, âmbar e vermelho perto do limite);
  - tempo da volta e diferença para a melhor volta (verde quando mais rápido);
  - última e melhor volta, pedais, volante, combustível e o ponto da volta em que o carro está.
- **Monitor:** o estado de cada leitor de jogo, a conta, as voltas gravadas e as últimas linhas do registro.

Atalhos do painel:

- `1` e `2` trocam de aba.
- **Tela cheia:** `F11`, o botão no topo ou um duplo clique na janela. `Esc` sai.
- **Sempre por cima:** `T`.

Em tela cheia, o dashboard cresce junto com a tela. O painel é desenhado com GDI 30 vezes por segundo e se ajusta ao DPI da tela; fechar a janela não para a gravação.

Para ver o painel sem jogo aberto, rode `xpeed-companion panel-demo`, que mostra uma pilotagem inventada sem gravar nem enviar nada. `xpeed-companion panel` abre o painel da cópia que já está rodando.

- **Conectar:** no Xpeed (Virtual > Xpeed Companion) a pessoa clica em Conectar no programa (ou no painel): o navegador abre a página `<servidor>/companion/connect/<id>`, onde ela confirma uma vez. O servidor devolve também um **código de 4 caracteres** (`verifyCode`, opcional: servidores antigos não mandam); o cartão de conta mostra o código em tamanho grande, com o aviso "The page should show the code …", e a página do site mostra o mesmo código para a pessoa conferir. Não há mais esquema de URL registrado no Windows (o instalador apaga o antigo). Pelo terminal também dá: `xpeed-companion pair --server https://… --code ABCD-2345`.
- **Onde ficam as coisas:** voltas em `Documentos\Xpeed Companion\Laps` (ou `XPEED_COMPANION_LAPS`); configuração e o registro (`companion.log`) em `%APPDATA%\Xpeed Companion` (ou `XPEED_COMPANION_HOME`). Os nomes antigos `XPEED_SIM_HOME` e `XPEED_SIM_LAPS` ainda valem como alternativa. Na primeira abertura depois da atualização, as pastas antigas (`%APPDATA%\Xpeed Sim` e `Documentos\Xpeed Sim`) são **movidas** para as novas (se mover não der, copia e confere, e a antiga fica intocada; se as duas existirem, nada é feito). A chave do aparelho **nunca** é impressa nem vai para o registro.
- **Uma cópia por vez:** abrir de novo não abre outra.
- **Falhas ficam à vista e o programa se recupera:** todo *panic* vai para `companion.log` (mensagem, lugar, linha de execução, versão e build). Os trabalhadores de longa duração (leitores de jogos, Le Mans Ultimate, construtor de pistas, envio) rodam sob um supervisor (`src/supervisor.rs`): se um falha, volta depois de 1 s, 2 s, 5 s, 10 s, 30 s, até 5 vezes em 10 minutos; depois disso é dado como parado e o painel o mostra em vermelho. A bandeja continua de pé.
- **Copiar diagnóstico:** na aba Monitor, o botão põe na área de transferência um texto para suporte (versão e build, Windows, jogos e estado de cada leitor, conexão com o servidor e a conta, **nunca a chave**, as últimas 40 linhas do registro, o tamanho da pasta de voltas e quantas esperam envio).

## Versões

Todo instalador que sai desta máquina leva uma versão nova (`version` no `Cargo.toml`): *patch* (0.2.1) para correções, *minor* (0.3.0) para recursos novos. O instalador usa essa versão no nome (`dist\xpeed-companion-setup-<versão>.exe`) e o programa a mostra no painel (`v0.2.0`) e nas propriedades do `.exe`. O carimbo da compilação (hash curto do commit, com `-dirty` se havia mudanças não commitadas) separa duas compilações da mesma versão: aparece no log ao iniciar e ao passar o mouse sobre a versão no painel. O `installer\build.ps1` imprime os dois e avisa em voz alta se o instalador dessa versão já existe, sinal de que a versão não foi subida.

## Compilar

Precisa de um Rust recente (testado com a 1.99; o clippy do CI usa o estável mais novo) e do MSVC Build Tools.

```powershell
cd xpeed-sim
cargo build --release
# o programa fica em target\release\xpeed-companion.exe
```

## Comandos (para quem usa o terminal)

O programa não tem console próprio (é um aplicativo de bandeja): num terminal ele empresta o do terminal. Se a saída aparecer depois do prompt, é por isso.

```powershell
xpeed-companion run                          # a bandeja (o mesmo que sem argumentos)
xpeed-companion probe [--seconds N]    # confere a conexão e mostra o que o jogo envia (nada é gravado)
xpeed-companion record --out DIR       # grava cada volta em DIR como .xlap.gz (Ctrl+C para parar)
xpeed-companion record --out DIR --upload   # idem, e envia cada volta ao Xpeed (precisa parear antes)
xpeed-companion inspect ARQUIVO        # resume um arquivo de volta (funciona em qualquer sistema)
xpeed-companion pair --server ENDEREÇO --code CÓDIGO [--name NOME]   # liga este computador à sua conta
xpeed-companion status                 # mostra se este computador está pareado
xpeed-companion unpair                 # esquece o pareamento neste computador
xpeed-companion upload DIR             # envia as voltas de DIR que ainda não foram
xpeed-companion make-icon ARQUIVO      # escreve o ícone (a marca do Xpeed) em ARQUIVO.ico
```

## Envio para o Xpeed

O contrato com o servidor está em [ENVIO-DE-VOLTAS.md](../docs/telemetria-virtual-2026-11-10/ENVIO-DE-VOLTAS.md). O servidor implementa isso em `api/sim/*`. O Xpeed Companion foi testado contra um servidor falso e também contra os handlers de verdade, com o programa de verdade (`pair`, `upload`, `status`, `unpair`). O que não foi testado: HTTPS de verdade (os testes usam `http://localhost`), e o `record --upload` com o jogo aberto. O código de pareamento vem de `POST /api/sim/codes`; a tela do app para pedi-lo ainda não existe.

- **Parear uma vez:** no app, peça um código; no computador, `xpeed-companion pair --server https://… --code ABCD-2345`. O endereço precisa ser `https://` (só `localhost` aceita `http://`), para a chave do aparelho nunca viajar em texto aberto. A chave fica em `%APPDATA%\Xpeed Companion\config.json` (ou na pasta que `XPEED_COMPANION_HOME` indicar), **protegida pelo Windows** (DPAPI, campo `tokenProtected`: só abre para o mesmo usuário do Windows no mesmo perfil), e **nunca é impressa**. Um arquivo antigo, com a chave em texto (`token`), continua valendo e é reescrito protegido na primeira leitura, só depois de conferir que a cópia protegida abre para a mesma chave. Se a chave protegida não abrir (perfil copiado para outro usuário ou PC), o programa fica "não conectado" com o aviso "Reconnect this computer.", **sem apagar o arquivo**; conectar de novo o substitui.
- **A pasta de voltas é a fila.** O que já foi enviado (ou recusado) fica anotado em `.xpeed-upload.json`, ao lado das voltas. Se a rede cair, o computador desligar ou o servidor estiver fora, as voltas continuam na pasta e a próxima execução segue de onde parou. Nenhum arquivo de volta é apagado, movido ou alterado.
- **Gravar não espera o envio:** em `record --upload` o envio roda em outra linha de execução; a leitura do jogo não perde amostra por causa de uma rede lenta. Com falha passageira ele tenta de novo com espera crescente (30 s até 5 min), e a cada volta nova.
- **Chave recusada ou revogada:** o envio para e avisa para parear de novo; a gravação continua e nada se perde.
- **Só sai do computador o que é uma volta válida:** antes de enviar, o arquivo passa pelo leitor estrito do formato.
- **Sem redirecionamento:** o Xpeed Companion não segue redirecionamentos, para a chave nunca ir para outro endereço.

## Como validar com o jogo aberto (o próximo passo)

1. Abra o Le Mans Ultimate e entre numa sessão com o carro (garagem ou pista). **Settings > Gameplay > "Enable external plugins"** precisa estar ligado (já está na sua instalação).
2. Rode `xpeed-companion probe --seconds 10`. Confira:
   - "Connected" e o tamanho da memória marcado como **same size**. Se disser DIFFERENT, o layout do jogo mudou: não grave nada e regenere o arquivo de posições (abaixo);
   - telemetria perto de **100 Hz** e pontuação de poucos Hz;
   - o carro e a pista corretos, e a velocidade, a rotação e a marcha mudando como no jogo.
3. Dê duas ou três voltas completas com `record`:
   ```powershell
   xpeed-companion record --out $env:USERPROFILE\Documents\xpeed-laps
   ```
   e abra o resultado: `xpeed-companion inspect <arquivo>`. Compare o tempo de volta e os setores com os do jogo. Confira que `dist` termina perto do comprimento da pista e nunca diminui.
4. Anote o que não bate. Os pontos mais prováveis de erro estão em [LMU-TELEMETRIA.md](../docs/telemetria-virtual-2026-11-10/LMU-TELEMETRIA.md) (distância por amostra, volta válida, eixos de x/y/z).

## Como a volta é cortada

Veja o comentário no topo de `src/recorder.rs`. Em resumo: a volta vai de uma troca do número de volta do jogo até a próxima; `t` vem do relógio da própria volta; `dist` é a integral da velocidade, reancorada em cada atualização de pontuação; a volta espera até 3 segundos pelo tempo oficial; volta em que o Xpeed Companion entrou no meio, com menos de 5 s ou menos de 50 amostras é descartada. **`valid` é um julgamento nosso** (tempo oficial confere com a telemetria e o carro não passou pelo box), não o veredito do jogo sobre pista cortada.

## Posições dos campos (`src/lmu/layout.rs`)

Arquivo **gerado**, só com números (tamanhos e posições em bytes). Vem de um programa em C++ (`tools/layout_check.cpp`) compilado contra os cabeçalhos que o próprio jogo instala. **Os cabeçalhos não ficam no repositório**: a licença deles não permite redistribuir. Depois de uma atualização do jogo, ou quando o `probe` disser DIFFERENT:

```powershell
pwsh xpeed-sim/tools/regen-layout.ps1 -GameDir 'F:\SteamLibrary\steamapps\common\Le Mans Ultimate'
```

Precisa do jogo instalado e do Visual Studio C++ Build Tools. O script foi conferido: reproduz o arquivo atual idêntico.

## Testes

```powershell
cargo test            # 69 testes (26 são do envio: rede de verdade contra um servidor falso local)
cargo fmt --check
cargo clippy --all-targets -- -D warnings
```

Os testes do leitor criam objetos do Windows **com nomes próprios** (nunca `LMU_Data`), então não tocam na memória de um jogo que esteja rodando. O teste `writes_a_sample_lap_to_disk` é opcional (`--ignored`): grava uma volta de exemplo para apontar outro programa, como o leitor do app, para o que o gravador produz.

## Segurança e limites

- A memória do jogo é aberta **somente para leitura**. A única escrita é na trava que o próprio protocolo do jogo exige.
- O tamanho do mapa é conferido antes de ler; um tamanho diferente do conhecido faz o `record` recusar.
- Só o carro do jogador é lido, e o **nome do piloto nunca é guardado**.
- O arquivo é gravado em `.part` e renomeado ao final, então um arquivo incompleto nunca aparece com o nome final.
- A chave do aparelho é um arquivo comum da pasta do usuário (não está no Gerenciador de Credenciais do Windows): quem lê a sua pasta lê a chave. Ela só deve valer para **enviar** voltas, e se revoga no app.
