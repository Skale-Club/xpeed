# Formato do arquivo de volta (versões 1 e 2)

Contrato entre o **Xpeed Companion (Windows)** (que grava) e o **Xpeed** (que lê). Uma volta de um carro, com todos os canais amostrados nos mesmos instantes. Implementação de referência: `src/lib/sim/lap-file.ts` e `src/lib/sim/channels.ts`; testes em `src/lib/sim/lap-file.test.ts`. O gravador está em `xpeed-sim/src/lapfile.rs`.

O arquivo enviado e guardado é esse conteúdo **comprimido com gzip**. Os arquivos vêm de fora, então o leitor confere cada tamanho antes de alocar memória.

**Versões.** A versão 2 (Companion 0.5) acrescenta ao cabeçalho a sessão, o clima, o pneu e as voltas de entrada e de saída dos boxes, e acrescenta canais (pneus, freios, G, dano, DRS, TC e ABS). O leitor aceita as versões **1 e 2**; o Companion 0.5 grava a **2**; um leitor antigo (só versão 1) recusa a 2 com `bad_version`, como recusa qualquer versão que não conhece. Tudo o que a 2 acrescenta é opcional: um arquivo da 2 sem nenhum campo novo é válido, e um arquivo da 1 continua sendo lido para sempre.

## Layout (sem compressão, tudo little-endian)

| Posição | Tamanho | Conteúdo |
|---|---|---|
| 0 | 4 bytes | Magic ASCII `XLAP` |
| 4 | u16 | Versão do formato (`1` ou `2`; qualquer outra é recusada) |
| 6 | u16 | Flags (`0` nas versões 1 e 2; qualquer outro valor é recusado) |
| 8 | u32 | Tamanho do cabeçalho em bytes (`N`), múltiplo de 4, de 4 a 65536 |
| 12 | `N` bytes | Cabeçalho: JSON em UTF-8, completado com espaços (`0x20`) até `N` |
| 12 + `N` | | Uma coluna por canal, na ordem do cabeçalho; cada coluna tem `sampleCount` valores float32 |

O tamanho total tem de ser exatamente `12 + N + canais × sampleCount × 4`. Sobra ou falta de byte é erro. O preenchimento do cabeçalho até múltiplo de 4 mantém as colunas alinhadas. `N` conta **bytes** do UTF-8 (um `°` vale 2 bytes).

## Cabeçalho (JSON)

| Campo | Tipo | Regra |
|---|---|---|
| `game` | texto | Id do jogo em minúsculas (`lmu`, `acc`, `ac`…), `^[a-z][a-z0-9_]{0,31}$` |
| `track.name` | texto | 1 a 120 caracteres |
| `track.variant` | texto, opcional | 1 a 120 |
| `track.lengthM` | número, opcional | Maior que 0 e até 100000 |
| `car.name` | texto | 1 a 120 caracteres |
| `car.class` | texto, opcional | 1 a 60 |
| `lap.number` | inteiro | 0 a 100000 |
| `lap.timeMs` | inteiro | Milissegundos, 0 a 86400000 |
| `lap.valid` | booleano | `false` quando o jogo anulou a volta |
| `lap.sectorsMs` | inteiros, opcional | Até 8 valores, em ms. O Companion grava 3 valores (a soma é o `timeMs`) quando o jogo dá os tempos dos setores |
| `lap.inLap` | booleano, opcional | **Versão 2.** A volta terminou nos boxes |
| `lap.outLap` | booleano, opcional | **Versão 2.** A volta começou nos boxes |
| `startedAt` | texto | Data ISO 8601 em UTC |
| `sampleRateHz` | número | Maior que 0 e até 1000. Informativo: quem manda é o canal `t` |
| `sampleCount` | inteiro | 1 a 500000 |
| `sessionId` | texto, opcional | **Versão 2.** 1 a 64 caracteres de `A-Z a-z 0-9 _ -`. Igual em todas as voltas de uma mesma sessão do jogo (veja abaixo) |
| `sessionKind` | texto, opcional | **Versão 2.** `practice`, `qualifying`, `race` ou `unknown` |
| `weather` | texto, opcional | **Versão 2.** 1 a 32 caracteres, sem caracteres de controle. O Companion grava `dry` ou `rain` |
| `airTempC` | número, opcional | **Versão 2.** Temperatura do ar em °C, de -100 a 200 (arredondada a décimos) |
| `trackTempC` | número, opcional | **Versão 2.** Temperatura da pista em °C, de -100 a 200 |
| `tyreCompound` | texto, opcional | **Versão 2.** 1 a 40 caracteres, sem caracteres de controle. O composto do pneu como o jogo o nomeia |
| `channels` | lista | De 2 a 128 itens `{ "id", "unit" }`, sem repetição |

