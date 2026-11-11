# Formato do arquivo de pista (versão 1)

Contrato entre o **Xpeed Sim (Windows)** (que grava) e o **Xpeed** (que lê). O **traçado de uma pista**: a linha central, a largura da pista de cada lado dela (para desenhar as bordas), a linha ideal do jogo e o caminho do pit lane. O arquivo de volta ([FORMATO-DE-VOLTA.md](FORMATO-DE-VOLTA.md)) guarda a linha que o *carro* andou; este guarda a *pista*, e o Xpeed desenha a volta do piloto por cima dela.

Implementação de referência: `xpeed-sim/src/tracks/mod.rs` (formato), `ac.rs` (Assetto Corsa), `aiw.rs` (Stock Car Extreme, motor do rFactor 1), `preview.rs` (desenho em SVG), `dump.rs` (o comando `xpeed-sim track-dump`) e `auto.rs` (o traçado feito sozinho enquanto a pessoa anda). O leitor em TypeScript, escrito só a partir deste documento, é `src/lib/sim/track-file.ts`; o servidor usa o mesmo leitor para conferir cada traçado recebido.

**O Xpeed Sim agora manda os traçados sozinho.** Quando o Assetto Corsa ou o Stock Car Extreme está numa pista, ele monta o traçado dessa pista a partir dos arquivos do jogo (o mesmo código do `track-dump`) e o envia para a conta uma vez, e de novo só se o arquivo mudar. O envio (`POST /api/sim/tracks`) e a leitura pelo app (`GET /api/sim/tracks`) estão em [ENVIO-DE-VOLTAS.md](ENVIO-DE-VOLTAS.md), seção 2b.

O arquivo guardado é esse conteúdo **comprimido com gzip**, extensão `.xtrk`. Os arquivos vêm de fora, então o leitor confere cada tamanho antes de alocar memória. O arquivo é gerado no computador da pessoa a partir dos arquivos do jogo dela, que só são lidos; ele fica lá até o envio para a conta dela.

## Layout (sem compressão, tudo little-endian)

| Posição | Tamanho | Conteúdo |
|---|---|---|
| 0 | 4 bytes | Magic ASCII `XTRK` |
| 4 | u16 | Versão do formato (`1`) |
| 6 | u16 | Flags (`0` na versão 1; qualquer outro valor é recusado) |
| 8 | u32 | Tamanho do cabeçalho em bytes (`N`), múltiplo de 4, de 4 a 65536 |
| 12 | `N` bytes | Cabeçalho: JSON em UTF-8, completado com espaços (`0x20`) até `N` |
| 12 + `N` | | As colunas de cada seção, na ordem em que o cabeçalho lista as seções; dentro da seção, na ordem de `channels`; cada coluna tem `count` valores float32 |

O tamanho total tem de ser exatamente `12 + N + Σ (canais da seção × count × 4)`. Sobra ou falta de byte é erro. Como `12 + N` é múltiplo de 4, cada coluna começa alinhada: no navegador, `new Float32Array(buffer, byteOffset, count)` funciona direto (o `buffer` descomprimido começa em `0`). Todo float32 é little-endian; use `DataView.getFloat32(i, true)` se preferir não depender da máquina.

## Cabeçalho (JSON)

