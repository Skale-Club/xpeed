# Homologação e implantação pendentes

O replay e a matriz SQL foram executados em PostgreSQL embarcado com dados sintéticos; o restante deste runbook continua pendente em Supabase hospedado/aparelho. Não contém credenciais e não autoriza reset remoto. A implementação e os limites estão em [EXECUCAO.md](EXECUCAO.md).

## Verificação local já executada

`npm run test:sql` passa sete verificações de processamento/upgrade e cinco grupos após o replay das 55 migrações. Usa PGlite 0.5.13 em memória, com funções/tabelas de compatibilidade para Auth/Storage. Os testes usam as políticas migradas, mas não executam o gateway Supabase, servidor de Storage, OAuth externo ou conexões simultâneas reais. `npm run check:edge` verifica os arquivos Deno e executa três testes de resposta da IA. Ver comandos no README.

Os ajustes históricos são apenas para novos replays: ordem de criação de colunas/função, ausência da seed demo sem proprietário e guards de seeds de contas específicas. Não reaplicar arquivos já registrados nem alterar manualmente a história do banco remoto.

## 1. Preparar ambiente descartável

1. Disponibilizar Docker/Supabase local ou staging separado e confirmar URL/projeto de destino antes de qualquer comando de migração. Nenhum comando deve depender da `.env` de produção por conveniência.
2. Registrar versão do PostgreSQL/Supabase CLI, revisão Git e migrações existentes. Fazer backup do destino de upgrade e inventariar contagens/IDs de sessões, flags, problemas e ocorrências.
3. Separar dois ensaios: bootstrap do histórico completo num banco vazio e upgrade de uma cópia sintética do esquema anterior com linhas existentes. A forma antiga já tem `first_session_id`, mas pode não ter `details`/`updated_at`.
4. No bootstrap, registrar o primeiro erro real. Investigar REVOKE anterior à criação de `exec_sql` e seeds que pressupõem UUIDs existentes. Preparar guards mínimos só após reproduzir; não reaplicar arquivos históricos num banco vivo.

## 2. Validar a migração nova

Arquivo: `supabase/migrations/20261029110000_stabilize_processing.sql`. Contém tanto `reprocess_session` quanto `store_recorded_session`; **as duas funções precisam existir antes de publicar este cliente**, pois a gravação do scanner usa a segunda.

- Confirmar `details` e `updated_at`, trigger de atualização existente, políticas finais e grants da RPC. Conferir que não sobra policy permissiva antiga que se some à política atual.
- Comparar contagens/IDs e relações antes/depois. Nenhuma viagem ou ocorrência existente deve desaparecer.
- Reexecutar o arquivo no banco descartável para conferir a intenção aditiva/idempotente. Regenerar tipos a partir do esquema **validado**, não inventar a assinatura tipada de tabelas ausentes.
- Executar como usuário autenticado A: reavaliar viagem própria e verificar ID/link, rows, flags, summary, report, versões e DTCs. Conferir preservação de `resolved` e decisões de problema.
- Repetir com payload inválido e falha de insert induzida dentro da transação. O conjunto anterior deve permanecer integralmente disponível após rollback.
- Usuário B não pode reavaliar A; anon deve ser negado. Admin com permissão de leitura de suporte também não deve reavaliar viagem alheia.
- Conferir limites/tipos do payload e resultado com CSV grande, timestamp e unidades equivalentes. O diagnóstico deve usar bruto; rows de gráfico podem ser reduzidas.

## 3. Matriz de acesso real

Usar clientes/sessões A, B, admin e anon, sem service role para mascarar negações. Testar leitura/escrita e vínculos cruzados em carros, sessões/rows/flags, problemas/ocorrências, chat, manutenção, fotos/Storage, relatórios compartilhados e tokens. Conferir que a lista pessoal do admin mostra apenas seus carros e que caminhos de suporte conservam só o acesso previsto. Testar URLs assinadas, expiração e revogação de compartilhamento.

## 4. Runtime e fluxos

1. Rodar os checks do README e validar as funções Deno com o runtime/import map do projeto; frontend/API não cobrem Deno. Simular IA inválida, vazia, 429/503/502 e reembolso de quota antes de uma chamada paga controlada.
2. Fazer upload → histórico → detalhe → reavaliar → compartilhar. Comparar dados persistidos com a UI, preservando CSV original e identidade da viagem.
3. Injetar falhas de Storage/DB/IndexedDB e interrupção de rede. Resolver H03 antes de retries em massa: sucesso remoto com falha de remoção local não pode excluir sessão completa, alterar ID, quebrar links ou gastar IA novamente.
4. Instalar duas versões locais/staging da PWA; ativar atualização durante gravação e durante commit local lento. Nenhum reload pode acontecer sem ponto seguro. Repetir primeira visita sem SW controlador.
5. Ensaiar chat A/B com respostas lentas, criação de conversa durante envio, troca de carro e falha depois de salvar a pergunta.
6. Cliente MCP externo: descoberta → registro → consentimento → PKCE → chamada → refresh → expiração/revogação, com desafio e CORS preservados. Confirmar comportamento quando a conversa antiga não tem carro.
7. Android físico: gravar com tela apagada, perder sinal, reconectar e trocar carro A → B → A. Conferir timestamps, proprietário/carro dos backups, bateria, serviço foreground e recuperação após interrupção.

## 5. Publicar somente após homologação

1. Registrar aprovação/revisão candidata e backup. Confirmar política real de branch protection/deploy web e checks do APK; não presumir que um CI separado bloqueia publicação externa.
2. Aplicar primeiro a migração aditiva validada, conferir grants/RLS; depois publicar funções alteradas e frontend compatível. Não publicar reprocessamento sem a RPC disponível.
3. Observar erros de leitura/upload/reprocessamento, pendências locais e autenticação. Começar por amostra pequena identificável; não reprocessar todo o histórico nem regenerar IA automaticamente.
4. Se houver falha, interromper novas reavaliações e voltar ao aplicativo compatível. Manter colunas aditivas e dados; não derrubar tabelas/colunas, apagar CSVs ou desfazer políticas sem análise. CSVs originais são a base para recuperação controlada.

## Registro de evidência esperado

Salvar revisão/ambiente, comandos e códigos de saída, contagens/IDs antes/depois, negativas A/B/admin/anon e resultados dos fluxos. Separar resultado real de mock/harness. Remover segredos de logs. Só então marcar T03/T04/T08/T18 como integralmente homologadas.
