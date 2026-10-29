# Plano de execução — estabilização do Xpeed

Data: 29/10/2026. Base: `61340cde3514af1bb1b6102bfaeca7d97e65d95a` + ajuste visual de rodapé solicitado durante a avaliação.

Estado: **plano concluído e execução conservadora local realizada após autorização do usuário**. O [registro de execução](EXECUCAO.md) é a fonte atual de status e resultados. IDs A = achados; H = investigações. As caixas abaixo mantêm os critérios originais; uma tarefa só está integralmente aceita quando todos os ensaios exigidos passaram. PostgreSQL embarcado/RLS e Deno foram verificados; staging hospedado, integrações externas e Android físico continuam pendentes.

## Estado após a execução local

| Tarefa | Estado atual |
|---|---|
| T01 | 303 testes/40 arquivos, 3 testes Deno e 12 verificações SQL passam |
| T02 | PostgreSQL isolado via PGlite; Deno 2.9.6 disponível; sem alteração de ambiente remoto |
| T03 | Migração aditiva validada em PostgreSQL embarcado; staging hospedado pendente |
| T04 | 55 migrações passam replay; políticas migradas ensaiadas com A/B/admin/anon; serviços reais pendentes |
| T05 | Erros explícitos, DTCs e paginação de sessões/flags implementados e testados localmente |
| T06 | Conversões explícitas implementadas; política para unidades ausentes/ambíguas preservada para decisão |
| T07 | Segundos/timestamps, duração e lacunas/null corrigidos; política para grandes saltos pendente |
| T08 | Transação executada no PostgreSQL; rollback, ID e resolved preservados; staging pendente |
| T09 | Holds de persistência e reload protegido testados; IDB/service worker reais ainda precisam de ensaio integrado |
| T10 | Identidade/checksum e publicação idempotente implementados/testados; conflitos legados preservados; VIN/aparelho pendentes |
| T11 | Corridas de histórico/resposta corrigidas e cobertas; UX de retry avançado adiada |
| T12 | Compatibilidade de UI e validação Deno testadas; provedor/quota externos não chamados |
| T13 | Proxy e testes locais concluídos; OAuth externo/revogação de concessões pendentes |
| T14 | Preview, renovação, troca de viagem e retry testados; formatos limitados a JPG/PNG/WebP; órfãos pendentes |
| T15 | Formatadores principais e rodapé corrigidos; smoke local em desktop/390/360 px |
| T16 | Frontend/API/Deno/SQL e lint bloqueantes nos workflows; 0 erros/11 avisos locais; gates externos pendentes |
| T17 | README e runbook atualizados; hipóteses e decisões registradas |
| T18 | Testes/smoke locais feitos; homologação real de banco/integrações/hardware pendente |

## Resultado pretendido

1. Nenhum erro de consulta vira mensagem de carro saudável.
2. O mesmo CSV, em segundos ou timestamps e em unidades equivalentes, produz diagnóstico equivalente.
3. Reavaliar preserva a identidade da viagem e atualiza todos os derivados de forma consistente.
4. Uma viagem fica recuperável antes de qualquer reload; retries não duplicam nem destroem registros completos.
5. Histórico, chat, IA e MCP respeitam seus contratos reais, incluindo paginação e mudança de contexto.
6. Banco limpo e banco com dados existentes chegam ao mesmo esquema funcional sem perda de dados.
7. CI valida os caminhos que são publicados; homologação distingue simulação de hardware real.

## Ordem recomendada

| Etapa | Tarefas | Entrega verificável | Dependências | Porte relativo |
|---|---|---|---|---|
| 0. Base confiável | T01–T02 | Fixtures, contrato das consultas e baseline repetível | Nenhuma | Médio |
| 1. Banco e leituras | T03–T05 | Upgrade preserva dados; erros explícitos; histórico completo | T01–T02 | Grande |
| 2. Diagnóstico | T06–T08 | Unidades/tempo corretos e reprocessamento consistente | Banco e leituras | Grande |
| 3. Continuidade da viagem | T09–T10 | Reload seguro e upload idempotente | T01; T03 para escrita transacional | Grande |
| 4. Contratos e acabamento | T11–T15 | Chat/IA/MCP/fotos/fuso coerentes | Leituras e diagnóstico quando aplicável | Médio/grande |
| 5. Gates e operação | T16–T17 | CI bloqueante e documentação atualizada | Correções anteriores | Médio |
| 6. Homologação | T18 | Evidência E2E em banco isolado, navegador e Android | T03–T17 | Depende de ambiente/aparelho |

