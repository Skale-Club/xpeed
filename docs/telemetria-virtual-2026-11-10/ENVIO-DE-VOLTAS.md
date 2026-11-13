# Envio de voltas do Xpeed Sim para o Xpeed

Este é o contrato entre o Xpeed Sim (Windows) e o servidor do Xpeed. **O Xpeed Sim e o servidor já o implementam.** O servidor está em `api/sim/*` (migração `20261110200000_sim_devices_and_laps.sql`, testes em `npm run test:sim`); o Xpeed Sim, em `xpeed-sim/src/net.rs` e `outbox.rs`, também é testado contra um servidor falso local (`xpeed-sim/src/stub.rs`). Foi rodado o Xpeed Sim de verdade contra os handlers de verdade, com um arquivo de volta escrito pelo próprio Xpeed Sim (Rust) e aberto pelo leitor estrito do servidor (TypeScript).

O que trafega é o **arquivo de volta** de [FORMATO-DE-VOLTA.md](FORMATO-DE-VOLTA.md), sem mudança: o envio não cria um formato novo.

## Regras gerais

- **Só HTTPS.** O Xpeed Sim recusa um endereço `http://` a não ser que o servidor seja da própria máquina (`localhost`, `127.0.0.1`, `[::1]`, usado em desenvolvimento). Assim a chave do aparelho nunca viaja em texto aberto.
- **Sem redirecionamento.** O Xpeed Sim não segue redirecionamentos (um `3xx` é tratado como erro "use o endereço final"). A chave nunca é reenviada para outro endereço.
- **Endereço base** é o do app (por exemplo `https://xpeed.skale.club`). Os caminhos abaixo são relativos a ele.
- Respostas de erro trazem JSON `{"error": "texto curto"}`. O Xpeed Sim só mostra esse texto; nunca decide nada por ele. A decisão é pelo código HTTP.
- O corpo de uma resposta com mais de 64 KiB é cortado pelo Xpeed Sim.

## 1. Pareamento (uma vez por computador)

No app, a pessoa pede um **código de pareamento** (`POST /api/sim/codes`, entrando com a conta; a tela do app para isso ainda não existe): 8 caracteres de `A-Z` e `2-9` (sem `0 O 1 I`), válido por 10 minutos e usável **uma única vez**. Cada pessoa tem no máximo 5 códigos abertos e pode pedir 10 por hora. Só o hash do código fica guardado. No computador:

```powershell
xpeed-sim pair --server https://xpeed.skale.club --code ABCD-2345
```

```
POST /api/sim/pair
Content-Type: application/json

{ "code": "ABCD2345",
  "device": { "name": "MEU-PC", "platform": "windows", "app": "xpeed-companion", "version": "0.1.0" } }
```

O Xpeed Sim tira traços e espaços e põe em maiúsculas antes de enviar. O nome do aparelho é o do computador, ou o que a pessoa passar em `--name`. Serve só para ela reconhecê-lo na lista de aparelhos do app.

| Resposta | Significado |
| --- | --- |
| `200` `{ "token": "xpd_…", "deviceId": "…" }` | Pareado. O `token` é a **chave do aparelho** e só aparece aqui. |
| `400`, `404`, `410` | Código inválido, expirado ou já usado (o servidor responde `404 invalid_code` para os três, sem dizer qual). A pessoa pede outro no app. |
| `409` `device_limit` | A conta já tem 10 aparelhos ativos. O código **não** é gasto: revogue um aparelho e tente de novo. |
| `429` | Muitas tentativas (10 por minuto por endereço). Esperar. |
| `5xx` | Servidor com problema. Tentar de novo depois. |

A chave (`xpd_` + 43 caracteres) fica em `%APPDATA%\Xpeed Sim\config.json` (ou onde `XPEED_SIM_HOME` apontar), junto com o endereço. É um arquivo comum da pasta do usuário: quem lê essa pasta lê a chave. Por isso a chave só vale para **enviar voltas**, nunca para ler nada, e a pessoa a revoga (`DELETE /api/sim/devices?id=…`), o que faz o próximo envio receber `401`. O servidor guarda só o hash da chave.

## 2. Envio de uma volta

```
POST /api/sim/laps
Authorization: Bearer xpd_…
Content-Type: application/gzip
Content-Length: …

<os bytes do arquivo .xlap.gz, exatamente como estão em disco>
```

O servidor **abre o arquivo com o leitor estrito** do formato (o mesmo do app) e rejeita o que ele rejeitar. A identidade da volta é calculada pelo servidor a partir do cabeçalho: `jogo|pista|carro|início|volta|tempo|amostras` (a mesma `lapIdentity` do app), e é **por conta**. Por isso enviar de novo a mesma volta é seguro.

