# Driver RC (projeto paralelo do Xpeed)

Sistema de **corrida local de carrinhos de controle remoto** com câmera, jogado pelo celular com um
controle de Xbox ou PlayStation preso nele. Mora dentro do repositório do Xpeed, mas **não faz parte
do app dos clientes**: nada daqui entra no build do Xpeed (Vite, Coolify, Capacitor).

> **Estado em 10/nov/2026:** nada foi comprado e **o firmware da placa ainda não existe**. O que há
> nesta pasta é o software do desenho antigo (Raspberry Pi + 4G), mais a página do piloto, que
> continua valendo. O histórico de decisões e a lista de peças ficam no Notion (veja
> [Onde está o resto](#onde-está-o-resto)).

## A ideia, como está decidida

- **Corrida local**, a 100–200 m de onde o piloto está (estacionamento ou área aberta). Nunca remota:
  sem 4G, sem internet, sem homelab no caminho (DR-ADR-013).
- **Uma placa ESP32-S3 com câmera em cada carro** transmite o vídeo por Wi-Fi para o celular do
  piloto e recebe os comandos dele. A placa gera os pulsos do motor e do servo de direção.
- **Cada piloto usa o próprio celular**: mostra o vídeo, lê o controle Xbox/PS e (depois) desenha a
  pista em realidade aumentada por cima da imagem.
- **Um laptop na pista é o hub da corrida** (fase 3): lobby, largada, voltas, classificação, botão de
  parar todos e tela de TV. Ele não processa vídeo, só o estado da corrida (DR-ADR-014).
- **O rádio original do carro continua funcionando** como controle de emergência (a ser provado na
  bancada).

```
 Controle Xbox/PS ──Bluetooth──▶ Celular do piloto (página "Piloto RC")
                                      │  ▲
                   comandos (50x/s)   │  │ vídeo ao vivo (MJPEG, ~80–150 ms)
                                      ▼  │
                       Wi-Fi do carro (fase 1) ou roteador da pista (fase 2+)
                                      │  ▲
                                      ▼  │
                    ESP32-S3 com câmera ──▶ motor + servo do carro
                    (failsafe na própria placa)
```

## O carro de teste

**Losi 1/28 Micro-T** (modelo LOS-1392, rádio Spektrum SLT2). Você chamou de carro provisório de
teste (DR-ADR-016). Tem um módulo 2-em-1 de ESC e receptor, bateria 2S de 350 mAh e um servo AS-1.

- O 2-em-1 original **sai da jogada sem ser cortado**: desconecta-se, e o carro volta ao original a
  qualquer momento.
- A placa assume: motor por um driver DRV8871, servo ligado direto, energia da bateria por um
  regulador de 5 V (UBEC).
- A placa, o firmware, o app e o UBEC servem para um carro futuro. Só o driver do motor é específico
  do Micro-T.

## Plano por fases

1. **Um carro, bancada e estacionamento.** Placa sozinha na mesa; depois placa e carro com jumpers e
   **rodas no ar**; depois uma placa de circuito soldada (DR-ADR-015). O carro cria o próprio Wi-Fi,
   sem roteador.
2. **Dois carros correndo.** Segunda placa, roteador de viagem, ID de carro, marcadores de pista e
   contagem de voltas em cada celular.
3. **Hub.** Laptop com lobby, largada, classificação e tela de TV, de 2 a 6 carros (a medir).

Os marcadores e portões impressos em 3D estão na página 10 do Notion (ArUco de 20 cm; 30 cm na
largada).

## Peças da primeira compra

A fonte da verdade é o banco **07 — Parts** no Notion, com preço e link verificados no dia. Resumo:

- XIAO ESP32-S3 Sense (placa com câmera), driver de motor DRV8871, UBEC 5 V, pigtails JST-PH e
  jumpers: **US$ 62,64**.
- Multímetro AstroAI AM33D (US$ 14,99 em 9/nov/2026) para medir a bateria. Ele mede tensão, não a
  carga real nem a saúde da bateria (DR-009).

Preços mudam: confira antes de comprar.

## Segurança (a lógica já existe e vira especificação do firmware)

- **Failsafe:** sem comando por 300 ms, o carro solta o acelerador sozinho.
- **Sem vídeo, sem acelerador:** se a imagem trava por 0,7 s, a página para de acelerar.
- **Desarma sozinho** ao trocar de app, apagar a tela ou perder o controle.
- **Teto de velocidade** configurável (padrão 40%). No hub, o mesmo teto vale para todos os carros.
- **Um piloto por vez** em cada carro.
- **Primeiro teste sempre com as rodas no ar**, antes de o carro tocar o chão.

## O que existe nesta pasta hoje

| Caminho | Situação |
|---|---|
| `pilot/` | Página do piloto (vídeo, controle Xbox/PS/teclado, armar, marchas). **Reaproveitável.** Ainda fala o protocolo do desenho antigo. |
| `car/control_server.py`, `car/test_control.py` | Lógica de segurança e 7 testes. **Vale como especificação do firmware.** O servidor em si é do desenho do Raspberry Pi. |
| `car/pwm.py`, `car/config.toml` | Driver da placa PCA9685. Obsoleto. |
| `video/`, `deploy/` | MediaMTX e instalador do Raspberry Pi. Obsoletos, a apagar. |
| `docs/LEGADO-pi-4g.md` | O README antigo (Pi + 4G + Tailscale), guardado para histórico. |
| `firmware/` | **Ainda não existe.** Será um fork do projeto vitorccs/esp32s3cam-rc-car (GPL-3). |

A pasta ainda **não foi commitada** (DR-008 espera o seu OK).

## Relação com o Xpeed

O Xpeed está sendo organizado em **modos**, escolhidos por cada pessoa, com o Real sempre primeiro:

| Modo | O que é | Estado |
|---|---|---|
| **Real** | Carro de verdade, pelo scanner OBD (o app de hoje) | Em produção |
| **Virtual** | Jogos de corrida (sim racing): telemetria, voltas, comparação de voltas, pistas. Rotas `/sim/*` | Em construção: interface (PR #16) e formato de arquivo de volta (PR #17). Desligado em produção por `VITE_ENABLE_VIRTUAL` |
| **RC** | Carrinhos de controle remoto com câmera (este projeto) | Só anotado como terceiro modo. Escopo ainda não definido |

Pontos de contato previstos: página do piloto atrás do login em `/lab/rc`, GPS e gravação de sessões
como as viagens, resultados de corrida no Xpeed. Nada disso existe ainda. O Driver RC não aparece
para os clientes do Xpeed enquanto o modo RC não for definido e liberado.

Vender o Driver RC como produto é só exploração (página 09 do Notion): exigiria app nativo, FCC,
decisão sobre a licença GPL-3 do firmware, regras de envio de bateria e responsabilidade legal.

## Testar a página do piloto no PC, sem hardware

```bash
python rc-car/car/control_server.py --dry-run -v
```
```bash
python -m http.server 8090 -d rc-car/pilot
```
Abra `http://localhost:8090`, desmarque "Só acelera se o vídeo estiver chegando", conecte em
`localhost` e use o teclado (W/A/S/D, Espaço para armar) ou um controle ligado ao PC. Precisa do
pacote `websockets` (`pip install websockets`). Testes da lógica de segurança:
```bash
cd rc-car/car && python -m unittest test_control.py
```

## Onde está o resto

Notion, hub **Driver RC — 00 START HERE** (https://app.notion.com/p/40ab7a68612181bfbaa5dad4b32ce59f):
roadmap (DR-###), decisões (DR-ADR-###, nunca sobrescritas), diário de construção, peças, segurança,
exploração, plano consolidado v1 (página 08), venda como produto (09) e kit de pista (10).

Plano do modo Virtual do Xpeed: `docs/telemetria-virtual-2026-11-10/` (nas branches do PR #16 e #17).
