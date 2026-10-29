# Avaliação técnica do Xpeed

Data: 29/10/2026. Referência: commit `61340cde3514af1bb1b6102bfaeca7d97e65d95a`.

Esta avaliação registra o **baseline anterior às correções** e foi produzida diretamente a partir do código. Os documentos históricos de planejamento não foram usados como prova de implementação. Após concluir o [plano](PLANO-DE-EXECUCAO.md), o usuário autorizou sua execução conservadora: consulte o [registro atual de execução](EXECUCAO.md) para saber o que foi corrigido, preparado ou deixado pendente. As descrições e referências de linha abaixo pertencem ao código avaliado inicialmente. O rodapé solicitado foi compactado de 80 para 16 px no desktop e conferido no navegador.

## Conclusão

A aplicação tem uma base funcional: separação entre cliente e funções de IA, rotas protegidas, gravação com cópias locais, regras por veículo, relatórios compartilhados e testes relevantes. A prioridade é tornar confiável a cadeia **leitura → tempo/unidade → diagnóstico → persistência → apresentação**. Hoje ela pode tanto omitir alertas quanto produzir alertas falsos. Reescrever o aplicativo ou adicionar funcionalidades não resolve esses contratos.

O plano prioriza diagnóstico e dados; depois gravação/atualizações, contratos da IA e integrações; por último acabamento e documentação. Não há proposta de trocar hospedagem, domínio ou provedor de IA neste trabalho.

## Evidência e limites

| Área | Avaliação realizada | Limite da evidência |
|---|---|---|
| Frontend e rotas | Código; navegação local por Home, Trips, SessionDetail e Settings | Harness com dados sintéticos, sem autenticação externa real |
| CSV e diagnósticos | Parser, mapeamento, regras, relatórios; reproduções executadas | Não valida limites mecânicos de todos os modelos de carro |
| Banco e armazenamento | Helpers, consultas, migrações, RLS e relações | Banco remoto não foi consultado; Docker sem daemon disponível; sem replay SQL executado |
| Scanner e viagens | Código BLE/ELM327, detecção, backup, upload; suíte com adaptadores simulados | Sem adaptador OBD físico e sem ensaio Android com tela apagada |
| IA e chat | Cliente, contratos, prompts, cotas e funções | Sem chamadas pagas, sem usar chave de produção |
| MCP e OAuth | Autenticação, escopo das consultas, proxy, PKCE e rotação; reprodução do proxy | Sem autorização de um conector externo real |
| PWA e Android | Atualizações, manifesto, serviço e workflows; reprodução do reload | Sem instalar APK nem testar duas versões de service worker em produção |
| Qualidade e dependências | Testes, TypeScript, build, lint, auditoria npm | Passar testes com mocks não homologa banco, hardware ou serviço externo |

Baseline executada antes da alteração visual, no mesmo commit:

- `npm test`, com `VITE_SUPABASE_URL=https://example.supabase.co` e chave fictícia: **30 arquivos, 264 testes passaram**.
- `npx tsc -p tsconfig.app.json --noEmit`: passou.
- `npm run build`, com as mesmas variáveis fictícias: passou; precache de aproximadamente 1,75 MiB. Isso valida compilação, não conectividade com produção.
- `npm run lint`: **8 erros e 14 avisos**, incluindo API, scripts e configuração Tailwind.
- `npm audit --omit=dev --audit-level=high --json`: nenhuma vulnerabilidade reportada no conjunto de produção consultado. Isso não demonstra ausência de vulnerabilidades na aplicação.
- A primeira execução usou `node_modules` desatualizado. Após `npm ci --ignore-scripts --no-audit --no-fund`, os resultados acima foram obtidos com o lockfile atual.

As reproduções podem ser repetidas com:

```powershell
node docs/revisao-2026-10-29/reproducoes.mjs
```

O [JSON original](evidencias.json) preserva oito verificações anteriores às correções: sete reproduções com código executado e uma comparação estática. `reproduced: true` significa **defeito observado**. O script foi adaptado para os módulos atuais; `--save` grava [evidências atuais](evidencias-atuais.json) separadamente, sem sobrescrever o baseline. Algumas verificações são estáticas; os testes permanentes e os limites em EXECUCAO.md são a evidência de aceite local.

## Achados confirmados

