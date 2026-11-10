# Envio de voltas do coletor para o Xpeed

Este é o contrato entre o coletor (Windows) e o servidor do Xpeed. **O coletor já fala este contrato; o servidor ainda não o implementa.** Ele depende do banco de produção próprio (a virada da "fase 5" do [PLANO.md](PLANO.md)), porque precisa de uma tabela de aparelhos pareados e de um lugar para guardar as voltas. Até lá o coletor é testado contra um servidor falso local (`collector/src/stub.rs`), que segue exatamente o que está abaixo.

O que trafega é o **arquivo de volta** de [FORMATO-DE-VOLTA.md](FORMATO-DE-VOLTA.md), sem mudança: o envio não cria um formato novo.

## Regras gerais

- **Só HTTPS.** O coletor recusa um endereço `http://` a não ser que o servidor seja da própria máquina (`localhost`, `127.0.0.1`, `[::1]`, usado em desenvolvimento). Assim a chave do aparelho nunca viaja em texto aberto.
- **Sem redirecionamento.** O coletor não segue redirecionamentos (um `3xx` é tratado como erro "use o endereço final"). A chave nunca é reenviada para outro endereço.
- **Endereço base** é o do app (por exemplo `https://xpeed.skale.club`). Os caminhos abaixo são relativos a ele.
- Respostas de erro trazem JSON `{"error": "texto curto"}`. O coletor só mostra esse texto; nunca decide nada por ele. A decisão é pelo código HTTP.
- O corpo de uma resposta com mais de 64 KiB é cortado pelo coletor.

## 1. Pareamento (uma vez por computador)

No app (Virtual > Coletor), a pessoa pede um **código de pareamento**: 8 caracteres de `A-Z` e `2-9` (sem `0 O 1 I`), válido por 10 minutos e usável **uma única vez**. No computador:

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
| `400`, `404`, `410` | Código inválido, expirado ou já usado. A pessoa pede outro no app. |
| `429` | Muitas tentativas. Esperar. |
| `5xx` | Servidor com problema. Tentar de novo depois. |

A chave fica em `%APPDATA%\Xpeed\collector.json` (ou onde `XPEED_COLLECTOR_CONFIG` apontar), junto com o endereço. É um arquivo comum da pasta do usuário: quem lê essa pasta lê a chave. Por isso a chave só vale para **enviar voltas**, nunca para ler nada, e a pessoa a revoga no app (Virtual > Coletor > aparelhos), o que faz o próximo envio receber `401`.

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

Limites do lado do servidor: **16 MiB** por arquivo (o coletor já nem tenta enviar mais que isso) e, claro, os limites do próprio formato.

## 3. O que o coletor guarda e o que ele nunca faz

- **A pasta de voltas é a fila.** Uma volta só é pendente se estiver na pasta e não constar em `.xpeed-upload.json`, ao lado dela, que lista o que já foi enviado ou recusado (com o endereço do servidor; se a pessoa parear com outro servidor, a lista de enviadas recomeça). Se o computador desligar no meio, a próxima execução continua de onde parou. Nenhum arquivo de volta é apagado, movido nem alterado pelo envio.
- **Antes de enviar**, o coletor abre o arquivo com o seu leitor estrito. Um arquivo que não é uma volta válida nem sai do computador.
- **Gravar nunca espera o envio.** O envio roda em outra linha de execução, para a leitura do jogo (100 Hz) não perder amostras por causa de uma rede lenta.
- **A chave nunca é impressa**, nem em erros.

## O que falta do lado do servidor (quando houver banco)

1. Tabela de aparelhos: `id`, conta, nome, `token_hash` (só o hash da chave), criado em, último envio, revogado em.
2. Código de pareamento: curta duração, uso único, limite de tentativas por IP e por conta.
3. `POST /api/sim/pair` e `POST /api/sim/laps` como acima, com limite de tamanho e de ritmo por aparelho.
4. Tela do app (Virtual > Coletor): gerar o código, listar e revogar aparelhos.
5. O app passar a **listar as voltas do servidor** em Sessões, além das do aparelho (hoje elas só existem no navegador, em IndexedDB).
