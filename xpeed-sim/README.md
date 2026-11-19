# Xpeed Companion (Windows)

Programa para Windows, em Rust, que lê a telemetria de um jogo de corrida e a leva para a sua conta Xpeed. Grava cada volta no **formato de arquivo de volta** do Xpeed ([FORMATO-DE-VOLTA.md](../docs/telemetria-virtual-2026-11-10/FORMATO-DE-VOLTA.md)) e, se estiver conectado, envia as voltas para a nuvem. O primeiro jogo é o **Le Mans Ultimate**; como ele expõe os dados está em [LMU-TELEMETRIA.md](../docs/telemetria-virtual-2026-11-10/LMU-TELEMETRIA.md).

Os outros jogos têm leitores em `src/games/` (Assetto Corsa e família, AC EVO, Automobilista 2, **Project CARS 2 e 3**, F1 25, **F1 24 e F1 23**, Stock Car Extreme, **Automobilista e rFactor**, **RaceRoom**, **Forza Motorsport e Forza Horizon 4/5**, Wreckfest 2 e **iRacing**). O Forza manda os dados pela rede: no jogo, Data Out ligado, IP 127.0.0.1 e porta **5301**. Os leitores de RaceRoom, Forza, F1 24/23, Automobilista e rFactor ainda não foram testados com os jogos abertos. Os Project CARS 2 e 3 usam o leitor do Automobilista 2: os três gravam a mesma memória compartilhada, e o que o leitor usa fica na parte comum. Ainda falta testar com os jogos abertos. O iRacing é lido pelo SDK oficial do próprio jogo, sem instalar nada. Como a telemetria ao vivo dele não traz a posição do carro, o mapa da volta é estimado pela velocidade e pelo rumo. Ainda falta testar esse leitor com o jogo aberto; o que falta confirmar está no início de `src/games/iracing.rs`.

**Experimental project.** Development remains free of paid signing services; unsigned installers are expected and Windows may show an unknown-publisher warning. Signing is optional, not a release requirement (owner, 2026-11-16).

**Optional Session Coach (0.12.0).** The connected Monitor opens a separate native conversation window, off by default. The account owner must also explicitly allow that computer at `/virtual/companion`; recording and uploads never require the assistant. Choose an uploaded session and send a question manually to reuse the website's persisted coach, goals and associated setup context. Provider credentials remain server-side and super-admin-only. Record uses an installed matching Microsoft desktop recognition engine and fills a draft for review; Speak answer is a separate explicit action using a matching installed voice. Audio stays local, with no audio files or uploads. Missing language engines preserve text entry. Closing/disabling/re-pairing drops stale results and stops its speech process; a private kill-on-close Windows job prevents an orphan child. Dictation is bounded at 15 seconds and reading at 120 seconds. Native controls currently use English; answers and speech follow the app language at opening. Windows CI verifies formatting, Clippy, tests, release compilation and installer packaging. Interactive window/audio and real driving acceptance are separate manual checks: see [acceptance](../docs/platform/VIRTUAL-COACH-ACCEPTANCE.md).

The Windows CI checks formatting, Clippy, unit/contract tests, a release build and installer packaging. Some EVO and AMS2 fields have live evidence; many other reader conventions remain assumptions. Four sanitized real lap files now exercise compatibility and diagnostics under [`fixtures/laps/`](fixtures/laps/README.md). These are recorded outputs, not raw game-reader captures. Raw `.xcap` acceptance captures still need a running game and must not be replaced with invented samples.

**Capture and disk limits:** an unfinished lap is released after 100,000 samples or one hour on its lap clock; a visible warning is raised and recording can resume at the next lap boundary. Compression, disk writes and retry waits run in a separate worker from each reader. Accepted pending laps are retained within a bounded queue (five laps and 64 MiB, including the in-flight lap). Queue saturation or disk failure pauses recording with a warning; already accepted laps are not evicted to make room. The writer retries while paused and drains on shutdown. If storage remains unwritable at shutdown, RAM-only laps cannot be guaranteed durable and the loss is reported explicitly. Previously saved lap files remain intact.