| Campo | Tipo | Regra |
|---|---|---|
| `game` | texto | Id do jogo em minúsculas: `ac` (Assetto Corsa), `sce` (Stock Car Extreme). `^[a-z][a-z0-9_]{0,31}$` |
| `track.name` | texto | 1 a 120 caracteres, sem caractere de controle. Para o `ac` é o nome da **pasta da pista** (o que o jogo informa como `track`), por exemplo `monza`. Para o `sce` é o nome do arquivo `.AIW` sem a extensão, por exemplo `InterlagosGP` |
| `track.variant` | texto, opcional | 1 a 120. Para o `ac` é o nome da **pasta do layout** (o que o jogo informa como `trackConfiguration`), por exemplo `gp`; ausente em pista de um layout só. O `sce` não tem |
| `track.title` | texto, opcional | 1 a 120. Nome para mostrar, quando o jogo traz um (`name` do `ui_track.json`; `TrackName` do `.gdb`) |
| `track.lengthM` | número, opcional | Maior que 0 e até 100000. Comprimento de uma volta (ou do trecho todo, se não fecha), em metros, arredondado ao centímetro |
| `source` | texto | 1 a 64. De onde vieram os dados: `fast_lane.ai`, `aiw` |
| `frame` | texto | 1 a 200. Só informativo: diz em que eixos estão os números (ver abaixo) |
| `closed` | booleano | `true` se a linha central fecha em volta (circuito); `false` em ponto a ponto |
| `centerKind` | texto | `edges_midpoint` ou `game_line` (ver abaixo) |
| `sections` | lista | De 1 a 3 itens `{ "id", "count", "channels" }`, na ordem `centerline`, `fast`, `pitlane`, cada um no máximo uma vez; `centerline` é obrigatória |

Quem escreve deve usar sempre esta ordem de chaves, para que a mesma pista gere os mesmos bytes. Quem lê **não** pode depender da ordem. Chaves desconhecidas são ignoradas na leitura.

## Seções

`channels` de cada seção é **exatamente** esta lista (outra lista é recusada: `bad_section`). Todos os valores são float32 em **metros**. `count` vai de 2 a 200000.

| `id` | `channels` | Significado |
|---|---|---|
| `centerline` | `x`, `y`, `z`, `dist`, `left`, `right` | A linha central da pista, na ordem em que o carro a percorre, a partir da linha de largada |
| `fast` | `x`, `z` | A linha ideal do jogo. Opcional. Tem de ter o **mesmo `count`** da `centerline`: o ponto `i` da `fast` é o ponto `i` da linha central, andado para o lado até a linha ideal |
| `pitlane` | `x`, `z`, `left`, `right` | O caminho que o jogo manda os carros fazerem no pit lane (entrada, boxes e saída). Opcional. Tem a sua própria quantidade de pontos |

### Linha central

* `x`, `y`, `z`: posição no mundo do jogo. `y` é a altura. Nenhum pode ser NaN ou infinito.
* `dist`: metros desde a linha de largada, **como o próprio jogo conta** (no Assetto Corsa, o campo de distância do `fast_lane.ai`; no Stock Car Extreme, o `wp_score`). Começa em (quase) 0, nunca diminui, nunca é NaN. É a chave para casar com o canal `dist` do arquivo de volta: a posição na pista, não o relógio.
* `left`, `right`: metros da linha central até a borda **esquerda** e até a borda **direita** da pista. **NaN quando a largura não é conhecida naquele ponto, e então os dois são NaN.** Quando conhecidos, ficam entre 0 (exclusive) e 200. Se `centerKind` é `edges_midpoint` os dois são iguais (a linha central fica no meio entre as bordas).
* Se `closed` é `true`, o primeiro e o último ponto ficam a no máximo **50 m** um do outro (em `x`, `z`); o trecho do último de volta ao primeiro faz parte da pista e **não** está nos dados (o leitor fecha o desenho). `track.lengthM` é a soma que inclui esse trecho.

`centerKind`:

* `edges_midpoint`: a linha central é o ponto do meio entre a borda esquerda e a borda direita. Os jogos guardam a largura a partir da *linha ideal* (Assetto Corsa) ou do *waypoint* (rFactor 1), que não fica no meio da pista; o Xpeed Sim desloca o ponto para o meio e grava a largura igual dos dois lados. Onde a largura não era conhecida o ponto fica onde o jogo o pôs.
* `game_line`: não havia largura utilizável no jogo (`left` e `right` são NaN em todo ponto); a linha central é a linha do próprio jogo.

