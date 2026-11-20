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

## 2c. Sinal de vida (a partir do Xpeed Companion 0.7.0)

Até a 0.6 o servidor só ouvia o computador quando ele mandava uma volta ou um traçado, e o site mostrava "Offline" para um computador ligado que não terminava uma volta havia horas. Agora o Xpeed Companion avisa que está rodando.

```
POST /api/sim/heartbeat
Authorization: Bearer xpd_…
Content-Type: application/json

{ "version": "0.8.0", "state": "idle" | "waiting" | "connected" | "needs_setup", "game": "ams2" | null, "pendingLaps": 0 }
```

- **Os quatro campos são todos:** nada pessoal (sem nome do computador, caminhos, conta nem voltas). `version` é a do programa (`0.7.0`, com etiqueta curta opcional: `0.8.0-beta.1`); `state` é `waiting` (rodando, esperando um jogo), `connected` (um jogo está mandando dados), `idle` (a pessoa pausou a leitura) ou, **a partir da 0.8.0**, `needs_setup` (o programa de um jogo está aberto há mais de 45 s e não manda dados: falta ligar uma opção no jogo; o site mostra qual); `game` é o id do jogo (`ac`, `ams2`, `lmu`…, o mesmo `game` do arquivo de volta) enquanto `connected` ou `needs_setup`, senão `null` (o campo é obrigatório, mas pode ser `null`); `pendingLaps` é quantas voltas esperam envio (inteiro >= 0, e acima de 1.000.000 vale 1.000.000; o servidor confere e não guarda). Um campo desconhecido é ignorado.
- **Quando vai:** ao abrir, depois **a cada 60 s**, e **na hora** em que o estado ou o jogo muda (um jogo conectou ou fechou, a leitura foi pausada ou retomada), com no mínimo 5 s entre dois. Só com o computador pareado. É um pedido de poucas dezenas de bytes: pode ir com um jogo aberto, e roda em uma linha de execução própria, que nunca atrasa a leitura.
- **O que o servidor faz** (uma chamada ao banco): confere a chave, conta 30 por minuto por aparelho (no banco, como o limite das voltas), e grava `last_seen_at = now()`, `companion_version`, `last_state`, `last_game` e `last_state_at` (a hora em que o estado ou o jogo **mudou**: "conectado desde"). `GET /api/sim/devices` e `companion.devices[]` da visão geral (API v1) passam a trazer `companion_version`/`version`, `last_state`/`state`, `last_game`/`game` e `last_state_at`/`stateAt`, nulos até o primeiro sinal. O site chama de **Online** o computador ouvido nos últimos **3 minutos**.

| Resposta | Significado | O que o Xpeed Companion faz |
| --- | --- | --- |
| `200` `{ "ok": true }` | Anotado. | Segue. |
| `401`, `403` | Chave recusada ou revogada. | Para de mandar sinal (o envio de voltas avisa a pessoa). |
| `400`, `413` | Corpo recusado (`invalid_json`, `invalid_request`, `invalid_version`, `invalid_state`, `invalid_game`, `invalid_pending_laps`, `too_large`: mais de 2 KB). Nunca acontece com o programa de verdade. | Tenta de novo bem devagar (5 min). |
| `429` (com `Retry-After`) | Mais de 30 no minuto. | Espera o que o servidor pediu. |
| `404`, `405`, `501` | Servidor antigo, sem este caminho. | Pergunta de novo a cada 5 min; o site decide "online" só por `last_seen_at`. |
| `5xx`, rede fora do ar, tempo esgotado (15 s) | Problema passageiro. | Tenta de novo com espera crescente (30 s, 1 min, 2 min … até 5 min), sem barulho: o `companion.log` ganha **uma** linha quando a falha começa e uma quando o servidor volta a ouvir, nunca uma por minuto. |

Toda recusa traz `{ "error": "…", "retryable": true|false }` como as do envio de voltas. Não há CORS (não é um navegador).

## 2d. Relatório de erro do Xpeed Companion (`POST /api/sim/companion-errors`)

Quando o Companion trava (um `panic`) ou um processo interno é reiniciado 3 vezes ou mais, ele guarda um relatório pequeno em arquivo (`error-reports.jsonl`, na pasta do próprio Companion, os 5 mais novos) e **o envia na próxima vez que abrir, já conectado a uma conta**. Só o servidor do próprio Xpeed recebe; nenhum serviço de terceiros.