## Como se usa

Sem argumentos (menu Iniciar, ou ao ligar o Windows), o Xpeed Companion roda como um **ícone na bandeja**. A bolinha no canto do ícone mostra o estado: cinza (gravação pausada), âmbar (esperando o jogo), verde (conectado ou gravando), vermelho (precisa de atenção). O ícone é a marca verdadeira do Xpeed ([branding/README.md](../branding/README.md)).

Clicar no ícone abre o **painel**; o botão direito abre o menu. Menu do ícone: o estado do jogo e da conta, **Abrir o painel**, **Conectar à sua conta…**, **Abrir a pasta das voltas**, **Pausar/Retomar a gravação**, **Iniciar com o Windows**, **Idioma** e **Sair**. Um balão avisa cada volta gravada, um lote de voltas enviado de uma vez, a conexão e uma chave recusada.

**Idioma:** o programa abre em **inglês** (decisão do dono, 12/11/2026: inglês primeiro). Português e espanhol aparecem só se a pessoa escolher em **Language**, no menu. A escolha fica gravada no arquivo `language`, em `%APPDATA%\Xpeed Companion`.

**O painel** (`src/panel/`: `tokens`, `model`, `layout` e as telas) é uma janela com duas abas:

- **Dashboard:** o que aparece enquanto se dirige, no lugar do SimHub:
  - marcha, velocidade, barra de giro (verde, âmbar e vermelho perto do limite);
  - tempo da volta e diferença para a melhor volta (verde quando mais rápido);
  - última e melhor volta, pedais, volante, combustível e o ponto da volta em que o carro está.
- **Monitor:** o estado de cada leitor de jogo, a conta, as voltas gravadas e as últimas linhas do registro.

**Forma (decisão do dono, 12/11/2026):** todo elemento sólido do painel e da janela do Coach (card, aba, botão, pílula, chip, barra, interruptor) tem **um só canto, quase reto, de 2,5 px**: a "pílula quadrada", como nas telas de corrida. É o token `R_CORNER` em `src/panel/tokens.rs`. `Painter::round` não aceita outro raio, e o teste `one_near_square_corner` falha se alguém voltar à escala de raios do site (4/6/8/10), como aconteceu em 16/11. Mudar o canto é decisão do dono, registrada no Journal antes do código.

**Ver o painel sem Rust:** o CI desenha todas as telas (teste `writes_the_design_preview_page`) e guarda a página como artefato `companion-panel-preview`. `powershell -NoProfile -File xpeed-sim/tools/fetch-panel-preview.ps1 -Wait` baixa a última rodada da branch atual para `target/panel-preview`, e a entrada `xpeed-sim-panel-preview` do `.claude/launch.json` serve a página, que se recarrega sozinha.

Atalhos do painel:

- `1` e `2` trocam de aba.
- **Tela cheia:** `F11`, o botão no topo ou um duplo clique na janela. `Esc` sai.
- **Sempre por cima:** `T`.
- **Dashboard:** `D` troca entre Corrida, Classificação, Treino, Contra o relógio e Automático (escolhido pela sessão do jogo). A escolha fica guardada por jogo em `dashboards.json`, na pasta do Companion; o nome aparece ao lado das abas ("Race · Auto" quando automático).

O painel monta cada dashboard a partir de um catálogo de widgets com id estável (`src/panel/catalog.rs`) e de dashboards como dados (`src/panel/dashboards.rs`: linhas de widgets por formato de janela); por enquanto os quatro usam as mesmas linhas. Os modelos do painel são serializáveis (serde, camelCase): são o contrato que a visão do celular vai ler.

O card **Session** (nas dashboards Corrida e Classificação) mostra a posição (`P3 / 24`), a posição na classe e o tempo restante (ou a volta `5 / 20` e quantas faltam) quando o jogo dá esses dados; no card de combustível, a linha **To the end** soma as voltas até o fim da sessão (com uma volta de margem) e diz quantos litros abastecer.