### Linha ideal (`fast`)

No Assetto Corsa é a própria linha do `fast_lane.ai` (a linha que a IA segue). No Stock Car Extreme é o waypoint deslocado de `wp_path[0]` para o lado (a "linha seca"). Só existe quando o jogo traz essa informação.

### Pit lane (`pitlane`)

É o caminho do jogo, não só a rua dos boxes: inclui o trecho de entrada, a rua dos boxes e o trecho de saída. No Stock Car Extreme (Interlagos) ele chega a 1,6 km, porque o caminho de saída segue paralelo à pista até a IA poder voltar a ela. `left`/`right` são medidos **a partir dos pontos do próprio caminho** (não há deslocamento para o meio) e valem NaN nos dois quando o jogo não os informa (o `pit_lane.ai` do Assetto Corsa, por exemplo o de Monza e o da Nordschleife, muitas vezes não os informa). Só é gravado se todo ponto está a no máximo 300 m da pista.

## Esquerda, direita e eixos (normativo)

Os números estão no **mundo do próprio jogo**: os mesmos `x`, `y`, `z` que a telemetria do jogo informa para o carro (canais `x`, `y`, `z` do arquivo de volta). Não se deve supor norte, leste nem eixo "pra cima" além de `y`: o jogo manda, e quem desenha a pista e a volta usa **a mesma transformação** para as duas.

Para desenhar, o Xpeed Sim usa `x` para a direita e `z` para baixo na tela, sem espelhar. Assim os circuitos aparecem na orientação real (por exemplo, Monza no sentido horário).

**A esquerda é a esquerda do piloto, na direção em que se corre**, e se calcula assim, no plano `(x, z)`:

1. A tangente `t` de um ponto `i` é a direção do ponto anterior ao seguinte: `t = (x[i+1] - x[i-1], z[i+1] - z[i-1])`, normalizada. Se `closed`, os índices são circulares. Se não, o primeiro ponto usa ele mesmo e o seguinte, e o último usa o anterior e ele mesmo. Se a direção for nula, usa-se a do ponto anterior.
2. O vetor unitário para a **esquerda** é `l = (t.z, -t.x)`.
3. A borda esquerda do ponto é `(x + left * l.x, z + left * l.z)`; a borda direita é `(x - right * l.x, z - right * l.z)`.

Exemplo: indo para `+x` (`t = (1, 0)`), `l = (0, -1)`: a esquerda é `-z`, que na tela (z para baixo) é para cima, a esquerda de quem anda para a direita. ✔

**Evidência de que é a esquerda do piloto** (verificada nos arquivos reais, nada foi suposto):

* Stock Car Extreme: o `wp_perp` de cada waypoint, que o jogo define como a direção em que `wp_width` e `wp_path` são medidos, coincide com `l` (produto escalar médio 0,998 em Interlagos, mínimo 0,987), e a "linha seca" (`wp_path`) fica do lado de dentro da curva em 100 % (Interlagos 1) e 98 % (Interlagos GP) das curvas mais fechadas.
* Assetto Corsa: nas curvas mais fechadas de 462 pistas fechadas, a linha ideal está mais perto da borda de dentro (a que `l` chama de esquerda ou direita) em média 81 % das vezes (428 das 462 acima de 60 %): o lado menor é o lado para o qual a curva vira, como acontece no ápice. O Xpeed Sim usa essa conta como alerta: avisa se ficar abaixo de 35 %.

## Limites

| O quê | Limite |
|---|---|
| Cabeçalho | 65536 bytes |
| Pontos por seção | 2 a 200000 (a maior pista real encontrada tem 66468) |
| Seções | 1 a 3 |
| Largura de um lado | 0 (exclusive) a 200 m. Na extração, acima de 50 m é tratada como medida perdida (NaN) |
| Distância entre as pontas de uma pista `closed` | 50 m |
| Arquivo descomprimido | 64 MiB. Um arquivo pequeno que descomprime além disso é interrompido durante a leitura |