O porte é comparativo, não uma promessa de prazo. Banco sem ambiente isolado e Android sem aparelho são dependências explícitas de homologação. Não impedir o trabalho local independente enquanto elas são preparadas.

## Limites de implementação

- Preservar viagens, flags, problemas, ocorrências, links compartilhados e arquivos brutos existentes. Nada de reset remoto ou exclusão em massa para resolver divergência de esquema.
- Corrigir com mudanças pequenas por responsabilidade. Evitar refatoração global simultânea ao diagnóstico.
- Usar dados sintéticos e ambientes isolados nos testes. Não colocar chaves reais nos fixtures, logs ou documentos.
- Não mudar limiares mecânicos de todos os veículos nesta entrega; corrigir primeiro como unidade e tempo chegam aos limiares existentes.
- Não adicionar visão por IA, novas ferramentas MCP de escrita, novo domínio, nova hospedagem ou novo provedor de IA.
- Manter silhuetas/fotos de carros e ferramentas avançadas existentes. Compatibilidade com análises antigas precisa ser explícita.
- O ajuste do rodapé já solicitado está aplicado e verificado no navegador; não reabrir esse item como pendente.

## Etapa 0 — Base confiável

### T01 — Fixtures e testes de regressão por contrato

**Cobertura:** A01–A06, A09–A11, A14; lacunas do harness.

**Arquivos:** `src/test/`, testes de `src/lib/db`, `csv-parser`, `insight-engine`, `SessionDetail`, `HistoryPage`, `pwa-update`; novos testes dos handlers `api/` quando necessário.

- [ ] Criar fixtures pequenos de segundos, timestamps, °C/°F, km/h/mph, intervalos irregulares, lacunas/null, arquivo grande e CSV sem coluna temporal.
- [ ] Incluir uma viagem com DTC e sem flags; pelo menos 1.201 viagens com horários repetidos; dois carros e dois usuários sintéticos.
- [ ] Fazer o teste exercitar o helper real de consulta antes da página. O mock deve respeitar projeção, range e múltiplos critérios de ordenação ou o teste deve usar integração isolada.
- [ ] Manter separação clara: harness visual pode continuar simples, mas não pode ser apresentado como teste de RLS ou banco.

**Aceite:** cada bug prioritário tem um teste que falha pelo motivo correto antes da correção. Não aceitar snapshots ou asserts que apenas repetem strings da implementação. O script `reproducoes.mjs` serve de evidência inicial, não substitui a suíte de aceite.

### T02 — Inventário de contratos e ambiente isolado

**Arquivos:** `src/integrations/supabase/types.ts`, `supabase/migrations`, tsconfigs, configuração de testes e API.

- [ ] Mapear tabelas/colunas/funções utilizadas pelo produto e ausentes nos tipos gerados.
- [ ] Preparar Supabase/PostgreSQL local ou projeto de staging autorizado para T03/T04; registrar versões e migrations aplicadas. O daemon Docker estava indisponível durante a avaliação.
- [ ] Criar checklist de usuários A/B/admin/anon e de buckets privados, sem copiar credenciais de produção.
- [ ] Identificar ambientes necessários para funções Deno e handlers Web Request/Response.

**Aceite:** comandos de teste documentados; nenhum teste depende da presença de uma conta ou UUID de produção. Atualizar tipos somente a partir do esquema validado em T03/T04.

## Etapa 1 — Banco, erros e histórico

### T03 — Completar o esquema sem apagar problemas

**Cobertura:** A04. **Arquivos:** nova migração posterior às existentes; `src/lib/db-issues.ts`, `issue-reconciler.ts`, tipos gerados.

- [ ] Criar upgrade incremental com `ADD COLUMN IF NOT EXISTS` para `details` e `updated_at`, backfills e constraints compatíveis com dados presentes.
- [ ] Verificar forma antiga real e forma criada pelo histórico versionado. Não usar apenas `first_session_id` como detector.
- [ ] Reconciliar triggers, índices e políticas por nome/semântica, inclusive políticas permissivas antigas que se somam às novas.
- [ ] Regenerar os tipos e retirar casts apenas no escopo corrigido, sem espalhar um novo `any` geral.

**Aceite:** upgrade roda em cópia com linhas existentes, mantém IDs/ocorrências, permite criar e resolver problema com details e atualiza updated_at. Executar novamente deve ser seguro conforme o contrato da nova migração. Acesso entre usuários continua negado.

