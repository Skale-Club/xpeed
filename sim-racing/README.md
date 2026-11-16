# Driver Sim (projeto paralelo do Xpeed)

Projeto do **rig de sim racing** do dono: a parte **física** (cockpit, volante, pedais, câmbio, tela,
assento, movimento) e a parte **digital** (jogos, telemetria, ponte com o Xpeed). É o irmão do
[Driver RC](../rc-car/README.md): mesma forma de trabalhar, mesmo lugar para guardar decisões.
Mora dentro do repositório do Xpeed, mas **não faz parte do app dos clientes**: nada daqui entra no
build do Xpeed (Vite, Coolify, Capacitor).

> **Estado em 10/nov/2026:** projeto recém-criado. **Nenhuma decisão de hardware foi tomada e nada
> foi comprado.** Esta pasta só tem a estrutura e o escopo. As decisões vão sendo conversadas com o
> dono e gravadas no Notion (veja [Onde está o resto](#onde-está-o-resto)).

## Escopo

| Parte | O que cobre | Onde vive |
|---|---|---|
| **Física** | Cockpit, base de volante, volante, pedais, câmbio e freio de mão, tela(s) ou VR, assento, movimento, ligação no PC, energia | Aqui e no Notion (Driver Sim) |
| **Digital: o rig** | Jogos, ajustes de force feedback, perfis, software de apoio, rede | Aqui e no Notion (Driver Sim) |
| **Digital: telemetria** | Ler os jogos, gravar voltas, comparar voltas, pistas | **Modo Virtual do Xpeed** (`/sim/*`), não aqui |

O Driver Sim **aponta para** o modo Virtual e não duplica o plano dele. Quando uma decisão do rig
mexer na telemetria (por exemplo, qual jogo ler primeiro), ela é registrada nos dois lugares.

## Como trabalhamos (igual ao Driver RC)

- **Notion guarda as decisões e a história; o código e o rig de verdade são a evidência.**
- Decisões em ADRs (DS-ADR-###): contexto, alternativas, por quê, efeito, como desfazer, quem aprovou.
  Nunca se sobrescreve uma decisão: a nova substitui a antiga.
- Peça proposta vem com custo e link de compra nos EUA conferido no dia. Custo baixo é restrição.
- O dono é leigo em eletrônica de rig: explicar as peças em palavras simples.
- Nada conta como funcionando até rodar no hardware real e ficar registrado no diário de construção.

## Relação com o Xpeed

O Xpeed é organizado em **modos**: Real (OBD, em produção), **Virtual** (sim racing, em construção,
atrás de `VITE_ENABLE_VIRTUAL`, desligado em produção) e RC (escopo indefinido). O Driver Sim é o
lado físico e de bancada do Virtual. Plano do Virtual: `docs/telemetria-virtual-2026-11-10/PLANO.md`
(nas branches do PR #16 e #17; coletor do Le Mans Ultimate em `feat/collector-lmu`).

## O que existe nesta pasta hoje

| Caminho | Situação |
|---|---|
| `README.md` | Este arquivo. |
| `simhub-mcp/` | Servidor MCP local para controlar o SimHub sem mouse (API interna + JSON de configuração). Testado só em leitura. |

A pasta ainda **não foi commitada** (espera o OK do dono, como o `rc-car/`).

## Onde está o resto

Notion, hub **Driver Sim — 00 START HERE** (link no hub do Notion; veja a memória do projeto):
roadmap (DS-###), decisões (DS-ADR-###), diário de construção, hardware e peças, segurança e
ergonomia, exploração e o inventário do que o dono já tem.