## Erros

O leitor devolve um destes códigos: `bad_magic`, `bad_version`, `bad_flags`, `bad_length`, `bad_header`, `bad_section`, `bad_data`, `too_large`, `bad_gzip`. Uma versão maior que a conhecida é recusada (`bad_version`): um leitor antigo nunca interpreta um arquivo novo. `bad_data` cobre: posição ou `dist` que não é número, `dist` que volta, largura que não é NaN nos dois lados ou número entre 0 e 200 nos dois, pista `closed` com as pontas longe, ponto da `fast` ou do `pitlane` que não é número.

## Vetor de teste

Uma pista pequena que **o Xpeed Sim deve gerar byte a byte** (antes do gzip; o gzip pode variar de uma biblioteca para outra, o conteúdo descomprimido não). Foi montada por um script separado (Python, só `struct`), sem usar o código da referência, e o teste `writes_the_golden_track_byte_for_byte` confere que a implementação produz esses mesmos 564 bytes.

É um quadrado de 10 m: quatro pontos de linha central, o último sem largura conhecida; uma linha ideal de 4 pontos; um pit lane de 2 pontos sem largura.

Cabeçalho (391 bytes de JSON, completados com 1 espaço até 392):

```json
{"game":"ac","track":{"name":"Test Track","variant":"GP","lengthM":40},"source":"fast_lane.ai","frame":"game world metres, x and z horizontal, y up","closed":true,"centerKind":"edges_midpoint","sections":[{"id":"centerline","count":4,"channels":["x","y","z","dist","left","right"]},{"id":"fast","count":4,"channels":["x","z"]},{"id":"pitlane","count":2,"channels":["x","z","left","right"]}]}
```

Colunas (float32), na ordem do arquivo. `NaN` é `0x7fc00000`:

| Seção | Coluna | Valores |
|---|---|---|
| `centerline` | `x` | 0, 10, 10, 0 |
| | `y` | 0, 0, 0, 0 |
| | `z` | 0, 0, 10, 10 |
| | `dist` | 0, 10, 20, 30 |
| | `left` | 5, 5, 5, NaN |
| | `right` | 5, 5, 5, NaN |
| `fast` | `x` | 1, 9, 9, 1 |
| | `z` | 1, 1, 9, 9 |
| `pitlane` | `x` | 0, 10 |
| | `z` | -8, -8 |
| | `left` | NaN, NaN |
| | `right` | NaN, NaN |

Arquivo completo em hexadecimal (564 bytes):

```
5854524b01000000880100007b2267616d65223a226163222c22747261636b223a7b226e616d65223a225465737420547261636b222c2276617269616e74223a224750222c226c656e6774684d223a34307d2c22736f75726365223a22666173745f6c616e652e6169222c226672616d65223a2267616d6520776f726c64206d65747265732c207820616e64207a20686f72697a6f6e74616c2c2079207570222c22636c6f736564223a747275652c2263656e7465724b696e64223a2265646765735f6d6964706f696e74222c2273656374696f6e73223a5b7b226964223a2263656e7465726c696e65222c22636f756e74223a342c226368616e6e656c73223a5b2278222c2279222c227a222c2264697374222c226c656674222c227269676874225d7d2c7b226964223a2266617374222c22636f756e74223a342c226368616e6e656c73223a5b2278222c227a225d7d2c7b226964223a227069746c616e65222c22636f756e74223a322c226368616e6e656c73223a5b2278222c227a222c226c656674222c227269676874225d7d5d7d2000000000000020410000204100000000000000000000000000000000000000000000000000000000000020410000204100000000000020410000a0410000f0410000a0400000a0400000a0400000c07f0000a0400000a0400000a0400000c07f0000803f00001041000010410000803f0000803f0000803f00001041000010410000000000002041000000c1000000c10000c07f0000c07f0000c07f0000c07f
```