### T04 — Tornar o bootstrap e as políticas reproduzíveis

**Cobertura:** A07; RLS e H04/H05 quando puderem ser observados.

- [ ] Executar histórico inteiro num banco descartável e registrar o primeiro erro real, inclusive seeds anteriores a `exec_sql`.
- [ ] Para replay limpo, preparar alterações mínimas e documentadas de guards/ordem no histórico que pressupõe estado manual: a criação precisa preceder o REVOKE ou ser protegida, e seeds não podem presumir usuários de produção. Não reaplicar esses arquivos históricos no banco vivo.
- [ ] Usar migrações futuras para upgrades dos bancos existentes. Não manipular o histórico remoto nem fazer squash sem necessidade demonstrada.
- [ ] Testar A/B/admin/anon em leitura e escrita de carros, sessões, flags, problemas/ocorrências, chat, manutenção, compartilhamento, MCP tokens e buckets. Testar relações cruzadas, não só `user_id` da linha principal.
- [ ] Validar que admin mantém suporte de leitura previsto, mas a lista pessoal de carros não agrega inadvertidamente veículos alheios.

**Aceite:** replay limpo termina, upgrade com dados termina e os dois convergem no esquema necessário ao produto. Todos os testes de isolamento passam; service role não é usado para mascarar uma falha de RLS na aplicação.

### T05 — Leituras explícitas e paginação real

**Cobertura:** A03, A06, A10. **Arquivos:** `src/lib/db.ts`, `HistoryPage.tsx`, `Index.tsx`, `SessionDetail.tsx`, `HomeCards.tsx`, consumidores de contexto.

- [ ] Propagar erros dos helpers; diferenciar 404/ausência, falha temporária e último resultado válido. Não renderizar “Tudo certo” com dados incompletos.
- [ ] Incluir `active_dtcs` no contrato mínimo de listagem e usar tipo explícito da resposta.
- [ ] Implementar paginação no banco com ordem estável por data efetiva + ID. Preferir cursor; se usar offset, documentar e testar inserção concorrente para evitar repetição/omissão.
- [ ] Tornar filtros/ordem do histórico e “última viagem” consistentes para uploads atrasados. Totais devem vir de agregados completos ou ter escopo visível rotulado; nunca inferir total da primeira página.
- [ ] Dar tratamento independente à falha na leitura de flags, detalhes, arquivo bruto e agregados.

**Aceite:** DTC sem flags aparece como problema; erro de flags aparece como erro recuperável; 1.201 viagens podem ser percorridas sem IDs duplicados ou ausentes; totais correspondem ao banco; upload antigo não toma o lugar da viagem cronologicamente mais recente.

## Etapa 2 — Diagnóstico confiável

### T06 — Normalizar unidades e preservar origem

**Cobertura:** A02. **Arquivos:** `canonical-params.ts`, `csv-parser.ts`, tipos de sessão/relatório e testes.

- [ ] Separar identificação do sensor da identificação da unidade. Manter valor/unidade de origem ou o CSV bruto preservado.
- [ ] Converter unidades reconhecidas para as canônicas antes de resumos, regras, distância, gráficos e IA.
- [ ] Definir comportamento para unidade ausente, ambígua ou não suportada: não atribuir confiança que o dado não tem. O scanner próprio, que já informa unidades conhecidas, continua funcionando.
- [ ] Testar colisões de nomes de parâmetros e unidades em logs externos comuns.

**Aceite:** 194 °F equivale a 90 °C e não produz superaquecimento; 60 mph equivale a aproximadamente 96,56064 km/h. Fixtures equivalentes geram os mesmos flags/resumos dentro da tolerância numérica definida. CSV original pode ser baixado sem alterações.

### T07 — Um eixo temporal para toda a análise

**Cobertura:** A05 e parte de A01. **Arquivos:** parser, motor de regras, upload, relatório e testes.

- [ ] Derivar tempo relativo consistente de segundos ou timestamps; validar monotonicidade, duplicatas e datas inválidas.
- [ ] Calcular duração total e duração dos trechos por tempo decorrido. Lacunas/null não podem juntar artificialmente sequências críticas.
- [ ] Definir claramente a contribuição da primeira/última amostra e uma política conservadora para grandes buracos, sem inventar um segundo onde há um intervalo desconhecido.
- [ ] Reutilizar essa interpretação no relatório e na seleção das viagens elegíveis à IA.

