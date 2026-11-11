# Envio de voltas do coletor para o Xpeed

Este é o contrato entre o coletor (Windows) e o servidor do Xpeed. **O coletor e o servidor já o implementam.** O servidor está em `api/sim/*` (migração `20261110200000_sim_collector.sql`, testes em `npm run test:sim`); o coletor, em `collector/src/net.rs` e `outbox.rs`, também é testado contra um servidor falso local (`collector/src/stub.rs`). Foi rodado o coletor de verdade contra os handlers de verdade, com um arquivo de volta escrito pelo próprio coletor (Rust) e aberto pelo leitor estrito do servidor (TypeScript).

O que trafega é o **arquivo de volta** de [FORMATO-DE-VOLTA.md](FORMATO-DE-VOLTA.md), sem mudança: o envio não cria um formato novo.

## Regras gerais

- **Só HTTPS.** O coletor recusa um endereço `http://` a não ser que o servidor seja da própria máquina (`localhost`, `127.0.0.1`, `[::1]`, usado em desenvolvimento). Assim a chave do aparelho nunca viaja em texto aberto.
- **Sem redirecionamento.** O coletor não segue redirecionamentos (um `3xx` é tratado como erro "use o endereço final"). A chave nunca é reenviada para outro endereço.
- **Endereço base** é o do app (por exemplo `https://xpeed.skale.club`). Os caminhos abaixo são relativos a ele.
- Respostas de erro trazem JSON `{"error": "texto curto"}`. O coletor só mostra esse texto; nunca decide nada por ele. A decisão é pelo código HTTP.
- O corpo de uma resposta com mais de 64 KiB é cortado pelo coletor.

## 1. Pareamento (uma vez por computador)

No app, a pessoa pede um **código de pareamento** (`POST /api/sim/codes`, entrando com a conta; a tela do app para isso ainda não existe): 8 caracteres de `A-Z` e `2-9` (sem `0 O 1 I`), válido por 10 minutos e usável **uma única vez**. Cada pessoa tem no máximo 5 códigos abertos e pode pedir 10 por hora. Só o hash do código fica guardado. No computador:

```powershell
xpeed-collector pair --server https://xpeed.skale.club --code ABCD-2345
```

```
POST /api/sim/pair
Content-Type: application/json

{ "code": "ABCD2345",
  "device": { "name": "MEU-PC", "platform": "windows", "collector": "0.1.0" } }
```

O coletor tira traços e espaços e põe em maiúsculas antes de enviar. O nome do aparelho é o do computador, ou o que a pessoa passar em `--name`. Serve só para ela reconhecê-lo na lista de aparelhos do app.

| Resposta | Significado |
| --- | --- |
| `200` `{ "token": "xpd_…", "deviceId": "…" }` | Pareado. O `token` é a **chave do aparelho** e só aparece aqui. |
| `400`, `404`, `410` | Código inválido, expirado ou já usado (o servidor responde `404 invalid_code` para os três, sem dizer qual). A pessoa pede outro no app. |
| `409` `device_limit` | A conta já tem 10 aparelhos ativos. O código **não** é gasto: revogue um aparelho e tente de novo. |
| `429` | Muitas tentativas (10 por minuto por endereço). Esperar. |
| `5xx` | Servidor com problema. Tentar de novo depois. |

A chave (`xpd_` + 43 caracteres) fica em `%APPDATA%\Xpeed\collector.json` (ou onde `XPEED_COLLECTOR_CONFIG` apontar), junto com o endereço. É um arquivo comum da pasta do usuário: quem lê essa pasta lê a chave. Por isso a chave só vale para **enviar voltas**, nunca para ler nada, e a pessoa a revoga (`DELETE /api/sim/devices?id=…`), o que faz o próximo envio receber `401`. O servidor guarda só o hash da chave.

## 2. Envio de uma volta

```
POST /api/sim/laps
Authorization: Bearer xpd_…
Content-Type: application/gzip
Content-Length: …

<os bytes do arquivo .xlap.gz, exatamente como estão em disco>
```