Com esses dados, a borda esquerda do ponto 0 é `(0 + 5·l.x, 0 + 5·l.z)`, com `t = (10 - 0, 0 - 10) / |…| = (0,707; -0,707)` (o ponto anterior é o 3, circular) e `l = (-0,707; -0,707)`: `(-3,54; -3,54)`.

## De onde vêm os dados

Só são **lidos** arquivos do jogo instalado, nunca escritos. A extração roda no computador da pessoa, à mão (`xpeed-sim track-dump GAME PISTA SAIDA.xtrk --preview DESENHO.svg`) ou sozinha enquanto ela anda na pista (o arquivo vai para a pasta `tracks` dentro da pasta de voltas), e o resultado só sai de lá no envio para a conta dela.

### Assetto Corsa (`ac`): `ai/fast_lane.ai` e `ai/pit_lane.ai`

Binário, nunca documentado pela Kunos. O que está aqui foi lido dos 535 arquivos instalados e conferido com duas descrições da comunidade: o leitor do AssettoServer ([`FastLaneParser.cs`](https://github.com/compujuckel/AssettoServer/blob/master/AssettoServer/Server/Ai/Splines/FastLaneParser.cs): cabeçalho de versão 7, contagem, e os 18 floats de cada ponto, na mesma ordem) e o tópico [Extract AI pit/fast lanes](https://assettocorsamods.net/threads/extract-ai-pit-fast-lanes.2013) do assettocorsamods.net (cabeçalho de 4×4 bytes com a contagem em segundo; quatro floats `x, y, z, distância` por ponto). Little-endian:

| Posição | Conteúdo |
|---|---|
| 0 | i32 versão (`7`; um layout sem IA tem um arquivo de 12 bytes, versão `3`) |
| 4 | i32 `N`, quantidade de pontos |
| 8 | 2 × i32: tempo de volta e amostras, sempre 0 |
| 16 | `N` × 20 bytes: f32 `x`, `y`, `z`, f32 distância ao longo da linha (m), i32 índice (0, 1, 2, ...) |
| depois | i32 `N` de novo |
| depois | `N` × 72 bytes, 18 × f32: velocidade, acelerador, freio, g lateral, raio, **lado esquerdo**, **lado direito**, cambagem, direção, normal (3), comprimento, vetor para a frente (3), tag, inclinação |
| resto | uma grade de busca do próprio jogo (listas de pontos por célula de 10 m); não é lida |

Só os dois lados são usados: os demais campos **não são iguais em todo arquivo** (nos feitos pela Kunos, "comprimento" é a distância ao ponto anterior e o vetor para a frente é a direção do percurso; em muitos arquivos de mods eles são outra coisa ou zero).

A linha do `fast_lane.ai` é a linha de corrida, que não fica no meio da pista: vira a linha `fast`, e a linha central é o ponto do meio entre as bordas (`edges_midpoint`).

**Validação** (a extração recusa o arquivo que falha em qualquer uma; nenhuma falha é escondida):

1. Estrutura: versão 7, `N` entre 1 e 200000, tamanho do arquivo suficiente para `N` pontos e `N` detalhes, as duas contagens iguais, índices 0, 1, 2, ... em ordem.
2. Números: `x`, `y`, `z` e distância finitos; a distância começa em 0, nunca diminui, e a distância guardada do último ponto fica entre 95 % e 105 % da soma dos trechos retos entre os pontos (nos arquivos reais, entre 98 % e 102,8 %).
3. Fecha em volta se o último ponto fica a no máximo 20 m do primeiro (os arquivos reais têm 1,5 m ou mais de 80 m). Comprimento da volta = distância guardada do último ponto + o trecho de fechamento; entre 100 m e 100 km.
4. Contra o que o jogo diz do mesmo layout (`ui_track.json` e `data/map.ini`): o comprimento deve ficar a até 5 % do `length` do `ui_track.json`; e a linha, posta sobre a imagem do mapa do jogo (`pixel = (mundo + OFFSET) / SCALE_FACTOR`), deve ficar dentro dela e ocupar de 80 % a 125 % da área desenhável nos dois eixos. **Basta uma das duas conferências passar**; se todas as que existem falham, o arquivo é recusado (`ai_not_confirmed`: o arquivo ou o metadado é de outro layout). Se nenhuma existe, aceita com aviso.
5. Largura: um ponto tem largura quando os dois lados estão entre 0 (exclusive) e 50 m (0 é "não medido"). A pista só fica com largura se pelo menos 80 % dos pontos têm e a largura mediana (esquerda + direita) está entre 1,5 m e 80 m; senão fica sem largura (`game_line`), sem recusar.
6. Pit lane: opcional; é largado com aviso se tem menos de 2 pontos, menos de 20 m, ou algum ponto a mais de 300 m da pista.

**Resultado nos arquivos instalados** (`validates_every_installed_ac_track`, teste `#[ignore]` que lê o jogo): 535 `fast_lane.ai`; 1 é uma cópia solta em `data/` (ignorada), 10 são cópias de backup em subpastas de `ai/` (que o jogo não lê) e 524 são os do jogo.

* **Aceitos: 495** (485 dos 524 do jogo e as 10 cópias). 477 fecham em volta e 18 são ponto a ponto (arrancada, subida de montanha); 472 têm pit lane; 3 ficam sem largura (os lados valem 0, "não medido", no arquivo todo ou em mais de 20 % dos pontos); larguras totais de 1,2 m a 90,8 m, com 95 % dos pontos até 20 m.
* **Recusados: 39** (todos entre os 524 do jogo): 3 são arquivos de 12 bytes (`ai_stub`: layouts sem IA); 2 têm 0 pontos (`ai_empty`); 3 estão cortados (`ai_truncated`: `fn_losail/layout_f1_2023`, `narvskaya_autodrom/full` e `reverse`, com tamanho redondo de 300 KiB e 44 KiB: cópia incompleta); 5 têm todas as distâncias 0 (`ai_dist_zero`: `highforce`); 26 não batem com o que o jogo diz do próprio layout (`ai_not_confirmed`: as pistas de arrancada de `ks_drag`, `tor_slomczyn`, `nj`, entre outras, onde o comprimento e o mapa discordam do arquivo; vários `ui_track.json` copiam o comprimento de outro layout).
* Avisos nos aceitos: 71 têm um comprimento diferente no `ui_track.json` mas a linha cabe no mapa; 53 têm o comprimento certo mas não cabem no `map.ini` (provavelmente o `map.ini` de outro layout); 18 sem `pit_lane.ai`; 5 com pit lane de outro layout, largado; 1 com os lados provavelmente trocados (`aa_ovalo_hermanos_rodriguez`: 0 % das curvas).

### Stock Car Extreme (`sce`): arquivo `.AIW` (motor do rFactor 1)

Texto. Depois das seções `[GRID]`, `[TELEPORT]`, `[PITS]`, vem `[Waypoint]`, com linhas de cabeçalho (`lap_length`, `number_waypoints`, ...) e um bloco de linhas por waypoint. As linhas usadas (os comentários dos próprios arquivos dizem o que cada uma é):

| Linha | Significado |
|---|---|
| `wp_pos=(x,y,z)` | O waypoint, no mundo do jogo. Abre um bloco novo |
| `wp_perp=(x,y,z)` | Vetor unitário atravessando a pista, para a esquerda do piloto |
| `wp_width=(a,b,c,d)` | Metros a partir do waypoint, ao longo de `wp_perp`: pista à esquerda, pista à direita, faixa de escape à esquerda e à direita |
| `wp_path=(seca,molhada)` | Metros a partir do waypoint, ao longo de `wp_perp`, onde passam a linha seca (a ideal) e a molhada |
| `wp_score=(setor,dist)` | Distância desde a largada, em metros |
| `WP_PTRS=(ant,prox,ramo,caminho)` | Números dos waypoints (a ordem dos blocos no arquivo) |
| `wp_branchID=(n)` | 0 caminho principal; 1 em diante, caminhos do pit lane; um número para cada vaga de box |
| `wp_bitfields=(n)` | Bit 1: não é waypoint de caminho (vaga de box, garagem) |

A linha central é o caminho principal (`wp_branchID` 0, bit 1 apagado) seguido por `prox` a partir do waypoint de menor `wp_score` (a linha de largada: o arquivo começa em outro ponto da volta). Fecha em volta quando `prox` volta ao primeiro. Largura de `wp_width[0]` e `wp_width[1]`, com o deslocamento para o meio; linha ideal por `wp_path[0]`; pit lane é a maior cadeia de caminho com `wp_branchID` 1 em diante.

**Validação:** estrutura de cada bloco; `number_waypoints` igual ao que o arquivo tem (um arquivo cortado não bate); ponteiros que existem; a cadeia principal alcança pelo menos 90 % dos waypoints principais; **a soma dos trechos mais o fechamento bate com `lap_length` em até 1 %**; o `wp_score` do jogo bate com a soma dos trechos (até 2 % da volta + 5 m); `wp_perp` é unitário e aponta para a esquerda do sentido do percurso (concordância média ≥ 0,9); as mesmas regras de largura e de pit lane do Assetto Corsa.

**Resultado nos arquivos instalados** (`validates_every_installed_sce_track`): 70 `.AIW`, **70 aceitos, 0 recusados, 0 avisos**; todos fecham em volta, todos têm linha ideal e pit lane. Comprimentos de 644 m a 7927 m; a soma dos waypoints bate com `lap_length` em 0,00 % na maioria (a maior diferença é Ortona 4, 0,4 %); larguras totais de 3,6 m a 34,2 m.

### Mundo do jogo e telemetria

* Assetto Corsa: a imagem de mapa do próprio jogo (`map.png`) é desenhada a partir do mundo com `pixel = (mundo + OFFSET) / SCALE_FACTOR`, e o jogo desenha o carro nela com as mesmas coordenadas de mundo que a telemetria informa (`carCoordinates`). A linha do `fast_lane.ai` cai dentro desse mapa e o ocupa (em 511 layouts com `map.ini`, a linha ocupa de 85 % a 115 % da área desenhável nos dois eixos em 448 deles, e em Monza, Spa, Imola e Magione fica a 100 % dentro): é o mesmo mundo.
* Stock Car Extreme: o `.AIW` e a telemetria do jogo usam o mesmo mundo (a grade de largada do próprio `.AIW` está nele). Ainda **não conferido com um carro de verdade** (o leitor do Stock Car Extreme ainda não existe).

## Notas para o leitor em TypeScript

* Descomprima com `DecompressionStream('gzip')` ou `pako`, com teto de 64 MiB durante a leitura.
* Confira `magic`, versão e flags; depois `N` (múltiplo de 4, de 4 a 65536, e `12 + N` ≤ tamanho do arquivo); depois o JSON; depois as seções (ids, canais, `count`); só então confira o tamanho total e crie os `Float32Array`.
* NaN é valor, não erro: use `Number.isNaN` em `left`/`right`; nunca compare com `===`.
* Para casar a pista com uma volta: `game`, `track.name` e `track.variant` do arquivo de volta com os do arquivo de pista (no Assetto Corsa, os dois vêm das mesmas pastas do jogo). A volta é posta sobre a pista pelo canal `dist`, não pelo relógio. Para o `sce` a chave de casamento ainda **não está decidida** (o nome da pista que o plugin do rFactor 1 informa precisa ser conferido com o jogo rodando).