```
POST /api/sim/companion-errors
Authorization: Bearer xpd_…
Content-Type: application/json

{ "version": "0.8.0", "worker": "uploader", "message": "uploader restarted 3 times in 10 minutes: …", "backtrace": "…", "os": "windows x86_64", "at": "2026-11-15T10:00:00.000Z" }
```

- **O que vai:** versão, o processo (`worker`: letras minúsculas, dígitos e `-`), a mensagem (até 500 caracteres), o rastro (até 4000), o sistema e a arquitetura (`windows x86_64`) e a hora. Nome de usuário do Windows em caminhos vira `[user]` no Companion e de novo no servidor; e-mail, telefone, token e `?consulta` são removidos no servidor. Nada de nome do computador, voltas, arquivos nem chave.
- **O servidor** confere a chave (revogada ou desconhecida: `401`), conta 10 por minuto por aparelho, calcula a própria impressão digital (mensagem e primeiro quadro do rastro, sem os números, mais o `worker`) e agrupa; quem vê é o admin, em "Problemas". Ocorrências ficam 30 dias.
- **Respostas:** `200 { "ok": true }`; `400`/`413` (`invalid_json`, `invalid_version`, `invalid_worker`, `invalid_message`, `invalid_backtrace`, `invalid_os`, `too_large`: o relatório é descartado); `401`; `429` com `Retry-After`; `404`/`405`/`501` (servidor antigo) e `5xx`: o relatório espera até a próxima abertura.

## 2e. Volta de referência (`GET /api/sim/reference`)

O Xpeed Companion pede ao servidor a volta contra a qual compara a volta atual (o "delta para a referência" do painel). Chave do aparelho, como o envio; sem CORS.

```
GET /api/sim/reference?game=lmu&track=<nome da pista>&car=<nome do carro>[&variant=<layout>]&kind=best|personal
Authorization: Bearer xpd_…
```

- `kind=personal`: a volta **mais rápida válida da própria dona do aparelho** naquele jogo, pista e carro.
- `kind=best` (padrão): a volta mais rápida do **placar público como a dona o enxerga** (as mesmas regras do placar, `sim_board`: perfil privado, oculto ou bloqueado nunca aparece; volta inválida, reprovada na plausibilidade ou oculta não conta). Se o placar não tem nenhuma volta visível, volta a melhor volta pessoal dela.
- Os nomes são casados como o envio os casa (apelidos do catálogo, só pelo nome da pista e do carro); nada é criado no catálogo. `variant` é lido e validado, mas não entra na busca: a volta é arquivada só pelo nome da pista.
- Parâmetros: `game` `^[a-z][a-z0-9_]{0,31}$`; `track` e `car` de 1 a 120 caracteres, sem caracteres de controle; `variant` opcional, mesma regra; `kind` `best` ou `personal`.

`200`:

```
{ "kind": "best" | "personal", "lapId": "<uuid>", "timeMs": 91234, "driver": "Ana" | null, "recordedAt": "2026-11-10T12:00:00.000Z",
  "stepM": 5, "points": [0, 412, 819, …] }
```

`points[i]` é o tempo da volta, em ms, aos `i × 5` m de distância desde a linha, até o fim da volta (uns 1200 inteiros numa pista de 6 km). Vem dos canais `t` e `dist` do arquivo da volta (`FORMATO-DE-VOLTA.md`) por interpolação linear; amostra sem número (NaN) ou cuja distância ou tempo volta para trás é ignorada, então a sequência sempre cresce; se a volta começa depois dos 0 m, os primeiros pontos valem o tempo da primeira amostra. `kind` é o da volta que veio (um `best` que caiu para a melhor pessoal diz `personal`); `driver` é o nome de exibição (ou o handle) do piloto público, e `null` quando a volta é da própria dona.

| Resposta | Significado |
| --- | --- |
| `200` | A referência, com `ETag: "<lapId>"` e `Cache-Control: private, max-age=300`. |
| `304` | `If-None-Match` já é o `ETag` da volta; sem corpo, e o arquivo nem é lido. |
| `400` | `invalid_game`, `invalid_track`, `invalid_car`, `invalid_variant` ou `invalid_kind`. |
| `401` | Chave ausente, desconhecida ou revogada. |
| `404` `no_reference` | Nenhuma volta serve (nome nunca enviado, nada válido, arquivo sumido ou sem distância utilizável). |
| `405` | Só `GET`. |
| `429` (com `Retry-After`) | Mais de **30 por minuto por aparelho**. |
| `5xx` | Problema passageiro (`retryable: true`). |

