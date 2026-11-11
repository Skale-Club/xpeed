# Formato do arquivo de volta (versão 1)

Contrato entre o **coletor Windows** (que grava) e o **Xpeed** (que lê). Uma volta de um carro, com todos os canais amostrados nos mesmos instantes. Implementação de referência: `src/lib/sim/lap-file.ts` e `src/lib/sim/channels.ts`; testes em `src/lib/sim/lap-file.test.ts`.

O arquivo enviado e guardado é esse conteúdo **comprimido com gzip**. Os arquivos vêm de fora, então o leitor confere cada tamanho antes de alocar memória.

## Layout (sem compressão, tudo little-endian)

| Posição | Tamanho | Conteúdo |
|---|---|---|
| 0 | 4 bytes | Magic ASCII `XLAP` |
| 4 | u16 | Versão do formato (`1`) |
| 6 | u16 | Flags (`0` na versão 1; qualquer outro valor é recusado) |
| 8 | u32 | Tamanho do cabeçalho em bytes (`N`), múltiplo de 4, de 4 a 65536 |
| 12 | `N` bytes | Cabeçalho: JSON em UTF-8, completado com espaços (`0x20`) até `N` |
| 12 + `N` | | Uma coluna por canal, na ordem do cabeçalho; cada coluna tem `sampleCount` valores float32 |

O tamanho total tem de ser exatamente `12 + N + canais × sampleCount × 4`. Sobra ou falta de byte é erro. O preenchimento do cabeçalho até múltiplo de 4 mantém as colunas alinhadas.

## Cabeçalho (JSON)

| Campo | Tipo | Regra |
|---|---|---|
| `game` | texto | Id do jogo em minúsculas (`lmu`, `acc`, `ac`…), `^[a-z][a-z0-9_]{0,31}$` |
| `track.name` | texto | 1 a 120 caracteres |
| `track.variant` | texto, opcional | 1 a 120 |
| `track.lengthM` | número, opcional | Maior que 0 e até 100000 |
| `car.name` | texto | 1 a 120 |
| `car.class` | texto, opcional | 1 a 60 |
| `lap.number` | inteiro | 0 a 100000 |
| `lap.timeMs` | inteiro | Milissegundos, 0 a 86400000 |
| `lap.valid` | booleano | `false` quando o jogo anulou a volta |
| `lap.sectorsMs` | inteiros, opcional | Até 8 valores, em ms |
| `startedAt` | texto | Data ISO 8601 em UTC |
| `sampleRateHz` | número | Maior que 0 e até 1000. Informativo: quem manda é o canal `t` |
| `sampleCount` | inteiro | 1 a 500000 |
| `channels` | lista | De 2 a 128 itens `{ "id", "unit" }`, sem repetição |

Quem escreve deve usar sempre esta ordem de chaves, para que a mesma volta gere os mesmos bytes. Quem lê **não** pode depender da ordem. Chaves desconhecidas são ignoradas na leitura.

## Canais

`id`: minúsculas, dígitos e `_`, começando por letra, até 32 caracteres. `unit`: texto de 1 a 16 caracteres.

Obrigatórios em todo arquivo: **`t`** (segundos desde o início da volta) e **`dist`** (metros percorridos desde o início da volta). As voltas são comparadas pela posição na pista, não pelo relógio.

Canais padrão, cada um com **uma só unidade** (o coletor converte antes de gravar; se o id padrão vier com outra unidade, o arquivo é recusado):

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

Cada jogo pode acrescentar canais próprios com qualquer outro id (por exemplo `tyre_fl_temp`), com a unidade que o coletor declarar. Valor que o jogo não informou em uma amostra é gravado como **NaN**.

## Limites

| O quê | Limite |
|---|---|
| Cabeçalho | 65536 bytes |
| Amostras por volta | 500000 |
| Canais | 128 |
| Arquivo descomprimido | 64 MiB. Um arquivo pequeno que descomprime além disso é interrompido durante a leitura |

## Erros

O leitor devolve um destes códigos: `bad_magic`, `bad_version`, `bad_flags`, `bad_length`, `bad_header`, `bad_channels`, `bad_data`, `too_large`, `bad_gzip`, `unsupported`. Uma versão maior que a conhecida é recusada (`bad_version`): um leitor antigo nunca interpreta um arquivo novo.

## Vetor de teste

Uma volta pequena que **o coletor deve gerar byte a byte** (antes do gzip; o gzip pode variar de uma biblioteca para outra, o conteúdo descomprimido não). Foi montada por um script separado, sem usar o código da referência, e o teste `writes exactly the bytes of the golden lap` confere que a implementação produz esses mesmos 396 bytes.

Cabeçalho (345 bytes de JSON, completados com 3 espaços até 348):

```json
{"game":"lmu","track":{"name":"Test Track","variant":"GP","lengthM":20},"car":{"name":"Test Car","class":"HYPERCAR"},"lap":{"number":1,"timeMs":1000,"valid":true,"sectorsMs":[400,600]},"startedAt":"2026-11-10T12:00:00.000Z","sampleRateHz":2,"sampleCount":3,"channels":[{"id":"t","unit":"s"},{"id":"dist","unit":"m"},{"id":"speed","unit":"m/s"}]}
```

Colunas (float32): `t` = 0, 0.5, 1; `dist` = 0, 10, 20; `speed` = 0, 10, 20.

Arquivo completo em hexadecimal (396 bytes):

```
584c4150010000005c0100007b2267616d65223a226c6d75222c22747261636b223a7b226e616d65223a225465737420547261636b222c2276617269616e74223a224750222c226c656e6774684d223a32307d2c22636172223a7b226e616d65223a225465737420436172222c22636c617373223a224859504552434152227d2c226c6170223a7b226e756d626572223a312c2274696d654d73223a313030302c2276616c6964223a747275652c22736563746f72734d73223a5b3430302c3630305d7d2c22737461727465644174223a22323032362d31312d31305431323a30303a30302e3030305a222c2273616d706c6552617465487a223a322c2273616d706c65436f756e74223a332c226368616e6e656c73223a5b7b226964223a2274222c22756e6974223a2273227d2c7b226964223a2264697374222c22756e6974223a226d227d2c7b226964223a227370656564222c22756e6974223a226d2f73227d5d7d202020000000000000003f0000803f00000000000020410000a04100000000000020410000a041
```

## Notas para o coletor em .NET

- `BinaryPrimitives.WriteUInt16LittleEndian`, `WriteUInt32LittleEndian` e `BinaryPrimitives.WriteSingleLittleEndian` dão os bytes certos em qualquer máquina.
- Escreva o JSON com `System.Text.Json`, nomes de propriedade em camelCase e os campos na ordem da tabela. Não escreva campos opcionais ausentes como `null`: omita-os.
- `GZipStream` com `CompressionLevel.Optimal` basta.
- Confira o arquivo gerado contra o vetor de teste acima antes de enviar qualquer volta real.
