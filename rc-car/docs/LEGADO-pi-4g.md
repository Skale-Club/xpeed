> **Arquivo histórico (31/out/2026).** Desenho antigo: Raspberry Pi Zero 2 W + 4G + Tailscale. Foi substituído pela corrida local com ESP32 (DR-ADR-013 a 016 no Notion). Os arquivos `car/`, `video/` e `deploy/` ainda são desse desenho. Guardado porque a pasta nunca foi commitada.

# Carrinho RC pelo 4G (projeto paralelo do Xpeed)

MVP para brincar: você dirige um carrinho de hobby **pelo celular preso no controle de Xbox ou
PlayStation**, vendo a câmera do carro ao vivo, de qualquer lugar onde o carro tenha sinal de 4G.
Mora dentro do repositório do Xpeed para, no futuro, reaproveitar recursos dele (veja
[Futuro](#futuro)). **Não faz parte do app dos clientes.** Nada daqui entra no build do Xpeed, e a
página do piloto só abre para quem está na sua rede Tailscale (veja [Quem tem acesso](#quem-tem-acesso)).

```
 Controle Xbox/PS ──Bluetooth──▶ Seu celular (página "Piloto RC", tela cheia)
                                    │  ▲
                 comandos 50x por s │  │ vídeo ao vivo (WebRTC, ~150–300 ms)
                                    ▼  │
                          Internet 4G + Tailscale (rede privada)
                                    │  ▲
                                    ▼  │
 Hotspot 4G no carro ──Wi-Fi──▶ Raspberry Pi Zero 2 W ──▶ PCA9685 ──▶ ESC (motor) + servo (direção)
                                    ▲
                                    └── câmera do Raspberry Pi
```

## Por que estas peças

| Escolha | Motivo |
|---|---|
| Câmera do Raspberry Pi em vez de GoPro | Para dirigir, o que importa é atraso baixo e ângulo aberto, não qualidade de cinema. A GoPro é cara e não manda vídeo com pouco atraso. Ela pode ir no carro só para **gravar**. |
| Pi Zero 2 W | O computador mais barato que comprime vídeo H.264 no hardware. Pequeno e gasta pouca bateria. |
| Hotspot 4G no carro em vez de modem USB | Nos EUA, os modems USB que funcionam bem nas operadoras custam ~US$ 100 e exigem configuração. Um hotspot (ou um Android velho) tem bateria própria, e o Pi só entra no Wi-Fi dele. |
| Tailscale | Liga celular e carro numa rede privada, mesmo atrás do NAT das operadoras, e dá HTTPS de graça. O navegador só deixa ler o controle numa página HTTPS. |

## Lista de compras (EUA)

Preços e estoque conferidos nas páginas das lojas em **31/out/2026**. Mudam rápido: confira antes
de comprar. O carro, o celular e o controle ficam de fora.

### Obrigatório

| Peça | Onde comprar | Preço |
|---|---|---|
| **Raspberry Pi Zero 2 W com header** (pinos soldados) | [Micro Center](https://www.microcenter.com/product/683270/raspberry-pi-raspberry-pi-zero-w-2-with-headers): retirada na loja, veja o estoque da sua | US$ 17.99 |
| | [Adafruit](https://www.adafruit.com/product/6008): esgotado, tem "Notify me" | US$ 19.80 |
| | [PiShop](https://www.pishop.us/product/raspberry-pi-zero-2-w-with-header/): esgotado | US$ 20.75 |
| | [Seeed Studio (kit)](https://www.seeedstudio.com/Raspberry-Pi-Zero-2-W-with-Header-Basic-Kit-p-6351.html): **em estoque**, mas envia da China | US$ 22.90 |
| **Câmera: Raspberry Pi Camera Module 3 Wide** (120°, HDR) | [Adafruit](https://www.adafruit.com/product/5658): **em estoque**. Na mesma página, marque o **"Raspberry Pi Zero FPC Camera Cable"** (US$ 3.95): o cabo que vem com a câmera não encaixa no Zero. | US$ 38.50 + 3.95 |
| **Placa de servo PCA9685** (gera os pulsos do ESC e do servo) | [Adafruit](https://www.adafruit.com/product/815): esgotado, tem "Notify me" | US$ 14.95 |
| | [Busca na Amazon](https://www.amazon.com/s?k=PCA9685+16+channel+servo+driver): genéricas (HiLetgo, SunFounder…). Preço não conferido, costuma vir em pacote com 2. | ~US$ 10 |
| **Jumpers fêmea-fêmea** | [Adafruit](https://www.adafruit.com/product/266): **em estoque** | US$ 3.95 |
| **Cartão microSD 16–32 GB** (classe A1 ou A2) | [Adafruit, cartões SD](https://www.adafruit.com/category/389). Qualquer marca boa serve; você provavelmente já tem um. | ~US$ 10 |
| **Subtotal** | | **≈ US$ 80–95** |

### Internet no carro (escolha uma)

| Opção | Custo |
|---|---|
| **A. Celular Android velho como hotspot** (recomendado se você tem um parado) + chip pré-pago de dados, ex. [Tello](https://tello.com) (rede T-Mobile; planos pequenos a partir de ~US$ 5–13/mês segundo sites comparadores, confira no site) | US$ 0 de aparelho |
| **B. Hotspot dedicado**, ex. [Franklin T10 na T-Mobile](https://www.t-mobile.com/hotspot-iot-connected-devices/franklin-t10-mobile-hotspot) (~US$ 90 em 2025, não consegui confirmar o preço atual) + [plano pré-pago T-Mobile](https://prepaid.t-mobile.com/prepaid-plans) (US$ 45/mês com 15 GB de hotspot) | ~US$ 90 + plano |

O Pi Zero 2 W só usa Wi-Fi **2,4 GHz**. No Android, deixe o hotspot em 2,4 GHz. No iPhone, ligue
"Maximizar compatibilidade".

### Energia do Pi (escolha uma)

| Opção | Custo |
|---|---|
| **Power bank USB pequeno** que você já tem + cabo micro-USB, na porta **PWR** do Zero. É o mais simples. | US$ 0 |
| Regulador ligado na bateria do carro: [Pololu D36V28F5 (5 V, 3,2 A)](https://www.pololu.com/product/3782) | US$ 23.95 |

### Suporte do celular no controle (impressão 3D, grátis)

- Xbox Series X/S: [Xbox Controller Phone Mount (boolmool)](https://www.printables.com/model/350274-xbox-one-controller-phone-mount-minimal-supports-e). O autor testou em controles Series X/S.
- PS5 DualSense: [PS5 DualSense Controller Phone Mount (Homefab3d)](https://www.printables.com/model/479716-ps5-dualsense-controller-phone-mount)

### Total

**≈ US$ 80–95** usando um Android velho e um power bank que você já tem. Se for comprar o hotspot,
o regulador e o cartão, chega a **≈ US$ 200**, mais o plano de dados.

### Consumo de dados

O padrão é 960×540 a 1,2 Mbit/s: uns **550 MB por hora** no chip do carro, e mais ou menos o mesmo
no seu celular, que recebe o vídeo. Para imagem melhor, suba para 1280×720 e 2 Mbit/s em
`video/mediamtx.yml` (~900 MB/h).

## Ligações

O receptor de rádio original do carro sai. O ESC e o servo passam a ligar na PCA9685.

| De | Para |
|---|---|
| PCA9685 VCC | Pi pino 1 (3,3 V) |
| PCA9685 GND | Pi pino 6 (GND) |
| PCA9685 SDA | Pi pino 3 |
| PCA9685 SCL | Pi pino 5 |
| Cabo de 3 fios do ESC | PCA9685 canal **0** (sinal = branco/amarelo, − = preto/marrom) |
| Cabo do servo de direção | PCA9685 canal **1** |
| Power bank (ou regulador) | porta micro-USB **PWR** do Zero (ou pinos 2 = 5 V e 9 = GND) |
| Câmera | conector de câmera do Zero, com o cabo para Zero |

O fio vermelho do ESC alimenta o servo pelo trilho V+ da PCA9685. **Não ligue o V+ da PCA9685 no Pi.**

## Instalação no carro

1. Grave o **Raspberry Pi OS Lite (64-bit)** com o [Raspberry Pi Imager](https://www.raspberrypi.com/software/).
   Nos ajustes:
   - usuário e SSH ligado;
   - hostname `carro`;
   - Wi-Fi: o **hotspot do carro**. Para a primeira instalação, o Wi-Fi de casa também serve; dá pra
     trocar depois com `sudo nmtui`.
2. Copie esta pasta para o Pi:
   ```bash
   scp -r rc-car seu-usuario@carro.local:~
   ```
3. No Pi, instale o Tailscale e entre na sua conta:
   ```bash
   curl -fsSL https://tailscale.com/install.sh | sh
   ```
   ```bash
   sudo tailscale up --hostname=carro
   ```
   No [painel do Tailscale](https://login.tailscale.com/admin/dns), ligue **MagicDNS** e **HTTPS Certificates**.
4. Instale o carrinho e reinicie:
   ```bash
   cd ~/rc-car && bash deploy/install.sh
   ```
   ```bash
   sudo reboot
   ```

## No celular do piloto

1. Instale o app **Tailscale** e entre com a mesma conta.
2. Pareie o controle por Bluetooth.
   - Xbox: segure o botão de parear até o logo piscar rápido.
   - PS4/PS5: segure Share/Create junto com o botão PS.
3. Abra no **Chrome** (Android) ou no **Safari** (iPhone) o endereço
   `https://carro.SEU-TAILNET.ts.net`. O comando `tailscale serve status` no Pi mostra o endereço exato.
4. Use "Adicionar à tela inicial": a página abre em tela cheia, deitada, como um app.
5. Toque em **Conectar**.

## Controles

| Xbox | PlayStation | Faz |
|---|---|---|
| RT | R2 | acelera (pressão proporcional) |
| LT | L2 | freia / ré |
| Analógico esquerdo | Analógico esquerdo | direção |
| Menu ≡ | Options | armar / desarmar (só arma com os gatilhos soltos) |
| B | Círculo | desarma na hora |
| LB / RB | L1 / R1 | marcha − / + (25, 50, 75, 100% do teto) |

## Segurança (já no software)

- **Failsafe:** se nenhum comando chegar em 300 ms (o 4G caiu, o app fechou), o carro solta o
  acelerador sozinho.
- **Sem vídeo, sem acelerador:** se a imagem travar por 0,7 s, a página para de acelerar.
- **Desarma sozinho** quando você troca de app, a tela apaga ou o controle desconecta.
- **Teto de velocidade** em `config.toml` (`max_forward = 0.4` = 40%). Suba aos poucos.
- **Um piloto por vez:** quem conecta por último assume o carro.

## Primeiro teste: RODAS NO AR

1. Carro em cima de uma caixa, rodas sem tocar em nada.
2. No Pi, deixe os logs abertos: `journalctl -fu rc-control`
3. Conecte, arme e acelere de leve.
4. Ajuste em `/opt/rc-car/config.toml` e depois rode `sudo systemctl restart rc-control`:
   - roda gira ao contrário → `invert = true` em `[throttle]`;
   - direção ao contrário → `invert = true` em `[steering]`;
   - carro puxa para um lado → `trim_us`;
   - servo forçando no fim do curso → aproxime `min_us`/`max_us` de 1500.
5. Muitos ESCs fazem ré só com **freio → neutro → ré** (dois toques no LT). Isso é do ESC, não do
   software. Veja o manual dele, inclusive a calibração de curso.

## Onde dirigir

Um carro 1:10 passa fácil de 25 mph. Comece num estacionamento vazio, com alguém perto do carro. Nos
EUA, carrinho RC em rua pública depende da regra da cidade: muitas proíbem em ruas e calçadas.
Confira a da sua antes. O carro pode parar onde o 4G falhar (o failsafe solta o acelerador) e alguém
vai precisar buscá-lo. Não dirija no meio do trânsito.

## Quem tem acesso

Hoje a página do piloto **não está na internet aberta nem no domínio do Xpeed**. Quem serve a página
é o próprio carro, pelo `tailscale serve`, e só abre em aparelhos logados na sua conta Tailscale.
Cliente nenhum chega nela. O código pode ficar público no GitHub sem problema: não tem senha nem
chave nele.

## Futuro

A ideia é trazer recursos do Xpeed para cá, sem misturar com o app dos clientes:

- **Página do piloto dentro do Xpeed**, numa rota separada só para a equipe (ex.: `/lab/rc`, atrás
  do login e de um papel de admin), ou num subdomínio. O celular continuaria no Tailscale para falar
  com o carro.
- **Rastreamento por GPS** do carro, no mapa do Xpeed, usando o GPS do celular-hotspot ou um módulo
  GPS no Pi.
- Gravar as sessões (trajeto, velocidade, bateria), como as viagens do Xpeed.
- **VR com câmera 360°**: pilotar com um óculos (ex.: Meta Quest, pelo navegador com WebXR),
  olhando em volta com a cabeça. Dois caminhos a avaliar:
  - **Câmera 360 de verdade**: mostra tudo em volta, mas precisa de muito mais banda (4–8 Mbit/s ou
    mais, ou seja, vários GB por hora de 4G) e tem mais atraso;
  - **Câmera comum num gimbal pan-tilt** que segue a cabeça: usa a mesma banda de hoje e tem menos
    atraso, mas só mostra para onde você está olhando.

## Testar no PC sem hardware

```bash
python rc-car/car/control_server.py --dry-run -v
```
```bash
python -m http.server 8090 -d rc-car/pilot
```
Abra `http://localhost:8090`, desmarque "Só acelera se o vídeo estiver chegando", conecte em
`localhost` e use o teclado (W/A/S/D, Espaço para armar) ou um controle ligado no PC. No
terminal aparecem os pulsos que iriam para o ESC e o servo. Precisa do pacote `websockets`
(`pip install websockets`).

Testes da lógica de segurança:
```bash
cd rc-car/car && python -m unittest test_control.py
```

## Problemas comuns

| Sintoma | O que ver |
|---|---|
| Pi não entra no hotspot | o hotspot precisa estar em 2,4 GHz; no Pi, `sudo nmtui` para trocar a rede |
| `i2cdetect -y 1` não mostra `40` | fios SDA/SCL trocados, ou VCC/GND |
| Ping alto (> 250 ms) | `tailscale ping carro`: se aparecer "via DERP", a conexão está passando por um servidor de retransmissão. Teste outra operadora no carro ou no celular. |
| Vídeo travando | baixe a resolução e o bitrate em `video/mediamtx.yml` e rode `sudo systemctl restart rc-video` |
| "controle sem mapeamento padrão" | use Chrome (Android) ou Safari (iPhone) e atualize o firmware do controle |
| Logs do vídeo | `journalctl -fu rc-video` |

## Arquivos

- `car/control_server.py`: recebe comandos e gera os pulsos, com failsafe
- `car/pwm.py`: driver da PCA9685 (e modo dry-run)
- `car/config.toml`: calibração do ESC e do servo
- `video/mediamtx.yml`: câmera → WebRTC
- `pilot/`: página do piloto (celular ou PC)
- `deploy/install.sh`: instala tudo no Pi, com serviços e `tailscale serve`