Em tela cheia, o dashboard cresce junto com a tela. O painel é desenhado com GDI 30 vezes por segundo e se ajusta ao DPI da tela; fechar a janela não para a gravação.

Para ver o painel sem jogo aberto, rode `xpeed-companion panel-demo`, que mostra uma pilotagem inventada sem gravar nem enviar nada. `xpeed-companion panel` abre o painel da cópia que já está rodando.

- **Conectar:** no Xpeed (Virtual > Xpeed Companion) a pessoa clica em Conectar no programa (ou no painel): o navegador abre a página `<servidor>/companion/connect/<id>`, onde ela confirma uma vez. O servidor devolve também um **código de 4 caracteres** (`verifyCode`, opcional: servidores antigos não mandam); o cartão de conta mostra o código em tamanho grande, com o aviso "The page should show the code …", e a página do site mostra o mesmo código para a pessoa conferir. Não há mais esquema de URL registrado no Windows (o instalador apaga o antigo). Pelo terminal também dá: `xpeed-companion pair --server https://… --code ABCD-2345`.
- **Onde ficam as coisas:** voltas em `Documentos\Xpeed Companion\Laps` (ou `XPEED_COMPANION_LAPS`); configuração e o registro (`companion.log`) em `%APPDATA%\Xpeed Companion` (ou `XPEED_COMPANION_HOME`). Os nomes antigos `XPEED_SIM_HOME` e `XPEED_SIM_LAPS` ainda valem como alternativa. Na primeira abertura depois da atualização, as pastas antigas (`%APPDATA%\Xpeed Sim` e `Documentos\Xpeed Sim`) são **movidas** para as novas (se mover não der, copia e confere, e a antiga fica intocada; se as duas existirem, nada é feito). A chave do aparelho **nunca** é impressa nem vai para o registro.
- **Uma cópia por vez:** abrir de novo não abre outra.
- **Atualiza sozinho (a partir da 0.6.0):** 30 s depois de abrir e a cada 6 horas o programa pergunta ao servidor (`GET /api/companion/latest`) qual é a versão mais nova. Se for maior que a dele, baixa o instalador (só por HTTPS, do próprio servidor, do `github.com` e dos hosts de arquivos do GitHub, no máximo 3 redirecionamentos), confere o tamanho e o SHA-256 e roda o instalador em silêncio. **Nunca atualiza com um jogo aberto** (nem uma atualização obrigatória) e não mexe na conexão, nas voltas nem na configuração. "Atualizar automaticamente" (menu da bandeja, ligado por padrão; fica em `config.json` como `autoUpdate`), "Verificar atualizações" e "Atualizar agora" estão no menu da bandeja. A aba Monitor tem sempre o card "Atualização", como o do Xdeck: a versão e o que o atualizador está fazendo ("procura atualizações sozinho", "Verificando atualizações…", "está atualizada · verificado há 5 min", "Não foi possível verificar atualizações", "Baixando 0.6.0… 42%" com barra, "Atualização disponível: 0.6.0") e o botão que cabe: "Verificar agora", "Tentar de novo" ou "Atualizar agora". Pela bandeja, a verificação pedida também avisa por balão se está atualizado ou se falhou. Como tudo funciona: [`docs/platform/RELEASES.md`](../docs/platform/RELEASES.md). Versões antes da 0.6.0 precisam ser instaladas uma vez à mão.
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
xpeed-companion capture JOGO [--seconds N] [--out ARQ.xcap] [--build TEXTO]   # grava o que o leitor do jogo vê (para testes)
xpeed-companion replay ARQ.xcap [--laps-out DIR] [--speed X]   # toca a gravação pelo leitor, o cortador de voltas e as checagens
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
- **Sinal de vida (a partir da 0.7.0):** com o computador pareado, o programa avisa o servidor (`POST /api/sim/heartbeat`) ao abrir, a cada 60 s e na hora em que um jogo conecta ou fecha (ou a leitura é pausada), para o site mostrar "Online" de verdade (antes só o envio de uma volta contava). Vai só a versão, o estado (`idle`, `waiting`, `connected` e, a partir da 0.8.0, `needs_setup`), o id do jogo e quantas voltas esperam envio: nada pessoal. Roda em uma linha de execução própria, sob o supervisor (`src/heartbeat.rs`), nunca atrasa a leitura; falha é nova tentativa em silêncio com as esperas do envio (30 s até 5 min), com uma linha no `companion.log` só quando a falha começa e quando o servidor volta a ouvir. Contrato: [ENVIO-DE-VOLTAS.md](../docs/telemetria-virtual-2026-11-10/ENVIO-DE-VOLTAS.md), seção 2c.
- **Primeira abertura guiada (a partir da 0.8.0):** cada jogo tem uma opção que precisa estar ligada para ele compartilhar dados, e é aí que muita gente desiste. O programa separa três estados por jogo (`src/watch.rs`, relógio e lista de programas passados de fora, então testável): **não está aberto**, **aberto e compartilhando** e **aberto, mas sem compartilhar** (o programa do jogo roda e o leitor não acha dados; os primeiros 45 s contam como "carregando", por causa das telas de abertura). No terceiro estado o painel (tela do jogo aberto) mostra em uma ou duas linhas **a opção exata a ligar** (`Msg::Setup` em `src/text.rs`, em inglês, português e espanhol; os nomes de menu ficam como no jogo), a bandeja dá **um único balão** por jogo em cada execução (`Notice::NeedsSetup`, guardado em `Shared::told_setup`) e o sinal de vida manda `needs_setup` com o jogo, para o cartão do computador no site dizer a mesma coisa (`src/lib/sim/game-setup.ts`). Os jogos que não têm nada a ligar (Assetto Corsa e família, RaceRoom, iRacing) mandam começar uma sessão e ir para a pista. Os textos de cada jogo foram conferidos contra as notas dos leitores em `src/games/`; o que não pôde ser conferido no jogo aberto: o caminho do menu do Project CARS 2 e 3, do Forza Motorsport 7 e do Le Mans Ultimate (o resto das opções é o do próprio leitor).
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