**Aceite:** arquivos equivalentes em segundos e timestamps geram diagnóstico equivalente; 20 s de temperatura crítica são reconhecidos; lacunas não viram um trecho contínuo falso; duração/distância não desaparecem apenas pelo formato temporal.

### T08 — Reprocessar preservando identidade e consistência

**Cobertura:** A01. **Depende de:** T03, T05, T06, T07.

**Arquivos:** `SessionDetail.tsx`, novo serviço de processamento compartilhado com `use-csv-upload.ts`, helpers/RPCs e migração se necessária.

- [ ] Reutilizar o processamento determinístico de upload sobre o CSV bruto do Storage ou fallback `source_csv`; separar obtenção dos dados e persistência.
- [ ] Se o bruto estiver indisponível, deixar o registro intacto e informar que a reavaliação não pode ser concluída. Não usar silenciosamente os 2.000 pontos do gráfico.
- [ ] Atualizar flags, summary, report, versão e relações de problemas de forma transacional ou com staging/publicação atômica. Preservar o ID da sessão e links compartilhados.
- [ ] Preservar decisões manuais de ignorar/resolver problemas; não apagar histórico de ocorrências para ocultar diferenças. Definir explicitamente tratamento de análises de IA antigas após mudança de versão.
- [ ] Usar versionamento real do pipeline e das regras; evitar versões literais divergentes em vários arquivos.
- [ ] Garantir que clique duplo e falha intermediária não deixem dois conjuntos de flags ou derivados de versões diferentes.

**Aceite:** reavaliar fixture idêntico mantém o alerta; falha de gravação conserva o conjunto anterior; sucesso deixa todos os derivados na mesma versão; nenhum link existente deixa de funcionar. Comparar CSV grande com suas séries reduzidas prova que o diagnóstico usa o bruto.

## Etapa 3 — Continuidade da viagem

### T09 — Uma política de reload que respeita persistência

**Cobertura:** A11, H02. **Arquivos:** `pwa-update.ts`, `ObdScannerContext.tsx`, `main.tsx`, testes de PWA/contexto.

- [ ] Centralizar a condição de recarregamento para atualização normal e erro de chunk.
- [ ] Incluir gravação ativa e commit local pendente. Uma cópia durável precisa existir antes de descartar o estado em memória.
- [ ] Preservar limite contra loop de reload e fornecer estado recuperável se a rota não puder carregar durante a viagem.
- [ ] Testar conexão em espera, reconexão, gravação, encerramento com IDB lento, offline e primeira visita sem controlador anterior.

**Aceite:** `vite:preloadError` com gravação ativa não chama reload; update pendente só é aplicado depois do ponto seguro definido. Cópia local permanece recuperável mesmo quando o upload de rede falha.

### T10 — Upload e recuperação idempotentes

**Cobertura:** H03, H05, H07. **Arquivos:** contexto OBD, `trip-store.ts`, ingestão, `db.ts`, migração de chave de idempotência se necessária.

- [ ] Reproduzir falha ao apagar o backup depois de um upload concluído. Se confirmada, corrigir antes de reprocessamento automático em massa.
- [ ] Vincular o upload a identificador estável da gravação/usuário; retry deve concluir/reconhecer a mesma sessão. Horário arredondado não deve ser a única prova de duplicidade.
- [ ] Não excluir preventivamente uma sessão completa apenas porque ainda há uma cópia local. Checar resultado de deleções locais e distinguir “bruto armazenado” de “pós-processamento concluído”.
- [ ] Ensaiar duas abas, sessão expirada, logout com upload pendente e retorno de outro usuário no mesmo aparelho.
- [ ] Ensaiar A → B → A por VIN e seleção manual, garantindo que a cópia sempre mantenha o carro/proprietário corretos.

**Aceite:** repetir upload não troca ID de viagem completa, não rompe links e não gasta IA novamente sem necessidade; falhas mantêm ao menos uma cópia íntegra; usuário B nunca recebe cópia de A. Hipótese não reproduzida fica encerrada como tal, sem refatoração especulativa.

## Etapa 4 — Chat, IA, integrações e interface

### T11 — Concorrência e contexto do chat

**Cobertura:** A08. **Arquivos:** `ChatContainer.tsx`, banco/tipos de chat e testes.

- [ ] Identificar envios/carregamentos por conversa e ignorar respostas de visualização obsoletas.
- [ ] Manter o contexto do carro da conversa ou iniciar explicitamente outra conversa ao trocar de carro.
- [ ] Tratar erro após salvar a pergunta: UI e histórico persistido precisam concordar, com retry sem duplicar mensagem.

