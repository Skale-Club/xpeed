# SimHub MCP

> **Protótipo.** O destino final é um módulo do app local do Xpeed (DS-ADR-002 no Notion); este servidor
> serve de bancada de testes para os endpoints e a edição de arquivos.

Controla o SimHub local sem mouse. Um arquivo só (`server.mjs`), sem dependências, Node 18+.
Fala MCP por stdio. Só funciona nesta máquina (SimHub em `127.0.0.1:8888`).

## Ferramentas

| Ferramenta | O que faz |
|---|---|
| `simhub_status` | SimHub aberto? Porta responde? Amostra dos dados do jogo. |
| `simhub_api_get` | Leitura: dados do jogo, `GetProperty/{nome}`, `EvaluateStringFormula`, dashboards, roles do Control Mapper, estado e perfil do Motion. |
| `simhub_api_action` | Ações que o SimHub expõe por GET (Motion, Devices, TriggerAction). Ex.: `api/Motion/SetCurrentProfileGain/MotionGlobal/60`. |
| `simhub_api_post` | Ações por POST. Ex.: `api/ControlMapper/StartRole` com `roleName` e `ownerId`. |
| `simhub_list_settings` | Lista os JSON de configuração em `PluginsData`. |
| `simhub_read_setting` | Lê um JSON (caminho relativo a `PluginsData`). |
| `simhub_write_setting` | Troca um JSON. **Recusa com o SimHub aberto**, valida o JSON e guarda backup em `.backups/` antes. |

## Pré-requisitos no SimHub (vêm desligados)

- **Control Mapper:** plugin ligado em `PluginsActivation.json`; sem ele, `GetRoles2` dá 500.
- **Motion:** plugin ligado **e** `"ApiEnabled": true` em `Common/MotionPlugin.GeneralSettingsV2.json`; sem isso, toda rota `api/Motion/*` dá 404. Documentação do próprio SimHub em `api/Motion/ApiIndex`.

Especificação completa (75 rotas, o que foi testado, regras): página 08 do hub Driver Sim no Notion.

## Travas

- Só chama `api/getgamedata`, `api/ControlMapper/` e `api/Motion/`.
- Só lê e escreve `.json` dentro de `PluginsData` (sem `..`, sem `_Backups`); só edita arquivo que já existe.
- A API interna **não é oficial** e pode mudar entre versões do SimHub (testado na 9.13.3).

## Testado em 10/nov/2026 (SimHub 9.13.3)

Passou: `initialize`, `tools/list`, `simhub_status` (200 no `getgamedata`), `simhub_list_settings`, leitura de
`Homepage.json`, recusa de endpoint fora da lista, recusa de caminho fora de `PluginsData`, recusa de escrita
com o SimHub aberto. **Não testado:** `simhub_api_post` e `simhub_write_setting` com sucesso (nada foi alterado).

## Ligar no Claude Code

```bash
claude mcp add simhub -- node C:/Users/Vanildo/Dev/xpeed/sim-racing/simhub-mcp/server.mjs
```