Toda recusa traz `{ "error": "…", "retryable": true|false }`. Código: `api/sim/reference.ts` (rota), `api/sim/_reference.ts` (os pontos), função `sim_reference_lap` (`supabase/migrations/20261119140000_sim_reference_lap.sql`, só leitura). Testes: `src/lib/sim/sim-reference.test.ts` e `npm run test:sim`.

## 2f. Painel ao vivo para o celular (`POST /api/sim/live`)

O Xpeed Companion manda o painel que está desenhando para o servidor, e o celular (a página PWA do site) o recebe de lá: **retransmissão pela nuvem** (decisão da dona, 2026-11-19), não ponto a ponto. Chave do aparelho, como o envio; sem CORS. O servidor guarda **só o último quadro de cada conta, na memória** (nada vai para o banco nem para o armazenamento) e nunca olha dentro de `model`.

```
POST /api/sim/live
Authorization: Bearer xpd_…
{ "v": 1, "seq": 1234, "sentAt": 1763550000000, "game": "lmu", "dashboard": "race" | "qualifying" | "practice" | "time_trial",
  "rows": [["times"], ["session", "flag"]],
  "image": "data:image/jpeg;base64,/9j/…",
  "model": { … } }
```

- `v` é `1`; `seq` é um inteiro ≥ 0 que cresce a cada quadro; `sentAt` é a hora do computador em ms; `game` `^[a-z][a-z0-9_]{0,31}$`; `rows` tem até 30 linhas, cada uma com 1 a 12 ids de widget `^[a-z_]{2,24}$` (o desenho do celular); `model` é um objeto qualquer (o `DashModel` do painel em camelCase), opaco para o servidor. O corpo tem no máximo **256 KB**.
- `image` (Companion 0.16+, opcional, só enquanto um celular assiste) é o próprio painel desenhado pelo Companion para a tela desse celular, como JPEG em data URL: o mesmo cabeçalho, os mesmos cards e as mesmas fontes do PC; só a posição dos cards muda, num layout para o celular em pé (400 unidades de largura) e outro deitado (1100, uma fileira), escolhido pelo formato da tela, com o que não cabe deixado de fora. A página mostra a imagem como está. O servidor só aceita `data:image/jpeg;base64,` com caracteres de base64 (`400 invalid_image`). Sem `image` (Companion anterior), a página usa `rows` e `model`.
- A página diz o espaço que tem para o painel ao abrir o stream (`GET /api/sim/live/stream?w=&h=&dpr=`, pixels CSS); a resposta a cada quadro traz `screen: { w, h, dpr }` do stream mais novo que disse um (ou `null`), e o Companion desenha a imagem para ela, a até 1,5 pixel por pixel CSS, JPEG qualidade 70 (50 a 80 KB). Com um celular assistindo, o Companion manda **5 quadros por segundo**.
- Um quadro com `seq` menor que o último aceito do mesmo aparelho é descartado (a resposta continua `200`), a não ser que o Companion tenha recomeçado: `seq` < 10 depois de mais de 10 s de silêncio.
- `200 { "viewers": N }`: quantos celulares estão com a transmissão aberta. **O Companion manda uns 10 por segundo enquanto `viewers` > 0, senão um a cada 2 s** (sem ninguém olhando, o quadro só mantém o servidor sabendo que o painel existe).
- `401` chave ausente, desconhecida ou revogada (o servidor lembra uma chave válida por 30 s: uma chave revogada ainda vale por esse tempo); `400 invalid_json | invalid_request | invalid_version | invalid_seq | invalid_sent_at | invalid_game | invalid_dashboard | invalid_rows | invalid_image | invalid_model`; `413 too_large`; `429 too_many_requests` (mais de **25 por segundo por aparelho**, com `Retry-After`); `503` (`retryable: true`; `busy` se o servidor está cheio de contas assistidas). Toda recusa traz `{ "error", "retryable" }`.
- Quadros com mais de 30 s são esquecidos. O lado do celular (`GET /api/sim/live`, `GET /api/sim/live/stream`) está em `docs/platform/API-V1.md`. Código: `api/sim/live.ts` (rotas), `api/sim/_live.ts` (memória e regras). Testes: `src/lib/sim/sim-live.test.ts`, `src/lib/sim/sim-live-hub.test.ts`.

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
