> Atualização de 03/11: a recuperação por senha descrita neste registro histórico foi substituída por SMS e Google. O estado atual da autenticação e da hospedagem está em [Login e hospedagem](../auth-google-cloud/README.md). A versão integrada mais recente passou em 610 testes.

# Atualização local do Xpeed — 02/11/2026

Atualização de 03/11: a pedido do usuário, os fluxos de senha e recuperação
descritos nesta revisão foram substituídos por Google e código SMS. A nova
autenticação está implementada localmente e aguarda ativação administrativa
do Identity Platform. Veja [o registro atual](../auth-google-cloud/README.md).

Revisão de código, correções e testes no workspace. A evidência abaixo se refere à árvore local; não houve publicação, alteração no banco hospedado ou uso de IA paga. A revisão anterior de outubro continua preservada.

## Correções entregues

| Área | Problema confirmado e mudança |
|---|---|
| Recuperação de gravações | Uma escrita final recusada pelo IndexedDB podia deixar um backup parcial que tinha preferência sobre a cópia completa em memória. O upload agora prioriza a cópia completa. Teste injeta a falha e confere o tamanho exato do CSV enviado. |
| Identidade do carro | Um VIN igual ao de uma conexão anterior podia ser ignorado depois da desconexão. Identificações assíncronas antigas também podiam mudar o carro após uma nova conexão. Agora há invalidação por geração e reidentificação após desconectar. |
| Viagens de carro desconhecido | A seleção na interface podia receber uma viagem cujo VIN pertencia a outro carro. Novos backups guardam o VIN; um carro identificado ainda não cadastrado aguarda associação ao VIN correto. Backups antigos continuam compatíveis. |
| Sensores | `Long Term Fuel Trim Bank 1` podia ser interpretado como correção de curto prazo; `O2 B1S2` podia virar B1S1. O mapeamento agora distingue tipo, banco e sensor, usa correspondência por palavras e privilegia nomes específicos. Leituras desconhecidas de bateria de tração não são convertidas em tensão de 12V/SOC. |
| CSV com aspas | Quebras de linha dentro de nomes de sensores dividiam o arquivo em registros errados. O parser respeita aspas, aspas escapadas, CR/LF, BOM e delimitadores dentro de campos. |
| CSV ambíguo | Cabeçalhos repetidos/vazios, campos excedentes e aspas incompletas eram aceitos com perda silenciosa de valores. São recusados com erro antes da persistência. |
| Tempo e números | `Time (ms)` era tratado como segundos. Unidades explícitas de tempo são convertidas; valores numéricos não finitos deixam de ser leituras numéricas. Timestamps ausentes/inválidos são lacunas, e o início da viagem usa o primeiro timestamp válido. |
| Versão de processamento | A versão passa a `processing-3`, distinguindo novos processamentos dos anteriores. Não houve reprocessamento automático dos dados existentes. |
| Autenticação | Uma resposta inicial atrasada de `getSession` podia substituir um evento de logout mais recente. A inicialização também podia ficar presa se a promessa rejeitasse. Ambas as situações têm guardas e regressões. |
| Troca de conta | Providers de carros/scanner são remontados pela identidade da conta, impedindo reutilização do estado da conta anterior. |
| Armazenamento bloqueado | Acesso direto ao `localStorage` podia impedir inicialização, preferências, seleção de carro, onboarding e saída. Preferências opcionais usam acesso protegido; o Auth usa a detecção/fallback nativos do Supabase. Preferências inválidas são descartadas. |
| Cadastro de carros | Excluir o último carro agora limpa a seleção persistida. Falha ao carregar carros tem retry na Home e na lista e não leva o usuário indevidamente ao onboarding. VIN digitado usa a mesma validação e normalização do scanner. |
| Troca de carro nas páginas | Respostas atrasadas de manutenção/problemas/histórico e diálogos abertos podiam permanecer sob o nome do novo carro. O conteúdo dessas páginas é isolado pela identidade do carro. |
| Estado de saúde | Uma atualização malsucedida da lista de problemas podia continuar mostrando “tudo bem” a partir de um resultado vazio antigo. A falha agora permanece explícita, com retry. |
| Histórico do chat | Era possível enviar enquanto o histórico carregava ou depois de falhar. O histórico podia ser omitido do pedido ou sobrescrever mensagens recentes. O envio espera uma carga válida; erros têm retry. Clicar de novo na conversa atual preserva seu histórico. |
| Paginação auxiliar | Problemas, ocorrências, manutenção, fotos, links compartilhados, conversas e mensagens podiam ser truncados pelo limite de resposta do PostgREST. Agora são lidos em páginas com ordenação estável; falha em página posterior rejeita o resultado inteiro em vez de apresentar uma lista parcial como completa. |
| Concorrência do chat | Uma listagem antiga podia sobrescrever uma conversa recém-criada; excluir uma conversa enquanto outra era aberta podia limpar a nova visualização. As respostas são invalidadas conforme a operação/visualização. |
| Desempenho do chat | Abrir o chat buscava todo o histórico de viagens, problemas e manutenção no cliente e enviava um contexto que o servidor ignora e reconstrói. O cliente agora usa o nome já disponível na lista de carros e envia o ID ao servidor. |
| Entrada de mensagens | A interface agora respeita o limite de 4.000 caracteres do servidor, tem rótulo acessível e não envia Enter durante composição de texto. |
| Recuperação de senha | O Auth gerava links para uma rota inexistente. Foram adicionados “Esqueceu sua senha?”, envio do link, `/reset-password`, confirmação e atualização, com estados de erro e traduções nos três idiomas. |
| Consentimento OAuth | A recusa redirecionava diretamente para um destino ainda não verificado pelo servidor. Agora cancela localmente; esquemas inseguros/URIs inválidas e challenges PKCE inválidos não recebem controles de consentimento. Aprovação continua dependendo da validação do cliente registrado no servidor. |
| Relatório compartilhado | Uma rejeição inesperada podia deixar o loader indefinidamente; a resposta de um link antigo podia aparecer em outro. Há tratamento de erro, retry e isolamento por link. A lista de links privados também é isolada pela sessão. |
| Fotos | Se o upload funcionasse e a gravação dos metadados falhasse, sobrava um arquivo privado sem referência. Agora há remoção compensatória. Fotos de carros usam UUID, validam o arquivo no helper e preservam a foto anterior quando o update falha. |
| Manutenção | Falha de leitura não se apresenta como histórico vazio. Data e valores são validados, o formulário respeita submissão/validação nativas, o histórico continua ordenado e milhas são convertidas para km no armazenamento. |
| Fuso e acessibilidade | Datas na página de problemas usam a preferência do app; UTC/aliases do fuso atual permanecem selecionáveis. O diálogo de renomear viagem agora possui descrição acessível. |
| Testes e dependências | Testes têm URL/chave fictícias próprias, dispensando `.env` privado. `tailwindcss-animate` foi classificado como ferramenta de build. Nenhuma versão, pacote ou integridade do lockfile mudou; a árvore de produção deixa de incluir as ferramentas Tailwind por esse vínculo. |