Todos os jogos, inclusive o Le Mans Ultimate, passam pela mesma máquina de sessão (`src/session.rs`) e pelo mesmo cortador (`src/lapcut.rs`); o LMU entra como fonte em `src/lmu/source.rs`. Em resumo: a volta vai de uma troca do número de volta do jogo até a próxima; `t` vem do relógio da própria volta; no LMU, `dist` é a integral da velocidade, reancorada em cada atualização de pontuação; a volta espera até 3 segundos pelo tempo oficial; volta em que o Xpeed Companion entrou no meio, com menos de 5 s ou menos de 50 amostras é descartada. **`valid` é um julgamento nosso** (tempo oficial confere com a telemetria e o carro não passou pelo box), não o veredito do jogo sobre pista cortada.

## Formato de volta, versão 2 (Companion 0.5)

O Companion 0.5 grava a **versão 2** do arquivo de volta (o leitor do app aceita as versões 1 e 2, então as voltas antigas e as já enviadas continuam valendo). O que a versão 2 acrescenta, e como cada jogo preenche, está em [FORMATO-DE-VOLTA.md](../docs/telemetria-virtual-2026-11-10/FORMATO-DE-VOLTA.md):

- **Cabeçalho:** `sessionId` (um por sessão do jogo, criado quando o leitor abre o jogo e de novo quando a pista, o carro ou o tipo de sessão muda, ou a sessão é reiniciada), `sessionKind`, `weather`, `airTempC`, `trackTempC`, `tyreCompound`, `lap.inLap`, `lap.outLap` e `lap.sectorsMs`.
- **Canais:** `tyre_temp_*`, `tyre_press_*`, `tyre_wear_*`, `brake_temp_*` (fl, fr, rl, rr), `g_lat`, `g_long`, `damage_body`, `drs`, `tc_active`, `abs_active`. Só entram no arquivo quando o jogo dá o valor.
- **Assetto Corsa e Automobilista 2** são os dois jogos que dão tudo isso que o jogo tem (sessão, setores, temperaturas, composto, G; o clima só no Automobilista 2). Os outros jogos dão o id da sessão, as voltas de entrada e saída e os canais que o `Frame` deles já tinha. Os campos novos do `Frame` (`sectors_ms`, `session_kind`, `weather`, `air_temp_c`, `track_temp_c`, `tyre_compound`, `g_lat`, `g_long`) ficam vazios onde o jogo não os dá.
- **Ainda não conferido com o jogo aberto:** o sinal do G (eixos do jogo: x para a direita, z para a frente) e se o tempo de setor dos dois jogos é o do próprio setor. Uma volta cujos dois primeiros setores não deixam um terceiro é gravada sem setores.

