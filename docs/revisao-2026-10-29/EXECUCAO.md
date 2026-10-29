# Execução atual da revisão do Xpeed

Atualização de publicação (29/10/2026): após autorização explícita do usuário, a migração `20261029110000` foi aplicada no Supabase de produção e as funções `analyze-session`, `chat` e `xpeed-mcp` foram publicadas. O ensaio hospedado com rollback identificou `processing_version` inteiro; a migração agora converte para texto preservando valores/default/nullability, com regressão SQL e tipos alinhados. Contagens e IDs das viagens existentes foram conferidos antes/depois sem alteração. A publicação da aplicação e os checks do commit são acompanhados nesta conversa; as seções abaixo preservam a evidência da revisão anterior à publicação.

Data: 29/10/2026. Base: `61340cde3514af1bb1b6102bfaeca7d97e65d95a`. Execução local conservadora autorizada pelo usuário, sem GSD. O relatório anterior foi preservado em [EXECUCAO-INICIAL.md](EXECUCAO-INICIAL.md).

## Resultado final local

| Verificação | Resultado |
|---|---|
| Aplicação: `npm test` | **303 testes passaram, 40 arquivos** |
| Tipos frontend/API: `npm run typecheck` | Passou |
| Deno: `npm run check:edge` | Todos os 27 arquivos verificados; **3 testes passaram** |
| PostgreSQL: `npm run test:sql` | **7 verificações de upgrade/processamento + 5 grupos de acesso após replay** |
| Histórico de migrações | **55 arquivos aplicados em PostgreSQL embarcado, sem erro** |
| Lint | **0 erros, 11 avisos de Fast Refresh**; baseline: 8 erros/14 avisos |
| Build de produção | Passou; PWA com 71 entradas, 1805,96 KiB de precache |
| Whitespace | `git diff --check` passou; só avisos de normalização LF/CRLF |

Aplicação compilada/testada com URL e chave públicas fictícias. Runtime local: Node 24.13.0, Deno 2.9.6 e PGlite 0.5.13. CI usa Node 22; nenhum workflow remoto foi disparado. Não foram usados dados/chaves de produção nem chamadas pagas.

## O que foi executado

| Área | Mudança e evidência |
|---|---|
| CSV e diagnóstico | Conversão explícita °F/K, mph/m/s, psi e mV antes das regras; long-format preserva UNITS. Segundos/timestamps usam tempo decorrido; null interrompe sequência; tempo invertido falha. CSV original continua preservado. |
| Leituras e histórico | Erros de consulta são propagados e apresentados com retry; listagem traz DTCs; sessões usam cursor e flags usam lotes/páginas para ultrapassar limites sem tratar falha como carro saudável. |
| Reavaliação | Lê o CSV bruto, calcula todos os derivados e publica por transação. Teste SQL induz erro após update/delete e comprova rollback. Preserva ID, resolved e recibo da gravação. Análise paga anterior é mantida e marcada desatualizada. |
| Gravação e recuperação | Nova identidade UUIDv8 derivada de proprietário/carro/início em milissegundos; checksum do CSV; recibo de conclusão no banco. `store_recorded_session` serializa a identidade e grava original/metadados/linhas/flags/relatório numa transação. Retry reconhece o mesmo commit e não refaz IA. Não há mais exclusão preventiva da sessão encontrada por horário. |
| Cópias antigas ambíguas | Se a viagem antiga não tem recibo confiável ou o CSV difere, as duas cópias ficam preservadas e o app avisa para conferência. Não tenta adivinhar se deve substituir uma viagem completa. |
| PWA | Reload respeita gravação e persistência, inclusive ativação tardia do worker. Erro de página protegida preserva providers do scanner. Manifesto sem branding usa ícones instaláveis; removido share target POST `/import`, sem implementação de recepção. |
| Chat/IA | Resposta/histórico atrasados ficam na conversa correta; contexto acompanha carro da conversa. UI aceita análise atual/legada. Parser de resposta do servidor tem testes Deno de formato, JSON inválido e limites. Pergunta já persistida não desaparece após falha da resposta. |
| MCP/OAuth | Proxy preserva desafio de autenticação e versão de protocolo/CORS. Checagem Deno de todo backend revelou e permitiu corrigir cinco erros de tipos, mantendo o endpoint legado aposentado. Não foram adicionadas ferramentas de escrita. |
| Fotos | Preview após envio; URLs renovadas antes de expirar; uploads de A não entram na tela de B; falha de listagem tem retry. Formatos aceitos: JPG/PNG/WebP. Textos não prometem análise de imagem. |
| Interface/fuso | Formatadores principais usam o fuso escolhido, inclusive nome da gravação; datas civis de manutenção preservadas. Rodapé desktop compactado de 80 para 16 px. |
| Qualidade e CI | Tipos, lint, testes, Deno e verificações SQL incluídos nos workflows web/APK. Duas dependências de hooks corrigidas sem suprimir regras. Harness respeita projeção/range/ordem e rejeita RPC não implementada. |