Quem escreve deve usar sempre esta ordem de chaves, para que a mesma volta gere os mesmos bytes. Quem lê **não** pode depender da ordem. Chaves desconhecidas são ignoradas na leitura. A ordem de escrita:

```
game, track{name, variant, lengthM}, car{name, class},
lap{number, timeMs, valid, sectorsMs, inLap, outLap}, startedAt, sampleRateHz, sampleCount,
sessionId, sessionKind, weather, airTempC, trackTempC, tyreCompound, channels
```

Campo opcional ausente **não é escrito** (nunca `null`). Uma volta da versão 1 não tem `inLap`, `outLap` nem os seis campos do fim; o escritor se recusa a gravar uma volta de versão 1 que os traga.

### Como o Companion decide a sessão e as voltas de entrada e de saída

- **`sessionId`**: 32 caracteres hexadecimais de 16 bytes aleatórios do Windows, criado **uma vez por sessão do jogo** e escrito em todas as voltas cortadas nela. Uma sessão nova começa quando o leitor do jogo é aberto de novo (o jogo foi reiniciado, ou ficou 30 s sem escrever), quando a pista ou o carro muda, quando o tipo de sessão muda (treino, depois classificação) e quando a sessão é **reiniciada** (o número da volta volta atrás, ou o relógio da volta volta mais de 1 s na mesma volta). No Le Mans Ultimate também quando o número da sessão do jogo muda ou o relógio da sessão volta. Uma volta que termina depois de a sessão acabar mantém o id da sessão em que foi dirigida. Perder quadros (o número da volta pula) perde a volta, mas não muda a sessão.
- **`outLap`**: o **primeiro** quadro da volta já estava nos boxes (a bandeira de boxes que o leitor do jogo dá). **`inLap`**: o **último** quadro da volta estava nos boxes. As duas são sempre gravadas (`true` ou `false`) pelos leitores que cortam voltas. Uma volta que passa pelos boxes e volta à pista antes da linha não é nenhuma das duas (e já não é `valid`).
- **`sectorsMs`**: os dois primeiros setores vêm do jogo (o tempo de cada um, assim que o carro o termina) e o terceiro é o tempo oficial da volta menos os dois. Só uma volta cujo tempo oficial chegou e confere com o relógio recebe setores, e só se os dois primeiros deixam um terceiro positivo. Um jogo com número de setores diferente de 3 não dá setores.

## Canais

`id`: minúsculas, dígitos e `_`, começando por letra, até 32 caracteres. `unit`: texto de 1 a 16 caracteres. Todos os canais novos da versão 2 têm ids válidos pela regra acima (por isso um leitor que não os conhece os trata como canais próprios de um jogo, e o limite de 128 canais não mudou).

Obrigatórios em todo arquivo: **`t`** (segundos desde o início da volta) e **`dist`** (metros percorridos desde o início da volta). As voltas são comparadas pela posição na pista, não pelo relógio.

Canais padrão, cada um com **uma só unidade** (o Xpeed Companion converte antes de gravar; se o id padrão vier com outra unidade, o arquivo é recusado):

| id | unidade | Significado |
|---|---|---|
| `t` | `s` | Tempo desde o início da volta |
| `dist` | `m` | Distância desde o início da volta |
| `speed` | `m/s` | Velocidade |
| `rpm` | `rpm` | Rotação do motor |
| `gear` | `gear` | Marcha: -1 ré, 0 neutro, 1 em diante |
| `throttle` | `ratio` | Acelerador, 0 a 1 |
| `brake` | `ratio` | Freio, 0 a 1 |
| `clutch` | `ratio` | Embreagem, 0 a 1 |
| `steer` | `ratio` | Volante, -1 todo à esquerda a 1 todo à direita |
| `x`, `y`, `z` | `m` | Posição no mundo (leste, cima, norte) |
| `fuel` | `l` | Combustível no tanque |

Canais padrão acrescentados na **versão 2**. O pneu ou o freio é nomeado pelo lugar: `fl` dianteiro esquerdo, `fr` dianteiro direito, `rl` traseiro esquerdo, `rr` traseiro direito. Cada canal só está no arquivo quando o jogo o dá (uma coluna que o jogo nunca deu **não existe**, não é preenchida com zeros); uma leitura que falta no meio de uma coluna é `NaN`.