As correções do parser se aplicam a novos uploads e reavaliações explícitas. CSVs originais, IDs das viagens e decisões existentes sobre problemas foram preservados. Reconhecer um canal não cria automaticamente uma regra mecânica para ele; bancos/sensores sem regras específicas permanecem uma limitação de cobertura.

## Verificação

Resultados finais registrados em [verificacao.json](verificacao.json). Comandos da rodada:

| Verificação | Resultado |
|---|---|
| Aplicação | **366 testes passaram em 53 arquivos**, 63 testes a mais que a suíte anterior |
| Tipos frontend/API | Passou |
| Lint | 0 erros, 11 avisos de Fast Refresh |
| Build | Passou; PWA com 73 entradas e 1817,20 KiB de precache |
| Edge Functions | Checagem de tipos e 3 testes passaram |
| PostgreSQL | 7 checks de processamento + replay de 55 migrações + 5 grupos de acesso passaram |
| Auditoria npm de produção | 0 vulnerabilidades reportadas |
| Whitespace | `git diff --check` passou |

```powershell
npm run typecheck
npm run lint
npm test -- --maxWorkers=4
npm run build
npm run check:edge
npm run test:sql
npm audit --omit=dev --json
git diff --check
```

O build foi feito com URL e chave públicas fictícias, validando compilação/PWA. Deno e PGlite foram usados a partir das ferramentas locais já instaladas em `node_modules/.xpeed-audit-tools`; o cache Deno existente foi usado. O teste SQL executa PostgreSQL em memória, incluindo replay das 55 migrações, rollback e isolamento entre proprietários/admin/anon.