## Banco: evidência e alterações

O Docker está instalado, mas o daemon não estava acessível. Usei PostgreSQL real compilado para WASM, via PGlite, em memória e sem rede de negócio. O bootstrap inclui tabelas/funções sintéticas de compatibilidade para `auth` e `storage`; não executa os serviços hospedados do Supabase.

Evidência salva:

- [processing-sql.json](processing-sql.json): upgrade aditivo repetido, identidade, flags resolvidos, rollback, publicação única e negação a outro usuário/admin/anon.
- [bootstrap-sql.json](bootstrap-sql.json): lista das 55 migrações aplicadas e cinco grupos executados com as políticas migradas.
- [evidencias.json](evidencias.json): baseline anterior às correções, preservado.
- [evidencias-atuais.json](evidencias-atuais.json): reproduções locais posteriores; não substitui integração.

A matriz migrada comprova que B não lista viagens/linhas/flags/problemas/chat/manutenção/fotos de A nem seus objetos no bucket de CSV. Inserts com relações de outro proprietário falham. Admin de suporte mantém leitura, mas não altera viagem alheia via RPC nem reescreve o carro de A. Anon não lista viagens/links privados; um link explícito funciona e deixa de funcionar após revogação.

O replay reproduziu problemas de ordem no histórico. Foram feitos ajustes mínimos para novos ambientes:

1. Criar `sessions.user_id` antes de usá-lo no backfill de carros.
2. Criar `app_settings.user_id` antes das policies que o referenciam.
3. Não inserir o carro demo global sem proprietário, que impedia o NOT NULL posterior.
4. Pular seeds/reparos de contas específicas quando a conta não existe, sem criar usuário ou conceder acesso novo.
5. Criar `exec_sql` antes do REVOKE e remover o grant público imediatamente. A migração posterior continua removendo a função.

**Esses arquivos históricos não devem ser reaplicados no banco existente.** O upgrade existente usa a nova migração aditiva; não houve reset, squash ou manipulação da tabela remota de migrations.

A nova migração `20261029110000_stabilize_processing.sql` acrescenta colunas faltantes de problemas, remove duas policies permissivas antigas e cria `reprocess_session`/`store_recorded_session` com `SECURITY INVOKER`, verificação de proprietário e grants restritos. Foi executada nos testes locais, não no banco hospedado.

## O que conferir pela manhã

1. Revisar o diff e a interface. Chrome/harness sintético: Home → Settings → Trips → detalhe carregaram; seção de fotos terminou de carregar com botão habilitado; nenhum erro de console observado. Sem acesso externo de negócio.
2. **Antes de publicar este cliente, validar/aplicar a migração nova no destino correto.** Reavaliação e gravação nova dependem das duas RPCs. Sem elas, a gravação mantém sua cópia local e o salvamento remoto falha com aviso; não usar um deploy do frontend como teste de migração.
3. Conferir cópias legadas em conflito antes de decidir como adotá-las. Não apagar backups nem substituir viagens antigas em massa. O novo caminho evita a substituição automática, mas não tenta reconciliar automaticamente o legado ambíguo.
4. Fazer homologação Supabase/Storage/Auth/OAuth reais e Android físico pelo [RUNBOOK](RUNBOOK.md). O PostgreSQL embarcado não reproduz gateway, URLs assinadas reais, conexões simultâneas, processo Android ou BLE.

## Dúvidas preservadas para decisão

- Política para CSV sem tempo, unidade ausente/ambígua e grandes saltos entre leituras. Não inventei duração de amostragem nem alterei limiares mecânicos.
- Regeneração paga da IA após reprocessamento e tratamento de ocorrências históricas que deixaram de se justificar. Não houve cobrança, limpeza ou reprocessamento em massa.
- Gestão de concessões OAuth, retenção/limpeza de arquivos órfãos e necessidade de commits de heartbeat. Sem alterar permissões ou configurações externas.
- VIN A → B → A, troca manual de carro conectado, tela apagada e recuperação após processo Android encerrado: precisam de ensaio físico/controlado.
- Integração com duas versões reais de service worker e IndexedDB lento. Guardas e testes locais existem; ensaio completo ainda pendente.

## Estado dos arquivos e ambiente

Sem commit, push, PR, deploy, migração remota ou automação criada. Alterações disponíveis no working tree. `package-lock.json` e o arquivo preexistente `.github/keepalive-heartbeat` foram preservados. PGlite/Deno foram baixados apenas como ferramentas de teste dentro de `node_modules`, sem instalação global ou dependência nova de produção. O servidor do smoke local foi encerrado após a verificação.

Instalação/comandos de repetição estão no README. Os workflows foram preparados, mas só executarão remotamente quando a revisão for enviada pelo fluxo escolhido. A etapa local conservadora está verificada; os itens acima continuam explicitamente fora da homologação concluída.