| id | unidade | Significado |
|---|---|---|
| `tyre_temp_fl`, `tyre_temp_fr`, `tyre_temp_rl`, `tyre_temp_rr` | `°C` | Temperatura do pneu (a da banda de rodagem quando o jogo a dá, senão a do núcleo) |
| `tyre_press_fl`, `tyre_press_fr`, `tyre_press_rl`, `tyre_press_rr` | `kPa` | Pressão do pneu |
| `tyre_wear_fl`, `tyre_wear_fr`, `tyre_wear_rl`, `tyre_wear_rr` | `ratio` | Borracha que resta, de 1 (novo) a 0 |
| `brake_temp_fl`, `brake_temp_fr`, `brake_temp_rl`, `brake_temp_rr` | `°C` | Temperatura do freio |
| `g_lat` | `g` | Aceleração lateral do carro; positiva para a **direita** do carro (uma curva à direita dá valor positivo) |
| `g_long` | `g` | Aceleração ao longo do carro; positiva para a **frente** (acelerar é positivo, frear é negativo) |
| `damage_body` | `ratio` | Dano na carroceria, 0 nenhum a 1 destruída |
| `drs` | `state` | Asa traseira: 0 não permitida, 1 permitida (o piloto pode abrir), 2 aberta |
| `tc_active` | `flag` | O controle de tração está agindo: 0 ou 1 |
| `abs_active` | `flag` | O ABS está agindo: 0 ou 1 |

Cada jogo pode acrescentar canais próprios com qualquer outro id (por exemplo `engine_temp`), com a unidade que o Xpeed Companion declarar. Valor que o jogo não informou em uma amostra é gravado como **NaN**.

### Quais jogos dão o quê (Companion 0.5)

| Jogo | Sessão, tipo | Setores | Clima e temperaturas | Composto | G | Pneus, freios, dano, DRS, TC, ABS |
|---|---|---|---|---|---|---|
| Assetto Corsa (`ac`) | id e `sessionKind` | `sectorsMs` (pista de 3 setores) | só `airTempC` e `trackTempC` (o jogo não dá clima) | `tyreCompound` | `g_lat`, `g_long` | o que o jogo dá (veja o código do leitor) |
| Automobilista 2 (`ams2`) | id e `sessionKind` | `sectorsMs` (pista de 3 setores) | `weather` (`dry`/`rain`), `airTempC`, `trackTempC` | `tyreCompound` | `g_lat`, `g_long` | o que o jogo dá |
| Le Mans Ultimate (`lmu`) | só o id | `sectorsMs` (já gravava) | nada ainda | nada ainda | nada ainda | o que o jogo dá |
| Os demais | só o id | nada ainda | nada ainda | nada ainda | nada ainda | o que o jogo dá |

"Só o id" quer dizer que o arquivo traz `sessionId`, `inLap` e `outLap`, mas não `sessionKind`. Os sinais de `g_lat` e `g_long` do Assetto Corsa e do Automobilista 2 seguem os eixos do jogo (x para a direita, z para a frente) e ainda não foram conferidos com o jogo aberto.

## Limites

| O quê | Limite |
|---|---|
| Cabeçalho | 65536 bytes |
| Amostras por volta | 500000 |
| Canais | 128 |
| Arquivo descomprimido | 64 MiB. Um arquivo pequeno que descomprime além disso é interrompido durante a leitura |

## Erros

O leitor devolve um destes códigos: `bad_magic`, `bad_version`, `bad_flags`, `bad_length`, `bad_header`, `bad_channels`, `bad_data`, `too_large`, `bad_gzip`, `unsupported`. Uma versão que não é a 1 nem a 2 é recusada (`bad_version`): um leitor nunca interpreta um arquivo de uma versão que não conhece.

## Vetores de teste

Duas voltas pequenas que **o Xpeed Companion deve gerar byte a byte** (antes do gzip; o gzip pode variar de uma biblioteca para outra, o conteúdo descomprimido não). Foram montadas por um script separado, `docs/telemetria-virtual-2026-11-10/golden-lap.mjs`, que escreve cabeçalho e colunas à mão sem usar o código da referência. Os testes `writes exactly the bytes of the golden lap` (versão 1) e `writes exactly the bytes of the golden version 2 lap` conferem os bytes no leitor/escritor do app, e `writes_the_golden_lap_byte_for_byte` e `writes_the_golden_version_2_lap_byte_for_byte` os conferem no Companion.

### Versão 1 (396 bytes)

Cabeçalho (345 bytes de JSON, completados com 3 espaços até 348):

```json
{"game":"lmu","track":{"name":"Test Track","variant":"GP","lengthM":20},"car":{"name":"Test Car","class":"HYPERCAR"},"lap":{"number":1,"timeMs":1000,"valid":true,"sectorsMs":[400,600]},"startedAt":"2026-11-10T12:00:00.000Z","sampleRateHz":2,"sampleCount":3,"channels":[{"id":"t","unit":"s"},{"id":"dist","unit":"m"},{"id":"speed","unit":"m/s"}]}
```

