# Plano — telemetria de jogos (modo Virtual) no Xpeed

Data: 10/11/2026. Estado: **proposta, nada implementado**. Base: `58094b1`.

## Decisões já tomadas

1. **Um sistema só, com seletor Real / Virtual.** Mesmo login, mesma conta, mesmo app (web, PWA e Android), mesmo chat, MCP e relatórios compartilhados. O seletor troca a navegação e os dados exibidos. **O Virtual é opcional e escolhido pela própria pessoa**: no onboarding e nos Settings ela escolhe Real, Virtual ou os dois. **Todo mundo pode escolher; o Real vem primeiro e é a prioridade (o padrão), o Virtual é a segunda opção.** O seletor só aparece para quem tem os dois. O modelo vem do Xpot (ver "Como o Xpot faz").
2. **Sem SimHub como dependência.** O Xpeed lê os jogos com leitores próprios. O SimHub pode virar uma fonte opcional no futuro, nunca obrigatória.
3. **Jogos-alvo: os da biblioteca de corrida do dono** (lista abaixo). Nada de lista longa de jogos menores.

## Resultado da fase 0 (10/11/2026) — bloqueio encontrado

Conferi as conexões reais, sem ler nenhum segredo:

| Onde | O que encontrei |
|---|---|
| Produção (`xpeed.skale.club`) | `/api/health` responde `database: ok`, `storage: ok`. O bundle público aponta para o projeto Supabase `drqmrddxlrlbqnydumjm`. |
| Desenvolvimento (`.env.local` desta máquina) | Aponta para o **mesmo** projeto `drqmrddxlrlbqnydumjm`. |
| `.env` | É um link para o Google Drive (`.../car-insights-ai/.env`) e não abriu agora; não foi lido. |
| `xpeed.place` | Sem resposta (ainda não está no ar). |

**Conclusão:** hoje desenvolvimento e produção compartilham o mesmo banco Supabase. Não existe banco de desenvolvimento isolado, e a produção ainda não está num PostgreSQL próprio no Hetzner, como pede o padrão do `AGENTS.md`.

**Consequência para este plano:** nenhuma migração `sim_*` deve ser aplicada enquanto isso não for resolvido. Qualquer migração de teste cairia no banco de produção.

**Decisão do dono (10/11/2026):** o Supabase atual (`drqmrddxlrlbqnydumjm`) é o banco de **desenvolvimento**. A produção vai para um PostgreSQL próprio no Hetzner, como no padrão do `AGENTS.md`. Hoje a produção ainda usa esse mesmo Supabase, e a migração está descrita em `.planning/HOSTING-MIGRATION.md` (junto com o domínio novo `xpeed.place`).

**Antes da fase 2** (a fase 1 não toca no banco e pode andar já):
1. Colocar a produção no PostgreSQL do Hetzner: banco com disco persistente, rede privada e backup diário no R2. Atenção: o Xpeed hoje usa autenticação, armazenamento e funções do Supabase, então essa migração é maior do que só levar as tabelas.
2. Só então o Supabase atual fica exclusivo de desenvolvimento, e as migrações `sim_*` entram nele primeiro.
3. Armazenamento das voltas: com a produção no Hetzner, usar um bucket R2 dedicado (privado, URL assinada). Decidir definitivamente junto com o item 1.

Enquanto o item 1 não acontecer, **nenhuma migração `sim_*` é aplicada**, porque cairia na produção.

### Atualização (10/11/2026, depois que a `main` andou)