**Aceite:** iniciar envio em A, abrir B e resolver a promise de A não altera mensagens de B; histórico lento de A não substitui B; criar conversa durante envio não recebe resposta anterior.

### T12 — Contrato único do relatório de IA

**Cobertura:** A14; depende de T07/T08 para consistência dos dados.

- [ ] Validar `summary`, `key_findings`, `recommended_action`, `warnings` e limites de tamanho no servidor; normalizar respostas antigas para um formato de UI explícito.
- [ ] Atualizar `AIAnalysisCard` e tipos dos consumidores, removendo o cast que mascara a incompatibilidade.
- [ ] Mostrar os achados e a ação recomendada atuais; resposta malformada não pode quebrar a página nem ser anunciada como análise concluída.
- [ ] Testar erro/timeout/429/503, resposta vazia e JSON parcial, preservando o contrato de reembolso de cota e os dados já salvos.

**Aceite:** fixture do formato atual exibe resumo, achados e recomendação; fixture legado continua legível; formato inválido é tratado sem crash. Não chamar provedor pago nos testes automatizados.

### T13 — Preservar o protocolo MCP/OAuth no proxy

**Cobertura:** A09; H04 como investigação separada.

- [ ] Encaminhar cabeçalhos relevantes de autenticação/protocolo, incluindo `WWW-Authenticate` na resposta, `MCP-Protocol-Version` quando usado e CORS correspondente.
- [ ] Testar o handler público junto da resposta upstream simulada; não testar só o helper interno de tokens.
- [ ] Ensaiar descoberta → registro → consentimento → PKCE → token → chamada → refresh → rejeição de token vencido/revogado. Definir como usuário revoga uma concessão OAuth, sem confundir concessão com token opaco da tela.
- [ ] Manter ferramentas de leitura e consultas limitadas ao usuário. Não aproveitar a correção para adicionar mutações.

**Aceite:** 401 público conserva desafio; OPTIONS aceita os cabeçalhos usados pelo cliente; fluxo completo passa com cliente de teste em ambiente isolado. Erros não devolvem dados de outro usuário.

### T14 — Fotos e mensagens coerentes

**Cobertura:** A12, A15; H05/H06 quando confirmados.

- [ ] Assinar e exibir a foto logo após envio; carregar por efeito com proteção contra resposta obsoleta, não durante render.
- [ ] Não remover metadados da UI como sucesso se banco/Storage falharem; tratar órfãos sem excluir arquivos fora do usuário.
- [ ] Retirar a promessa de que a IA analisa fotos enquanto esse caminho não existe. Atualizar EN/PT-BR/ES-ES.
- [ ] Testar URL assinada expirada, troca de foto, remoção, HEIC não renderizável e tela aberta por longo período.

**Aceite:** nova foto aparece sem recarregar; erro de remoção é visível; produto descreve a capacidade atual. Adicionar visão por IA continua fora de escopo.

### T15 — Fuso, datas e revisão visual direcionada

**Cobertura:** A13; ajuste de rodapé já concluído.

- [ ] Passar o fuso escolhido aos formatadores de instantes, inclusive nome automático da viagem, chat, histórico e compartilhamento quando esse contexto existir.
- [ ] Manter datas civis de manutenção sem deslocamento de dia; não converter `YYYY-MM-DD` indevidamente para UTC.
- [ ] Conferir 360/390 px, tablet e desktop: navegação inferior, texto longo traduzido, foco dos diálogos, botão de chat, aviso de erro e rodapé.
- [ ] Conferir o rodapé compacto no desktop; preservar espaço de navegação necessário no celular.

**Aceite:** trocar New York por Tokyo muda horários/parte do dia da mesma viagem, mas não muda a data civil de uma manutenção. Sem sobreposição horizontal ou controles inacessíveis nos tamanhos ensaiados.

## Etapa 5 — Gates e operação

### T16 — CI cobre o que é entregue

**Arquivos:** `package.json`, tsconfigs, `eslint.config.js`, workflows, testes da API e funções Deno.

- [ ] Corrigir os oito erros de lint existentes no escopo de seus arquivos; não desabilitar regras globalmente para esconder falhas.
- [ ] Tornar typecheck bloqueante após passar; alinhar lint local e CI ou documentar scripts separados com escopos intencionais.
- [ ] Adicionar validação de handlers `api/` e funções Deno com runtime/checagens apropriados. Não fingir que `tsconfig.app` valida o backend.
- [ ] Incluir testes contratuais das consultas, migrações/RLS e cenários prioritários desta revisão.
- [ ] Fazer publicação Android depender das verificações da mesma revisão; confirmar política real de publicação web e proteções de branch antes de alterar configuração externa.
- [ ] Resolver H08 com evidência: o workflow atual não faz o commit de heartbeat descrito no README. Confirmar necessidade operacional sem presumir visibilidade/configuração do repositório.