No Chrome local, o harness fictício carregou a Home e o histórico de manutenção. Foi criado um serviço de teste, conferido novamente em outra abertura da página e registrado em [manutencao.png](manutencao.png). Isso valida o fluxo de interface com o adaptador/banco simulados. Uma tentativa posterior de inspeção da nova rota no navegador sofreu timeout da ferramenta; a recuperação de senha está coberta por testes de componente, sem envio de e-mail ou alteração de credencial real.

## Limites e pendências reais

- **Publicação:** alterações prontas para revisão no workspace, sem commit/push/deploy nesta execução. Não foi atribuída uma versão de release arbitrária ao pacote. A compatibilidade depende das RPCs da migração `20261029110000`, já documentadas no runbook anterior.
- **Auth hospedado:** conferir `/reset-password` na lista de redirects permitidos do Supabase e testar um e-mail de recuperação real no ambiente de homologação. As configurações externas não foram modificadas.
- **Dispositivo físico:** Android com tela apagada, encerramento do processo, disco cheio real, troca de adaptador/carros e reconexões prolongadas precisam de ensaio com hardware. Testes simulados não substituem essa homologação.
- **Dependências de desenvolvimento:** a auditoria completa ainda identifica 24 entradas (22 moderadas e 2 baixas), sem altas/críticas. Estão nas cadeias de `minimatch`, `glob` e `deepmerge` das ferramentas. As versões compatíveis consultadas não eliminam todas; forçar majors/downgrades transitivos poderia quebrar ESLint, Capacitor e Workbox. O `deepmerge` consultado ainda tem a versão estável 4.3.1 coberta pelo alerta. A classificação corrigida do Tailwind não é uma atualização de segurança dessas ferramentas.
- **Cobertura mecânica:** unidades ausentes/ambíguas, amostragem desconhecida, limites específicos por motorização, sensores ainda não reconhecidos e interpretação de tendências dependem de política/validação mecânica. Não foram inventados novos limiares nem recalculado o histórico em massa.
- **Escala e ciclo de vida:** a Home e algumas listas ainda carregam todos os registros para os agregados/apresentação; paginação de transporte não substitui agregação no servidor e virtualização para grandes volumes. Limpeza de arquivos órfãos antigos/cascatas e gestão de revogação de concessões OAuth continuam exigindo trabalho de backend e homologação. A compensação nova de fotos trata falhas novas, sem varrer dados existentes.
- **Desenvolvimento:** os 11 avisos preexistentes de Fast Refresh permanecem. Não há erros de lint.

Esta revisão cobre os achados reproduzidos/confirmados e os fluxos descritos; não é garantia de ausência de qualquer defeito no aplicativo ou nos serviços externos.

## Referências de implementação

- [Supabase: recuperação de senha e `updateUser`](https://supabase.com/docs/reference/javascript/auth-resetpasswordforemail).
- [RFC 9700: segurança de redirecionamentos OAuth](https://www.rfc-editor.org/rfc/rfc9700.html).
- [Advisory de minimatch](https://github.com/advisories/GHSA-g3hv-75wg-m249), [glob](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4) e [deepmerge](https://github.com/advisories/GHSA-gcqx-w48m-w2h4), identificados pela auditoria npm executada.