A `main` ganhou as fases 1 a 5 da saída do Supabase (PR #8 a #15). O estado, conforme `docs/database/README.md` (04/11):

- O **PostgreSQL de produção no Coolify (`xpeed-db`) já existe, está migrado e conectado ao app**. O servidor aplica as migrações ao iniciar.
- O app só usa esse banco quando `VITE_DATA_API=true`. **A flag só liga no corte (fase 5)**, depois de levar os dados reais. O site ao vivo ainda aponta para o Supabase `drqmrddxlrlbqnydumjm` (conferido no bundle público), então o bloqueio de "dev e produção no mesmo banco" **continua até o corte**.
- Depois do corte, o Supabase `drqmrddxlrlbqnydumjm` vira só desenvolvimento, e `npm run dev` o sincroniza com uma cópia anonimizada da produção. Esse é o cenário que o `AGENTS.md` pede.

**Consequências para este plano:**

1. As fases 1b e 2 (migrações) esperam o **corte (fase 5)**. Uma migração escrita antes cairia no Postgres do Coolify ao iniciar o servidor, mas não no Supabase que a produção ainda lê, e o app quebraria ao buscar a tabela nova.
2. **Arquivos das voltas:** em vez de um bucket R2 direto, usar a camada que a `main` já criou, `FileStore` (`server/files.ts`, `/api/storage`), com bucket próprio `sim-laps`. Hoje os bytes ficam em disco (`STORAGE_DIR`, volume do Coolify), com links assinados HMAC; trocar por R2 depois é trocar uma classe. **O volume não entra no backup automático do banco**, então os arquivos de volta precisam entrar no backup antes de produção.
3. As migrações novas valem para os dois ambientes, como as 58 atuais (`supabase/migrations`), e entram pelo mesmo caminho do servidor.

## Terceiro modo: carrinhos de RC com câmera (anotado em 10/11/2026)

O dono informou que o sistema **também terá o módulo de carrinhos de RC com câmera**. Isso vira um terceiro modo ao lado de Real e Virtual. **Escopo ainda não definido**; o que já dá para dizer:

- A fase 1 foi escrita para uma lista de modos (`MODES`, `MODE_HOME`, `NAV`, `ModesContext`), então acrescentar `rc` é uma mudança localizada: um modo a mais na lista, um menu, um ícone, os textos nos três idiomas e as rotas `/rc/*`.
- O seletor segmentado passa a ter três lados e continua aparecendo **só para quem tem pelo menos dois modos**.
- No onboarding, "Real / Virtual / Os dois" deixa de servir: com três modos vira uma **lista com caixas de marcar**, Real em primeiro e já marcado, a pessoa liga o que quiser.
- A trava de rotas (`ModeGate`) e a trava no servidor (`mode_off`) valem igual para o RC.

**A definir com o dono antes de desenhar:** o que o módulo faz (ver a câmera ao vivo, gravar, telemetria do carrinho, controlar à distância?); onde está o código ou o equipamento hoje; como o vídeo chega (rede local ou internet) e onde fica guardado; se também é uma escolha livre de cada pessoa. Vídeo ao vivo e gravações pesam mais que telemetria e mudam armazenamento e custo.

## Estado da implementação (10/11/2026)

**Fase 1 (interface) feita, sem commit.** Seletor Real | Virtual (só para quem tem os dois), passo "o que você quer usar" no onboarding, cartão **Modos** nos Settings, menu e barra do celular por modo, trava de rotas e telas provisórias em `/sim/*`. Tudo atrás de `VITE_ENABLE_VIRTUAL` (desligado em produção; ligado no harness). Verificado: 662 testes passando (36 novos), typecheck e lint sem erros, e navegação conferida no harness em desktop e celular. **Fase 1b (modos na conta + trava no servidor) e as seguintes continuam pendentes**, a 1b depende da produção sair do Supabase.

**Análise de voltas no navegador (fase 4, sem banco).** Em Virtual > Comparar voltas dá para abrir arquivos `.xlap.gz` do coletor (ou voltas de exemplo) e ver, por distância: a diferença de tempo entre duas voltas, velocidade, acelerador e freio, o mapa da pista e os trechos onde se ganha ou perde tempo. Os arquivos ficam no navegador: nada é enviado. Falta ainda ler as voltas do servidor (fases 1b e 2, depois do corte).

**Lista de sessões (local).** Em Virtual > Sessões as voltas ficam guardadas no navegador (IndexedDB, uma biblioteca por conta, sem duplicatas), são agrupadas em sessões (mesmo carro e pista, sem pausa de mais de 30 minutos) e dá para abrir duas voltas na tela de comparar. Dá para adicionar arquivos soltos ou a pasta de saída do coletor. Ficam só neste aparelho: limpar os dados do navegador as apaga. Quando houver servidor, esta lista passa a ler de lá.

## Como o Xpot faz (analisado em 10/11/2026)

O Xpot (`C:\Users\Vanildo\Dev\xpot`) tem dois **módulos**, Visits e Tags, num app só. O desenho que ele usa serve quase igual ao Xpeed:

| Peça | Como o Xpot faz | Onde |
|---|---|---|
| Quem tem o quê | Cada pessoa tem uma lista de módulos (`sales_reps.modules`, ex.: `["visits","tags"]`). O admin da plataforma sempre tem todos. | `shared/modules.ts` (`repModules`) |
| O seletor | Controle segmentado `Visits \| Tags`, cada lado com a sua cor. **Só aparece quando a pessoa tem 2 ou mais módulos**; quem tem um só nunca o vê. | `client/src/components/ModuleSwitch.tsx` |
| Um mapa só das telas | Um arquivo diz quais telas pertencem a cada módulo. Barra lateral, barra do celular, paleta de comandos e título leem esse mesmo mapa. | `components/xpot/moduleNav.ts` |
| Trava no servidor | Rotas de um módulo devolvem 403 `module_off` para quem não o tem. Esconder o botão não basta. | `requireVisitsModule` em `server/routes/xpot/middleware.ts` |
| Quem concede | Um admin aprova ou convida e escolhe os módulos; um convidado recebe no máximo os módulos de quem o convidou. | `approveRep`, `invite.ts` |
| Lembrar onde estava | Último módulo usado em `localStorage`; última tela de cada módulo na sessão; um início por módulo. | `lib/xpot.ts` |
| Pontes entre módulos | Um selo colorido (`ModuleBadge`) avisa quando uma tela mostra dados do outro módulo. | `ModuleBadge.tsx` |
| URLs | **Não mudam** ao separar os módulos (decisão registrada em `docs/MODULES.md`). | — |

**Três diferenças que importam para o Xpeed:**

1. No Xpot quem concede o módulo é um **admin** (equipe de vendas). No Xpeed, quem escolhe é a **própria pessoa**, no onboarding e nos Settings.
2. O Xpot guarda a lista no banco. As preferências do Xpeed hoje ficam só no navegador (`xpeed.preferences.v1`, localStorage). Aqui é preciso guardar na **conta**, para valer no celular, no PWA e no Android, e para o servidor poder travar.
3. No Xpot os dois módulos existem para quem os recebeu. No Xpeed o Real é o padrão de todos e o **Virtual só aparece para quem o escolheu**: quem não escolheu não vê seletor, telas nem opção nenhuma.

## Como fica para o usuário

**Escolha livre, sem liberação por conta** (decisão do dono, 10/11/2026). A pessoa escolhe **Real**, **Virtual** ou **os dois**. O **Real é sempre o primeiro da lista e o padrão**; quem não escolhe nada fica só no Real, exatamente como hoje. As rotas `/api/sim/*` respondem 403 `mode_off` para quem não escolheu o Virtual (mesma trava do Xpot).

**Interruptor global enquanto o Virtual não está pronto.** Para que a fase 1 possa entrar no código sem mostrar um modo vazio a todos os usuários, existe um único interruptor da build (`VITE_ENABLE_VIRTUAL`), desligado em produção. Não é por conta: é "o produto Virtual já existe?". Quando as fases 3 e 4 estiverem prontas, liga-se, e a opção passa a aparecer para todos. Ligado só em desenvolvimento e no harness de testes.

**Onde a pessoa escolhe:**

- **Onboarding:** depois do "bem-vindo", um passo novo pergunta: *Carro real* (primeiro), *Jogos de corrida* ou *Os dois*.
  - Só Real: o fluxo de hoje, sem mudança (carro, depois adaptador).
  - Só Virtual: pula carro e adaptador e vai para o pareamento do coletor.
  - Os dois: carro agora; o coletor fica como próximo passo.
- **Settings:** um cartão **Modos** com Real e Virtual. Pelo menos um fica sempre ligado. É onde a pessoa troca depois, sem refazer o onboarding.

**O seletor no app:**

- Controle segmentado **Real | Virtual**, com uma cor para cada lado, como o do Xpot.
- **Só aparece para quem tem os dois modos.** Quem tem um só não vê seletor nenhum, e o app fica exatamente como hoje.
- Lembra o último modo usado e a última tela de cada modo.

**O que cada modo mostra:**

- **Real** (hoje): Painel, Ao vivo, Combustível, Tendências, Problemas, Códigos, Viagens, Manutenção, Carros. Nada muda de lugar.
- **Virtual** (novo, sob `/sim/*`): Painel, Sessões, Comparar voltas, Pistas, Carros do jogo, Coletor (pareamento e status).
- O chat e as ferramentas MCP sabem em que modo a pessoa está e usam só o contexto dele. Relatórios compartilhados funcionam nos dois.

**Cuidado que o código atual exige:** o `Index.tsx` manda quem não tem carro para o onboarding (usa o flag `ONBOARDING_KEY` no localStorage). Uma conta **só de Virtual** nunca terá carro, então o onboarding precisa marcar "concluído" ao terminar o caminho Virtual, e as telas do modo Real não podem exigir um carro quando o modo Real está desligado.

**Onde mexer no Xpeed:** `AppSidebar.tsx` hoje é uma lista fixa de itens. Vira um mapa por modo (como o `moduleNav.ts` do Xpot), lido pela barra lateral, pela barra do celular e pela paleta. `OnboardingWizard.tsx` ganha um passo. `SettingsPage.tsx` ganha o cartão. Os textos entram nos três idiomas (`en`, `pt-BR`, `es-ES`).

**Onde guardar:** uma tabela nova (por exemplo `account_modes`: usuário e lista de modos, com `real` sempre presente por padrão). A pessoa altera a própria linha; RLS por usuário. Como é mudança de banco, só entra depois do que está descrito em "Resultado da fase 0". **Até lá, a fase 1 guarda a escolha no navegador, separada por usuário** (mesmo padrão das preferências de hoje), e a 1b move para a conta.

## Por que tabelas separadas, e não as mesmas de `sessions`

A tabela `sessions` e tudo o que depende dela (`session_rows`, `session_flags`, `vehicle_issues`, reconciliação de problemas, regras por veículo, `PROCESSING_VERSION`) são feitos para OBD de carro real. Uma sessão de jogo não tem DTC, manutenção nem combustível pago, e tem conceitos que o OBD não tem (volta, setor, pista, posição na pista).

Misturar as duas coisas obrigaria cada consulta, regra e tela a filtrar a origem, e qualquer esquecimento contaminaria o diagnóstico do carro real. Por isso: **interface unificada, dados separados** (`sim_*`), compartilhando conta, autenticação, armazenamento, IA e MCP.

## Volume de dados

Os jogos entregam cerca de 60 amostras por segundo, com 40 a 60 canais (velocidade, rotação, marcha, pedais, volante, posição X/Y/Z, distância na volta, pneus, freios, combustível…). Ordem de grandeza, em float32:

| | Amostras | Bruto | Compactado (estimativa) |
|---|---|---|---|
| Volta de 2 min | ~7.200 | ~1–1,5 MB | ~200–400 KB |
| 1 hora de pista | ~216.000 | ~35–50 MB | ~5–10 MB |

O modelo atual de uma linha JSONB por amostra (`session_rows`) funciona para OBD (~1 Hz), mas não para isso. **Cada volta vira um arquivo**; o banco guarda só os metadados e os resumos.

## Arquitetura

```
Jogo ──(memória compartilhada / UDP)──> Coletor Windows ──HTTPS──> API Xpeed (/api/sim/*)
                                         │  grava local, separa              │
                                         │  por volta, fila offline          ├─> Postgres: sim_sessions, sim_laps, ...
                                         └──── upload direto (URL assinada) ─┴─> Armazenamento: 1 arquivo por volta
                                                                                    │
                                              Web / Android (modo Virtual) <────────┤
                                              Chat (IA) e MCP  <────────────────────┘
```

### 1. Coletor Windows

- App pequeno na bandeja do sistema. Precisa ser nativo, porque o navegador não lê memória compartilhada.
- **Recomendação: .NET 8**, executável único. `MemoryMappedFile` e UDP são nativos, e é a mesma base que os leitores conhecidos usam (o que facilita portar especificações).
- Detecta o jogo aberto, lê na taxa do jogo, grava cada volta em disco e envia quando a volta termina. Sem internet, fica na fila e reenvia depois (como os checkpoints de viagem já fazem no OBD).
- **Pareamento:** o coletor mostra um código, o usuário confirma em *Virtual → Coletor*. O coletor recebe um token próprio, guardado só como hash, nos moldes de `mcp_tokens`, mas com escopo exclusivo de envio de telemetria. Pode ser revogado na mesma tela.
- Atualização automática e assinatura do executável ficam para depois do MVP.

### 2. API (servidor Node no Coolify, mesmo padrão de `api/trip-checkpoints.ts`)

- `POST /api/sim/sessions` — abre ou retoma uma sessão (jogo, carro, pista, tipo de sessão). Idempotente por id gerado no coletor.
- `POST /api/sim/laps` — registra a volta (tempo, setores, válida/inválida, resumo) e devolve uma **URL de upload assinada**. O arquivo vai direto para o armazenamento, sem passar pelo servidor.
- `POST /api/sim/laps/:id/complete` — confirma o upload (tamanho e checksum).
- Pareamento: `POST /api/sim/pair/start`, `POST /api/sim/pair/confirm`.
- Cotas por usuário usando `user_quotas`, que já existe.

### 3. Banco (migrações novas, aditivas)

| Tabela | Conteúdo |
|---|---|
| `sim_collectors` | Coletores pareados: nome, hash do token, último contato, revogado em |
| `sim_tracks` | Pista normalizada (nome, variante, comprimento) + nomes originais por jogo |
| `sim_cars` | Carro do jogo normalizado (nome, classe) + nomes originais por jogo |
| `sim_sessions` | Usuário, jogo, pista, carro, tipo (treino/quali/corrida), início/fim, clima, melhor volta |
| `sim_laps` | Sessão, número, tempo, setores, válida, combustível usado, caminho do arquivo, checksum, resumo JSONB |
| `sim_lap_events` (opcional) | Pit, saída de pista, batida, bandeira |

RLS por `user_id` em todas, igual às tabelas atuais.

### 4. Arquivo da volta

- **Formato simples:** cabeçalho JSON (versão, jogo, canais, unidades, taxa) + colunas `Float32Array`, tudo em gzip.
- O navegador abre sem biblioteca extra (`DecompressionStream('gzip')`). Parquet foi descartado por enquanto, porque pesa no app.
- Canal obrigatório: **distância na volta**, para alinhar e comparar voltas pelo ponto da pista e não pelo tempo.
- Armazenamento: bucket próprio (`sim-laps`), separado em dev e produção. Antes de produção, decidir entre Supabase Storage e um bucket R2 dedicado, pelo volume (fase 0).

### 5. Web e IA

- Tela de sessão: lista de voltas, melhor volta, consistência, setores.
- Tela da volta: gráficos por distância (velocidade, pedais, marcha, volante), mapa da pista desenhado com X/Y.
- **Comparar voltas:** duas voltas sobrepostas e diferença de tempo acumulada (delta), mostrando onde se ganha e se perde tempo.
- Chat: contexto do modo Virtual (últimas sessões, melhores voltas, onde perde tempo).
- MCP: `list_sim_sessions`, `get_sim_session`, `get_lap_summary`, `compare_laps`, só leitura, igual às ferramentas atuais (`list_sessions`, `get_session_detail`…).

## Jogos e leitores

| Leitor | Jogos | Fonte |
|---|---|---|
| rFactor | **Le Mans Ultimate**, rFactor 2, Stock Car Extreme | Memória compartilhada (SCE no formato do rFactor 1) |
| Kunos | Assetto Corsa, ACC | Memória compartilhada |
| Madness | Project CARS, Project CARS 2, Automobilista 2 | Memória compartilhada |
| Codemasters | F1 2015/2018/2020/25, DiRT 4, DiRT Rally, DiRT Rally 2.0, GRID 2 | UDP (o F1 tem um formato por ano) |
| RaceRoom | RaceRoom | Memória compartilhada |
| Outros | BeamNG.drive (UDP OutGauge), Euro Truck Simulator 2 (kit da SCS) | — |
| **A confirmar** | AC EVO, AC Rally, RENNSPORT, Wreckfest 2, Dakar 18, art of rally, Circuit Superstars, City Car Driving, STAR WARS: Galactic Racer | Verificar se há telemetria oficial |
| Fora | Motorsport Manager (gestão), Sim Racing Telemetry (é app concorrente, não jogo) | — |

## Fases

Cada fase termina com algo usável e verificável. O porte é comparativo, não prazo.

| Fase | Entrega | Critério de aceite | Porte |
|---|---|---|---|
| **0. Decisões e ambiente** | Onde está o banco de produção hoje (Supabase ou Hetzner), armazenamento das voltas (Supabase Storage ou R2), nome/marca do modo Virtual | Conexões reais inspecionadas antes de qualquer migração; decisões registradas aqui | Pequeno |
| **1. Modos Real / Virtual (interface)** | Um hook único `useModes()`, mapa de telas por modo, seletor segmentado, passo "modo" no onboarding, cartão "Modos" nos Settings, telas Virtuais vazias. Escolha guardada no navegador, por usuário. Tudo atrás do interruptor global `VITE_ENABLE_VIRTUAL` (desligado em produção) | Com o interruptor desligado, o app é **idêntico** ao atual e os testes existentes passam; ligado, o seletor só aparece para quem escolheu os dois; conta só-Virtual não cai em laço no onboarding; Real sempre primeiro | Pequeno/médio |
| **1b. Modos na conta (banco + trava)** | Tabela `account_modes`, leitura/gravação pela API, trava `mode_off` em `/api/sim/*` | A escolha vale em todos os aparelhos; RLS ensaiado com usuários A/B; quem não escolheu Virtual recebe 403. **Depende do banco isolado (fase 0)** | Pequeno |
| **2. Banco, API e formato** | Migrações `sim_*`, rotas `/api/sim/*`, leitor/gravador do arquivo de volta | Volta sintética enviada e reaberta igual (checksum); RLS ensaiado com usuários A/B; replay de migrações passa | Médio |
| **3. Coletor MVP com LMU** | Coletor .NET com pareamento, leitor rFactor/LMU, fila offline | Sessão real de LMU aparece no Xpeed com voltas e tempos corretos (comparados com o jogo); queda de internet não perde volta | Grande |
| **4. Análise no app** | Tela de sessão, tela de volta, mapa, comparar voltas | Delta entre duas voltas bate com a diferença de tempo oficial; funciona no celular (360 px) | Médio/grande |
| **5. Mais leitores** | Kunos → Madness → Codemasters/F1 → RaceRoom → BeamNG/ETS2 | Para cada jogo: uma sessão real gravada, tempo de volta conferido com o jogo | Médio por leitor |
| **6. IA e MCP** | Chat e ferramentas MCP do modo Virtual | Chat responde sobre voltas reais sem misturar com o carro real; ferramentas MCP com paginação | Médio |
| **7. Jogos a confirmar** | Pesquisa e, quando houver telemetria, leitor | Cada jogo marcado como suportado ou sem telemetria, com fonte | Variável |

A fase 1 é só interface e pode andar já. A 1b e a 2 mexem no banco e esperam o corte da produção para o PostgreSQL próprio (ver "Atualização" em "Resultado da fase 0"). O modo RC (ver "Terceiro modo") entra como fase própria depois de definido. A 3 depende da 2. As fases 4, 5 e 6 dependem da 3.

## Limites

- Nada do modo Virtual altera tabelas, regras ou telas do modo Real. Migrações só aditivas, sem reset de banco remoto.
- Desenvolvimento usa banco e bucket de dev, separados de produção (padrão do `AGENTS.md`).
- Coletor só lê telemetria pelas interfaces oficiais de cada jogo. Nada de injeção em processo ou leitura de memória fora das áreas publicadas pelo jogo.
- Sem dados reais de terceiros nos testes; voltas sintéticas e gravações do próprio dono.

## Em aberto

- **Marca:** "Xpeed Virtual", "Xpeed Sim" ou outro nome para o modo.
- **Identificar pista e carro entre jogos:** o mesmo circuito tem nomes diferentes em cada jogo. Começar com nome original + tabela de equivalência manual.
- **Coletor no Android?** Não: os jogos rodam no PC. O celular só visualiza.
- **Ao vivo durante a corrida** (painel no celular enquanto joga): possível depois, pelo coletor na rede local, fora do MVP.