## Posição, carros e tempo de sessão

Cinco valores da corrida, lidos em cada jogo que os tem (`Frame::race_position`, `class_position`, `cars`, `session_time_left_s`, `session_laps`; só chegam ao painel, nunca ao arquivo de volta). RaceRoom: os cinco. rFactor 1 (SCE, AMS1, rF1): posição, carros, tempo restante e voltas (sem classe). Automobilista 2 e Project CARS 2 e 3: posição, carros, tempo restante e voltas. EA SPORTS F1 23 a 25: posição, carros (`numActiveCars`), voltas e tempo restante. iRacing: os cinco, pelas variáveis `PlayerCar*`, `SessionTimeRemain` e `SessionLapsTotal` e pela lista de pilotos (sem o pace car). Assetto Corsa EVO: posição, carros, tempo restante e voltas da sessão. Assetto Corsa: posição, tempo restante e voltas. Assetto Corsa Competizione: esses três mais os carros ativos. Wreckfest 2: posição, carros e voltas (só em modos com voltas). Forza: só a posição. Le Mans Ultimate: só o número de carros (o `src/lmu/layout.rs` gerado ainda não tem posição, fim da sessão nem limite de voltas). Nada disso foi visto ao vivo: o que cada jogo escreve numa sessão por tempo, por voltas ou sem limite ainda é suposição, e cada valor que não é plausível (posição acima do número de carros, tempo negativo ou maior que um dia, voltas 0 ou acima de 999) fica como "não dado".

**Rivais (camada `Field`, `src/field.rs`).** Os outros carros da sessão, lidos a no máximo 5 Hz (`Frame::field`, `Live::field`; nunca vão para o arquivo de volta): por carro o nome, a classe, a posição geral e na classe, voltas feitas, a fração da volta, se está nos boxes, última e melhor volta, os intervalos e a posição no mundo, quando o jogo dá. A posição na classe e os intervalos que o jogo não dá são calculados num só lugar (`field::complete`), nunca em cada leitor; `field::relative` lista os carros mais próximos na pista. Por enquanto quatro jogos preenchem a camada: RaceRoom, a família rFactor 1 (SCE, AMS1, rF1), Automobilista 2 / Project CARS 2 e 3 e EA SPORTS F1 23 a 26. Os outros entram em seguida; Assetto Corsa e Forza não dão rivais. Os widgets que leem a camada ainda não existem.

## Posições dos campos (`src/lmu/layout.rs`)

Arquivo **gerado**, só com números (tamanhos e posições em bytes). Vem de um programa em C++ (`tools/layout_check.cpp`) compilado contra os cabeçalhos que o próprio jogo instala. **Os cabeçalhos não ficam no repositório**: a licença deles não permite redistribuir. Depois de uma atualização do jogo, ou quando o `probe` disser DIFFERENT:

```powershell
pwsh xpeed-sim/tools/regen-layout.ps1 -GameDir 'F:\SteamLibrary\steamapps\common\Le Mans Ultimate'
```

Precisa do jogo instalado e do Visual Studio C++ Build Tools. O script foi conferido: reproduz o arquivo atual idêntico.

## Testes

```powershell
cargo test --locked   # unit, contract, failure/recovery and recorded-lap regression tests
cargo fmt --check
cargo clippy --all-targets -- -D warnings
```

Os testes do leitor criam objetos do Windows **com nomes próprios** (nunca `LMU_Data`), então não tocam na memória de um jogo que esteja rodando. O teste `writes_a_sample_lap_to_disk` é opcional (`--ignored`): grava uma volta de exemplo para apontar outro programa, como o leitor do app, para o que o gravador produz.

### Gravações reais como testes (`capture` e `replay`)

Quase todos os testes acima são sintéticos, feitos a partir da documentação de cada jogo. Para pegar o que só aparece dirigindo (embreagem invertida, mapa espelhado, base da contagem de voltas), `capture JOGO` grava, num arquivo `.xcap` pequeno (gzip), exatamente os bytes que o leitor recebe enquanto alguém dirige, e `replay ARQ.xcap` passa esses bytes pelo mesmo leitor, pelo cortador de voltas e pelas checagens (`sanity`), mostrando por volta o tempo, a validade, as amostras, a distância contra o comprimento da pista e o que as checagens acharam. As gravações boas ficam em `fixtures/` e `cargo test` toca todas, comparando com o `NOME.expect.json` de cada uma. Como gravar uma: `fixtures/README.md`.

Para jogos que mandam UDP (F1, Forza, Wreckfest 2), **pause ou feche o app da bandeja antes de gravar**: só um programa pode ficar com a porta. Nos jogos de memória compartilhada os dois podem ler ao mesmo tempo.

## Segurança e limites

- A memória do jogo é aberta **somente para leitura**. A única escrita é na trava que o próprio protocolo do jogo exige.
- O tamanho do mapa é conferido antes de ler; um tamanho diferente do conhecido faz o `record` recusar.
- No Le Mans Ultimate, a versão do jogo **nunca impede a leitura**: o jogo atualiza com frequência, e o tamanho da memória mais as verificações automáticas dos dados (`src/sanity.rs`) já protegem o que é lido. O número é comparado com a versão para a qual `layout.rs` foi gerado (1.4.2): outra versão maior ou menor (1.5, 2.0) é **lida**, anotada uma vez no log e **avisada uma vez por execução** ao servidor do Xpeed (pelo caminho dos relatórios de erro, trabalhador `lmu`, mensagem "Le Mans Ultimate version X differs from the layout 1.4.2…"), que aparece na seção Problemas do admin; outro patch (1.4.3) só é anotado no log. Memória **menor** que o layout continua recusada (ler passaria do fim); memória **maior** é lida, anotada e avisada do mesmo jeito. O jeito como o jogo escreve o número (`major*10000 + minor*100 + patch`) **não foi conferido com o jogo aberto**: um número que não se lê como versão só é anotado. O `probe` imprime o número.
- Os leitores de UDP (F1, Forza, Wreckfest 2) escutam só em `127.0.0.1` e descartam datagramas de quem não é local. Para quem roda o jogo em outro computador: defina a variável de ambiente `XPEED_UDP_LISTEN_ALL=1` antes de abrir o Companion (escuta em todos os endereços e aceita qualquer remetente; desligado por padrão), e no jogo ponha o IP deste computador.
- Só o carro do jogador é lido, e o **nome do piloto nunca é guardado**.
- O arquivo é gravado em `.part` e renomeado ao final, então um arquivo incompleto nunca aparece com o nome final.
- The device key in `config.json` is protected with Windows DPAPI for the current Windows profile. Copying the file to another user/computer does not expose a usable plaintext token. The app migrates legacy plaintext keys after verifying the protected copy; the server scopes and revokes device access.