Os IDs A01–A10 correspondem aos dez pontos apresentados na primeira revisão. Alta = corrigir antes de confiar em uma nova entrega do fluxo afetado. Média = corrigir na sequência. Evidência estática é distinguida de reprodução executada.

### A01 — Alta — Reavaliar pode remover um alerta crítico

- Fonte: `src/pages/SessionDetail.tsx:80`, `src/lib/insight-engine.ts:193`, `src/hooks/use-csv-upload.ts`.
- A reavaliação monta `rows` apenas com `r.data`, sem `t_seconds`/`t_timestamp`. O motor passa a assumir um segundo por amostra. Além disso, as linhas persistidas foram reduzidas para gráficos e não representam o CSV completo.
- Reprodução: quatro amostras críticas em 0/5/10/15 s produzem um alerta no processamento original e zero depois de descartar o tempo.
- Consequência: o botão substitui os alertas corretos por um resultado diferente, enquanto relatório, versão e problemas persistentes continuam no estado anterior.
- Direção: reprocessar os dados brutos; atualizar derivados consistentemente; nunca recalcular diagnósticos a partir da série reduzida de gráficos.

### A02 — Alta — Unidades externas não são convertidas

- Fonte: `src/lib/canonical-params.ts:12`, `src/lib/csv-parser.ts`, `src/lib/trips.ts:25`.
- O mapeamento atribui unidades canônicas, mas os números continuam nas unidades do CSV.
- Reprodução: 194 °F vira 194 °C e gera alerta crítico; 60 mph vira 60 km/h.
- Direção: preservar unidade de origem, normalizar antes dos cálculos e não avaliar com limiares métricos um parâmetro cuja unidade não foi reconhecida.

### A03 — Alta — Erros de leitura viram resultados vazios

- Fonte: `src/lib/db.ts:52`, `:76` e `:94`; consumidores `Index`, `HistoryPage`, `SessionDetail`.
- `getSessions`, `getSession` e `getSessionFlags` descartam `error`. A proteção `try/catch` nas páginas não recebe a falha retornada pelo Supabase.
- Reprodução: uma resposta com erro retorna `[]`/`null`. A falha na leitura dos flags pode virar “nada errado foi encontrado”.
- Direção: distinguir ausência, erro, resultado parcial e último resultado válido. Aplicar a mesma semântica às leituras auxiliares relevantes.

### A04 — Alta — Upgrade do esquema de problemas fica incompleto

- Fonte: `supabase/migrations/20261028000000_vehicle_issues_rebuild.sql:12`; esquema anterior em `20260528000003_vehicle_issues.sql`.
- A detecção de “esquema novo” usa `first_session_id`, já presente no esquema anterior. O bloco retorna, o `CREATE TABLE IF NOT EXISTS` não altera a tabela e faltam `details` e `updated_at`. Um trigger posterior usa `updated_at`.
- Evidência: comparação estática, registrada no JSON. Não foi executada no banco remoto.
- Direção: nova migração incremental não destrutiva, cobrindo as duas formas conhecidas de tabela, colunas, triggers e políticas legadas. Validar com linhas existentes, não apenas tabelas vazias.

### A05 — Alta — Timestamps não governam a duração do diagnóstico

- Fonte: `src/lib/insight-engine.ts:193`, `src/hooks/use-csv-upload.ts:69`.
- O intervalo só é estimado para colunas numéricas em segundos; para timestamps vira um segundo. O upload também só calcula `durationSeconds` no caso numérico.
- Reprodução: 120 °C em timestamps separados por 10 s, durante 20 s, não gera o alerta esperado. Distância/duração e seleção de viagens para IA também são afetadas.
- Direção: um eixo de tempo canônico compartilhado pelo parser, motor, relatório e UI. Intervalos irregulares e lacunas precisam de regra explícita; contar linhas não equivale a duração.

### A06 — Média — Histórico não recebe os DTCs que apresenta

- Fonte: `src/lib/db.ts:4`, `src/pages/HistoryPage.tsx:160`.
- `SESSION_LIST_SELECT` omite `active_dtcs`; a página usa esse campo ao calcular problemas.
- Evidência: captura da projeção real pela reprodução. O teste de tela fornece o campo pelo mock e não expõe o defeito.
- Direção: contrato mínimo de listagem incluindo DTCs; teste da consulta e da tela juntos.

### A07 — Média — Histórico SQL depende de estado manual anterior