Colunas (float32): `t` = 0, 0.5, 1; `dist` = 0, 10, 20; `speed` = 0, 10, 20.

```
584c4150010000005c0100007b2267616d65223a226c6d75222c22747261636b223a7b226e616d65223a225465737420547261636b222c2276617269616e74223a224750222c226c656e6774684d223a32307d2c22636172223a7b226e616d65223a225465737420436172222c22636c617373223a224859504552434152227d2c226c6170223a7b226e756d626572223a312c2274696d654d73223a313030302c2276616c6964223a747275652c22736563746f72734d73223a5b3430302c3630305d7d2c22737461727465644174223a22323032362d31312d31305431323a30303a30302e3030305a222c2273616d706c6552617465487a223a322c2273616d706c65436f756e74223a332c226368616e6e656c73223a5b7b226964223a2274222c22756e6974223a2273227d2c7b226964223a2264697374222c22756e6974223a226d227d2c7b226964223a227370656564222c22756e6974223a226d2f73227d5d7d202020000000000000003f0000803f00000000000020410000a04100000000000020410000a041
```

### Versão 2 (648 bytes)

Uma volta de treino no Assetto Corsa, com chuva, pneu macio, volta de saída dos boxes, e dois canais da versão 2, um deles com unidade que não é ASCII (`°C`) e uma amostra que o jogo não deu (`NaN`). Cabeçalho (575 bytes de JSON, completados com 1 espaço até 576):

```json
{"game":"ac","track":{"name":"Test Track","variant":"GP","lengthM":20},"car":{"name":"Test Car","class":"GT3"},"lap":{"number":2,"timeMs":1000,"valid":true,"sectorsMs":[400,300,300],"inLap":false,"outLap":true},"startedAt":"2026-11-10T12:00:00.000Z","sampleRateHz":2,"sampleCount":3,"sessionId":"a1b2c3d4e5f60718293a4b5c6d7e8f90","sessionKind":"practice","weather":"rain","airTempC":18.5,"trackTempC":22,"tyreCompound":"Soft","channels":[{"id":"t","unit":"s"},{"id":"dist","unit":"m"},{"id":"speed","unit":"m/s"},{"id":"tyre_temp_fl","unit":"°C"},{"id":"g_lat","unit":"g"}]}
```

Colunas (float32): `t` = 0, 0.5, 1; `dist` = 0, 10, 20; `speed` = 0, 10, 20; `tyre_temp_fl` = 80, NaN, 82; `g_lat` = 0, 0.5, -1.

```
584c415002000000400200007b2267616d65223a226163222c22747261636b223a7b226e616d65223a225465737420547261636b222c2276617269616e74223a224750222c226c656e6774684d223a32307d2c22636172223a7b226e616d65223a225465737420436172222c22636c617373223a22475433227d2c226c6170223a7b226e756d626572223a322c2274696d654d73223a313030302c2276616c6964223a747275652c22736563746f72734d73223a5b3430302c3330302c3330305d2c22696e4c6170223a66616c73652c226f75744c6170223a747275657d2c22737461727465644174223a22323032362d31312d31305431323a30303a30302e3030305a222c2273616d706c6552617465487a223a322c2273616d706c65436f756e74223a332c2273657373696f6e4964223a226131623263336434653566363037313832393361346235633664376538663930222c2273657373696f6e4b696e64223a227072616374696365222c2277656174686572223a227261696e222c2261697254656d7043223a31382e352c22747261636b54656d7043223a32322c2274797265436f6d706f756e64223a22536f6674222c226368616e6e656c73223a5b7b226964223a2274222c22756e6974223a2273227d2c7b226964223a2264697374222c22756e6974223a226d227d2c7b226964223a227370656564222c22756e6974223a226d2f73227d2c7b226964223a22747972655f74656d705f666c222c22756e6974223a22c2b043227d2c7b226964223a22675f6c6174222c22756e6974223a2267227d5d7d20000000000000003f0000803f00000000000020410000a04100000000000020410000a0410000a0420000c07f0000a442000000000000003f000080bf
```

## Notas para o Xpeed Companion

- O Companion é em Rust (`xpeed-sim/`): `u16::to_le_bytes`, `u32::to_le_bytes` e `f32::to_le_bytes` dão os bytes certos em qualquer máquina. Confira o arquivo gerado contra os vetores de teste acima antes de enviar qualquer volta real.
- Escreva o JSON com os campos na ordem acima e os números como o `JSON.stringify` do JavaScript (inteiro sem ponto decimal, `18.5` como `18.5`). Não escreva campos opcionais ausentes como `null`: omita-os.
- `gzip` com o nível padrão basta.