O servidor **abre o arquivo com o leitor estrito** do formato (o mesmo do app) e rejeita o que ele rejeitar. A identidade da volta é calculada pelo servidor a partir do cabeçalho: `jogo|pista|carro|início|volta|tempo|amostras` (a mesma `lapIdentity` do app), e é **por conta**. Por isso enviar de novo a mesma volta é seguro.

| Resposta | Significado | O que o coletor faz |
| --- | --- | --- |
| `201` `{ "id": "…", "duplicate": false }` | Guardada. | Marca como enviada. |
| `200` `{ "id": "…", "duplicate": true }` | O servidor já tinha esta volta. | Marca como enviada. |
| `401`, `403` | Chave recusada ou revogada. | **Para tudo** e pede para parear de novo. Nada é perdido. |
| `400`, `413`, `415`, `422` | Esta volta nunca será aceita (inválida, grande demais). | Marca como **recusada**, mostra o motivo, **não tenta de novo**, e segue para a próxima. |
| `429` (com `Retry-After`) | Devagar. | Para o ciclo e tenta de novo depois da espera pedida (no máximo 1 hora). |
| `408`, `5xx`, rede fora do ar, tempo esgotado | Problema passageiro. | Para o ciclo e tenta de novo com espera crescente (30 s, 1 min, 2 min … até 5 min). |
| `404`, `405`, `501` | Este servidor ainda não recebe voltas. | Como acima, com a mensagem "este servidor não recebe voltas". |
| `3xx` | Endereço mudou. | Como acima, com a mensagem de usar o endereço final. |

Limites do lado do servidor: **16 MiB** por arquivo (o coletor já nem tenta enviar mais que isso), 60 envios por minuto por aparelho, **5.000 voltas por conta** (acima disso, `422`) e os limites do próprio formato. O arquivo fica no volume, no balde privado `sim-laps`, em `<conta>/<hash da identidade>.xlap.gz`.

## 3. O que o coletor guarda e o que ele nunca faz

- **A pasta de voltas é a fila.** Uma volta só é pendente se estiver na pasta e não constar em `.xpeed-upload.json`, ao lado dela, que lista o que já foi enviado ou recusado (com o endereço do servidor; se a pessoa parear com outro servidor, a lista de enviadas recomeça). Se o computador desligar no meio, a próxima execução continua de onde parou. Nenhum arquivo de volta é apagado, movido nem alterado pelo envio.
- **Antes de enviar**, o coletor abre o arquivo com o seu leitor estrito. Um arquivo que não é uma volta válida nem sai do computador.
- **Gravar nunca espera o envio.** O envio roda em outra linha de execução, para a leitura do jogo (100 Hz) não perder amostras por causa de uma rede lenta.
- **A chave nunca é impressa**, nem em erros.

## Gerenciar aparelhos (a pessoa, com o login do app)

| Chamada | O que faz |
| --- | --- |
| `POST /api/sim/codes` | Gera um código de pareamento: `{ "code": "ABCD-2345", "expiresAt": "…" }`. Aparece uma vez. |
| `GET /api/sim/devices` | Lista os aparelhos da conta: `id`, `name`, `created_at`, `last_seen_at`, `last_lap_at`, `revoked_at`. Nunca a chave. |
| `DELETE /api/sim/devices?id=…` | Revoga um aparelho. Os envios dele passam a dar `401`; as voltas já enviadas ficam. |

A leitura vale pela segurança por linha do banco: a pessoa só vê as próprias linhas, e a coluna da chave nem é legível para ela.

## O que ainda falta

1. A **tela do app** (Virtual > Coletor): gerar o código, listar e revogar aparelhos. Os endpoints acima já existem.
2. O app **listar as voltas do servidor** em Sessões, além das do aparelho (hoje só existem no navegador, em IndexedDB). Falta um endpoint para listar e baixar as voltas (`sim_laps` e o balde `sim-laps` já guardam tudo o que é preciso).
3. Guardar a chave no Gerenciador de Credenciais do Windows, em vez de um arquivo comum.