**Aceite:** um erro proposital em contrato prioritário reprova o job pertinente; artefatos publicados correspondem à revisão validada. Sem depender de `continue-on-error` no typecheck.

### T17 — Documentação e operação atuais

- [ ] Atualizar README: OpenRouter/configuração administrativa, scanner/BLE, APK live/offline, portas atuais, variáveis mínimas e comandos de teste.
- [ ] Documentar recuperação de viagens, evolução de esquema, compatibilidade de versões e limite real de cada ferramenta.
- [ ] Criar runbook de teste/staging/deploy com migração antes do código dependente e rollback não destrutivo.
- [ ] Registrar estado real das investigações H01–H08 e quais resultados dependem de produção/hardware. Documentos históricos continuam históricos.

**Aceite:** uma instalação limpa e uma retomada de ambiente existente podem seguir o runbook sem conhecimento de contas ou correções manuais não documentadas.

## Etapa 6 — Homologação e saída

### T18 — Validar os fluxos completos

| Cenário | Ambiente | Evidência necessária |
|---|---|---|
| Banco limpo e upgrade com dados | Supabase/PostgreSQL isolado | Log de migrações, contagens/IDs antes/depois e resultado RLS A/B/admin/anon |
| CSV → sessão → diagnóstico → histórico → reavaliação → relatório | Navegador + banco isolado | Dados persistidos e telas concordam; mesmo ID após reavaliar |
| CSV equivalente em segundos/timestamp e °C/°F | Testes de contrato + banco | Flags/duração equivalentes; bruto preservado |
| Sem internet durante upload e retorno | Navegador + IDB real | Cópia permanece e resulta em uma sessão após retry |
| Atualização pendente durante viagem | Duas versões locais/staging da PWA | Nenhum reload antes de ponto seguro; viagem íntegra após retomar |
| Gravar, apagar tela, ligar/desligar carro e reconectar | APK Android + adaptador físico | Linha temporal contínua/explicada, bateria/serviço, descarte apenas de viagens curtas previsto |
| Compartilhar e revogar | Banco isolado + sessão anon | Só payload permitido; link revogado/expirado deixa de responder |
| Chat A/B e troca de carro com respostas lentas | Navegador e mocks controlados | Nenhuma mensagem/contexto cruzado |
| OAuth/MCP | Cliente compatível + staging | Descoberta e ciclo de token documentados; dados de A inacessíveis a B |
| Fotos/fuso/mobile | Navegador em tamanhos definidos | Preview imediato, horários corretos, sem conteúdo oculto |

**Condição de saída:** correções dos achados confirmados cobertas por testes de comportamento; checks locais/CI verdes; investigações encerradas com evidência ou explicitamente mantidas como pendência de homologação. Se faltar aparelho ou ambiente SQL, não chamar a entrega de totalmente homologada.

## Implantação e rollback quando a execução chegar a essa etapa

1. Registrar revisão, backup e baseline antes/depois. Aplicar migração aditiva compatível no ambiente isolado e verificar.
2. Validar a versão candidata sem publicar automaticamente; depois aplicar o mesmo procedimento no destino autorizado.
3. Publicar código somente após o esquema necessário existir. Observar erros de ingestão, backup pendente, reprocessamento e autenticação.
4. Reprocessamento de viagens históricas começa por amostra pequena e identificável; não consumir toda a cota de IA nem sobrescrever análises em massa sem estratégia.
5. Rollback de aplicativo mantém colunas aditivas e dados íntegros; não derrubar tabelas/colunas para voltar um bundle. Interromper novas reavaliações se houver inconsistência e preservar os CSVs para recuperação.

Publicação, mudança de configuração externa e migração remota não foram executadas durante a avaliação.

## Próximo passo concreto

Seguir o [RUNBOOK](RUNBOOK.md): repetir a homologação no Supabase de staging antes de publicar o cliente dependente das duas RPCs. O replay/rollback e a idempotência passaram localmente; conflitos legados permanecem preservados para decisão. Não reprocessar em massa. As decisões e demais pendências estão em [EXECUCAO.md](EXECUCAO.md).