- Fonte: `supabase/migrations/20260528100000_security_hardening.sql:21`.
- Há `REVOKE ... exec_sql(text)` antes da primeira criação dessa função no histórico versionado. Em instalação limpa, a função pode não existir e o replay falha. Seeds de contas específicas também precisam ser examinados no replay.
- Evidência: inspeção estática da ordem dos arquivos; o replay local continua pendente.
- Direção: tornar o bootstrap reproduzível sem presumir usuários de produção nem funções criadas manualmente. Não resetar o banco remoto para testar isso.

### A08 — Média — Chat mistura respostas entre conversas

- Fonte: `src/components/chat/ChatContainer.tsx:146` e `:189`.
- A resposta é salva na conversa capturada pelo envio, mas é acrescentada à lista que estiver aberta quando terminar. Trocar conversa continua permitido durante a espera. O carregamento de mensagens também não cancela respostas antigas.
- Evidência: fluxo estático; acrescentar teste com promises controladas na execução.
- Direção: escopar mensagens e requisições por conversa; ignorar resultado obsoleto na visualização; fixar o contexto do carro da conversa, em vez de misturar o histórico com o carro selecionado posteriormente.

### A09 — Média — Proxy MCP perde o desafio OAuth

- Fonte: `api/mcp.ts:46`, `supabase/functions/xpeed-mcp/index.ts`.
- O upstream envia `WWW-Authenticate` em 401, mas o proxy cria a resposta com apenas Content-Type/CORS.
- Reprodução: 401 chega sem o cabeçalho. Clientes que dependem desse desafio perdem o caminho de descoberta automática.
- Direção: preservar cabeçalhos de autenticação/protocolo necessários e expor `WWW-Authenticate` em CORS; validar OPTIONS e cliente real.
- Referência: [SDK oficial MCP, autorização](https://py.sdk.modelcontextprotocol.io/run/authorization/).

### A10 — Média — Histórico pagina a interface, mas não o banco

- Fonte: `src/lib/db.ts:52`, `src/pages/HistoryPage.tsx`.
- A consulta inicial não busca páginas nem informa truncamento. Os botões só paginam o array recebido. Acima do limite configurado no PostgREST, viagens antigas e totais deixam de estar completos.
- Evidência: consulta e consumidores inspecionados. O limite efetivo remoto não foi consultado.
- Direção: paginação determinística no banco e agregados independentes do subconjunto visível. Não carregar todo o histórico por padrão para calcular totais.

### A11 — Alta — Recuperação de chunk pode recarregar durante gravação

- Fonte: `src/lib/pwa-update.ts`, função `installPreloadErrorReload`.
- O caminho normal de atualização verifica gravação. O tratamento de `vite:preloadError` não verifica e chama `window.location.reload()`.
- Reprodução: com `__xpeedRecording=true`, um evento de preload causou um reload. Isso interrompe BLE/estado em memória e pode perder leituras posteriores ao último backup.
- Direção: unificar a decisão de recarregar, incluindo persistência pendente. Adiar o reload e oferecer recuperação sem interromper a viagem.

### A12 — Média — Foto recém-enviada não recebe URL de exibição

- Fonte: `src/components/PhotoUpload.tsx:79`, `:157`.
- O upload adiciona a foto ao array, mas não adiciona sua URL a `photoUrls`. URLs são resolvidas apenas na carga inicial. A imagem nova pode ficar sem preview até remontar a página.
- Evidência: fluxo estático. Testar upload com assinatura de URL simulada e depois com bucket isolado.
- Direção: obter a URL ao concluir upload, controlar carga por efeito e tratar erros de remoção/armazenamento sem anunciar sucesso falso.

### A13 — Média — Preferência de fuso horário não é aplicada

- Fonte: `src/contexts/SettingsContext.tsx`, `src/pages/SettingsPage.tsx:120`, `src/lib/trips.ts:56`.
- O fuso é salvo, mas os formatadores usam somente idioma e fuso do aparelho. Pesquisa nos arquivos de produto não encontrou consumo da preferência nas datas.
- Direção: aplicar o fuso selecionado a instantes de viagens, mantendo datas civis de manutenção sem deslocamento. O nome “viagem da manhã/noite” precisa seguir a mesma regra.

### A14 — Média — Relatório da IA perde achados e recomendação

- Fonte: `src/lib/ai-client.ts`, `supabase/functions/analyze-session/index.ts`, `src/components/AIAnalysisCard.tsx`.
- O servidor retorna `summary`, `key_findings`, `recommended_action`, `warnings`; o cartão ainda espera `insights` e `recommendations`. O cast `as never` no consumidor oculta a incompatibilidade.
- Consequência: campos válidos do relatório atual não são mostrados no cartão técnico. O servidor valida warnings, mas não valida integralmente o restante da resposta.
- Direção: contrato compartilhado/normalizado, compatibilidade com análises antigas e validação de todos os campos antes de persistir/renderizar. Testar a resposta atual, não um formato antigo inventado pelo mock.

### A15 — Média — Interface promete análise de fotos que o chat não faz

- Fonte: `src/components/PhotoUpload.tsx:151`, `supabase/functions/chat/index.ts`, `supabase/functions/_shared/car-data.ts`.
- A interface afirma que o assistente olhará a foto; o contexto e a chamada atual são textuais e não leem `session_photos` nem enviam imagens ao provedor.
- Evidência: mensagem visível no harness e caminho do servidor inspecionado.
- Direção: corrigir a mensagem para explicar o armazenamento atual. Suporte multimodal é uma funcionalidade futura e não deve ser introduzido implicitamente nesta estabilização.

## Lacunas de garantia e investigações pendentes

Estes itens não devem ser promovidos automaticamente a bugs de produção.

| ID | Questão | Evidência atual | Como encerrar |
|---|---|---|---|
| H01 | Gravação Android com tela apagada e retorno do app | Serviço foreground/wake lock revisado; sem aparelho | Ensaio físico com timestamps, desconexão, bateria e recuperação |
| H02 | Reload entre fim da viagem e commit do backup | `setTripRecording(driving)` não inclui persistência inicial; corrida possível | Teste com IDB atrasado e service worker pendente |
| H03 | Retry pode substituir viagem completa se backup não foi apagado | `deleteTripCopy` devolve boolean, retorno não é verificado; upload remove sessão anterior pelo horário | Injetar falha de deleção local após upload; conferir IDs, links e derivados |
| H04 | Revogação de concessão OAuth pelo usuário | UI de tokens opacos existe; gestão de concessões OAuth não localizada | Verificar produto esperado e ciclo completo de refresh/revogação em ambiente isolado |
| H05 | Armazenamento órfão após remoção de carro/viagem | Cascata SQL remove metadados; limpeza remota de todos os buckets não comprovada | Inventariar jobs/triggers existentes e testar retenção em bucket isolado |
| H06 | Manifesto dinâmico sem brand_config e share_target `/import` | Fallback usa favicon pequeno; rota `/import` não localizada no App | Testar manifesto servido sem configuração e fluxo de share target antes de definir correção |
| H07 | IDs/VIN e seleção de carro durante reconexão | VIN tratado por ref; seleção pode mudar com link ativo | Ensaiar carro A → B → A e mudança manual; comprovar propriedade de cada viagem |
| H08 | Keepalive e publicação automática | README descreve commit de heartbeat que não está no workflow atual; release Android independente da suíte | Confirmar visibilidade/configuração do repositório e proteção de entregas; definir integração de gates |

## O que os testes atuais não garantem

O harness em `src/harness/fake-supabase.ts` ignora a lista de colunas de `select`, trata `range(from,to)` sem respeitar `from` e substitui a ordenação anterior a cada `order`. Não executa RLS/FKs, limites reais do PostgREST ou transações SQL. Assim, pode mostrar DTCs que a consulta real omite, repetir páginas e ordenar gráficos de forma diferente do banco. É útil para navegação e estados visuais; não é evidência de integração.

Também há uma diferença entre `npm run lint` (repositório) e CI (`eslint src`), e o typecheck do CI está não bloqueante. As Edge Functions Deno e os handlers de API não são cobertos integralmente pelos tsconfigs atuais. O plano inclui corrigir essas fronteiras sem tratar avisos de estilo como os principais problemas do produto.

## Mudanças na etapa inicial, antes da execução autorizada

- Documentos e reproduções nesta pasta.
- Ajuste visual do rodapé solicitado pelo usuário, sem alterar regras, dados ou APIs.
- Dependências locais alinhadas ao lockfile para verificação; nenhuma alteração em package.json/lockfile.
- Sem commit, push, deploy, migração remota ou nova automação.

O arquivo preexistente `.github/keepalive-heartbeat`, não rastreado no início, foi preservado.