| Resposta | Significado | O que o Xpeed Sim faz |
| --- | --- | --- |
| `201` `{ "id": "…", "duplicate": false }` | Guardada. | Marca como enviada. |
| `200` `{ "id": "…", "duplicate": true }` | O servidor já tinha esta volta. | Marca como enviada. |
| `401`, `403` | Chave recusada ou revogada. | **Para tudo** e pede para parear de novo. Nada é perdido. |
| `400`, `413`, `415`, `422` | Esta volta nunca será aceita (inválida, grande demais). | Marca como **recusada**, mostra o motivo, **não tenta de novo**, e segue para a próxima. |
| `429` (com `Retry-After`) | Devagar. | Para o ciclo e tenta de novo depois da espera pedida (no máximo 1 hora). |
| `408`, `5xx`, rede fora do ar, tempo esgotado | Problema passageiro. | Para o ciclo e tenta de novo com espera crescente (30 s, 1 min, 2 min … até 5 min). |
| `404`, `405`, `501` | Este servidor ainda não recebe voltas. | Como acima, com a mensagem "este servidor não recebe voltas". |
| `3xx` | Endereço mudou. | Como acima, com a mensagem de usar o endereço final. |

Antes de ler o corpo, o servidor confere a chave (`401` sem corpo lido), o `content-length` (`413 {"error":"too_large"}`) e tem no máximo **4 envios de voltas e pistas ao mesmo tempo**: o quinto recebe `503 {"error":"busy","retryable":true}` com `Retry-After: 5`. Toda recusa de envio traz `"retryable": true|false` no JSON (os códigos `error` não mudam): `false` é definitivo, `true` pode tentar de novo depois. Todo `429` e `503` traz `Retry-After`.

Limites do lado do servidor: **16 MiB** por arquivo (o Xpeed Sim já nem tenta enviar mais que isso), 60 envios por minuto por aparelho, **5.000 voltas por conta** (acima disso, `422`) e os limites do próprio formato. O arquivo fica no volume, no balde privado `sim-laps`, em `<conta>/<hash da identidade>.xlap.gz`.

## 2b. Envio do traçado de uma pista

O Xpeed Sim manda **sozinho** o traçado das pistas em que a pessoa anda, nos jogos que têm arquivos de pista: Assetto Corsa (`ac`, o `fast_lane.ai`) e Stock Car Extreme (`sce`, o `.AIW`). O que trafega é o **arquivo de pista** de [FORMATO-DE-PISTA.md](FORMATO-DE-PISTA.md) (`.xtrk.gz`), feito pelo mesmo código do `xpeed-sim track-dump`.

```
POST /api/sim/tracks
Authorization: Bearer xpd_…
Content-Type: application/gzip
Content-Length: …

<os bytes do arquivo .xtrk.gz, exatamente como estão em disco>
```

O servidor abre o arquivo com o **leitor estrito** do formato (`src/lib/sim/track-file.ts`, o mesmo do app, com o teto de 64 MiB descomprimido) e recusa o que ele recusar. Há **um traçado por conta para cada jogo, pista e layout**, comparados sem diferença de maiúsculas e sem espaços nas pontas (a `trackKey` do leitor: `jogo|pista|layout`). Mandar de novo a mesma pista **substitui** o traçado anterior (o mesmo `id`).

| Resposta | Significado | O que o Xpeed Sim faz |
| --- | --- | --- |
| `201` `{ "id": "…", "replaced": false }` | Guardado, pista nova na conta. | Marca como enviado. |
| `201` `{ "id": "…", "replaced": true }` | Guardado no lugar do traçado que a conta já tinha desta pista. | Marca como enviado. |
| `400` `empty_body` | Corpo vazio. | Marca como **recusado** e não tenta de novo enquanto o arquivo não mudar. |
| `413` `too_large` | Mais de **32 MiB**, ou mais de 64 MiB depois de descomprimido. | Como acima. |
| `415` `unsupported_media_type` | O `Content-Type` não é `application/gzip`. | Como acima. |
| `422` `{ "error": "bad_track", "code": "bad_data", "message": "…" }` | O leitor estrito recusou o arquivo; `code` é o código dele (`bad_magic`, `bad_version`, `bad_flags`, `bad_length`, `bad_header`, `bad_section`, `bad_data`, `bad_gzip`). | Como acima. |
| `422` `too_many` | A conta já tem **500 traçados** (substituir um que ela já tem continua valendo). | Como acima. |
| `401`, `429`, `408`, `5xx`, `3xx`, `404`, `405`, `501` | Os mesmos casos das voltas. | O mesmo das voltas. |

Limites: 32 MiB por arquivo, 20 envios por minuto por aparelho, 500 traçados por conta. O arquivo fica no balde privado `sim-tracks`, em `<conta>/<hash da trackKey>.xtrk.gz` (a mesma pista cai sempre no mesmo arquivo), e a linha na tabela `sim_tracks` (migração `20261111120000_sim_tracks.sql`) guarda jogo, pista, layout, título, comprimento, tamanho e o SHA-256 dos bytes.

**Quando o Xpeed Sim faz o traçado.** Quando o leitor do Assetto Corsa (família `kunos`; o Competizione e o Rally não têm `fast_lane.ai`) ou o do rFactor 1 (Stock Car Extreme) informa que o carro está andando numa pista, o Xpeed Sim procura a pasta do jogo como o `track-dump` procura (as bibliotecas da Steam, ou `XPEED_AC_DIR` / `XPEED_SCE_DIR`) e monta o traçado:

* Assetto Corsa: `content/tracks/<pista>/<layout>` com os nomes que o jogo informa (`track` e `trackConfiguration`), sem diferença de maiúsculas. O traçado lido precisa ter a mesma `trackKey` que o jogo informou.
* Stock Car Extreme: o `.AIW` cujo nome (sem a extensão) é o nome da pista, como no `track-dump`; se nenhum tiver esse nome, o `.AIW` cujo `.gdb` tem `TrackName` igual. **Ainda não conferido com o jogo rodando** qual dos dois o plugin informa. O arquivo de pista leva `game: "sce"` e o nome do `.AIW`, como manda o formato; as voltas desse jogo levam `game: "rfactor1"` e o nome que o plugin informa, então casar a volta com o traçado ainda não está decidido (ver [FORMATO-DE-PISTA.md](FORMATO-DE-PISTA.md)).

Cada pista é tentada **uma vez por execução** do programa, numa linha de execução só dela (a leitura do jogo nunca espera). Se os arquivos do jogo forem recusados pela validação do extrator, ou a pista não for encontrada, isso vai **uma vez** para o log e o Xpeed Sim segue gravando as voltas normalmente.

**A fila dos traçados** é a pasta `tracks` dentro da pasta de voltas. O arquivo novo é escrito ali (como `.part` e depois renomeado) só quando os bytes mudaram. O registro `tracks/.xpeed-tracks.json` guarda, por arquivo, a `trackKey` e um hash dos bytes do que já foi enviado ou recusado (com o endereço do servidor, como o das voltas). Assim cada traçado vai **uma vez**, e de novo só se o arquivo mudar (por exemplo, um mod atualizou a pista). Antes de enviar, o Xpeed Sim abre o arquivo com o seu leitor estrito. Os traçados vão depois das voltas, no mesmo ciclo, com as mesmas regras (só HTTPS, sem redirecionamento, as mesmas esperas). `xpeed-sim upload DIR` também manda os de `DIR\tracks`.

## 3. O que o Xpeed Sim guarda e o que ele nunca faz

- **A pasta de voltas é a fila.** Uma volta só é pendente se estiver na pasta e não constar em `.xpeed-upload.json`, ao lado dela, que lista o que já foi enviado ou recusado (com o endereço do servidor; se a pessoa parear com outro servidor, a lista de enviadas recomeça). Se o computador desligar no meio, a próxima execução continua de onde parou. Nenhum arquivo de volta é apagado, movido nem alterado pelo envio.
- **Antes de enviar**, o Xpeed Sim abre o arquivo com o seu leitor estrito. Um arquivo que não é uma volta válida nem sai do computador.
- **Gravar nunca espera o envio.** O envio roda em outra linha de execução, para a leitura do jogo (100 Hz) não perder amostras por causa de uma rede lenta.
- **A chave nunca é impressa**, nem em erros.

## Gerenciar aparelhos (a pessoa, com o login do app)

| Chamada | O que faz |
| --- | --- |
| `POST /api/sim/codes` | Gera um código de pareamento: `{ "code": "ABCD-2345", "expiresAt": "…" }`. Aparece uma vez. |
| `GET /api/sim/devices` | Lista os aparelhos da conta: `id`, `name`, `created_at`, `last_seen_at`, `last_lap_at`, `revoked_at`. Nunca a chave. |
| `DELETE /api/sim/devices?id=…` | Revoga um aparelho. Os envios dele passam a dar `401`; as voltas já enviadas ficam. |
| `GET /api/sim/tracks` | Lista os traçados da conta: `{ "tracks": [{ "id", "game", "trackName", "variant" (ou null), "title" (ou null), "lengthM" (ou null), "size", "updatedAt" (ISO) }] }`, do mais recente para o mais antigo. |
| `GET /api/sim/tracks/<id>/file` | Baixa um traçado: os bytes gzip guardados, exatamente como o Xpeed Sim mandou (`Content-Type: application/gzip`). Traçado de outra conta: `404`. |
| `DELETE /api/sim/tracks/<id>` | Apaga um traçado (a linha e o arquivo): `204`. Se o Xpeed Sim mandar a pista de novo, ela volta. Traçado de outra conta: `404`. |

A leitura vale pela segurança por linha do banco: a pessoa só vê as próprias linhas, e a coluna da chave nem é legível para ela. A chave do aparelho não lê nada: `GET /api/sim/tracks` com ela dá `401`.

## O que ainda falta

1. A **tela do app** (Virtual > Xpeed Sim): gerar o código, listar e revogar aparelhos. Os endpoints acima já existem.
2. O app **listar as voltas do servidor** em Sessões, além das do aparelho (hoje só existem no navegador, em IndexedDB). Falta um endpoint para listar e baixar as voltas (`sim_laps` e o balde `sim-laps` já guardam tudo o que é preciso).
3. Guardar a chave no Gerenciador de Credenciais do Windows, em vez de um arquivo comum.
4. Conferir com o Assetto Corsa e o Stock Car Extreme rodando o envio automático dos traçados (os nomes que os jogos informam, e qual chave casa as voltas do `rfactor1` com os traçados `sce`).
