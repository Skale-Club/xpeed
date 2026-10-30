# Abastecimento por foto — validação local de 30/10/2026

Implementado na branch `codex/reliability-regional-preferences`, após o pacote de confiabilidade e preferências regionais. Sem push, deploy, migração remota ou uso de fotos reais. O teste físico no Android foi dispensado pelo usuário.

## Fluxo

1. Em Combustível → Registrar abastecimento, tocar em **Preencher com foto**.
2. Tirar uma foto ou escolher uma imagem JPG, PNG ou WebP. A imagem é reduzida e regravada localmente, sem o EXIF original.
3. Conferir a prévia e tocar em **Ler esta foto**. O aviso informa o envio ao provedor OpenRouter.
4. Revisar valor pago, quantidade, moeda e unidade. Os campos podem ser corrigidos. Moeda e padrão de galão ambíguos exigem escolha explícita.
5. **Usar estes valores** preenche o formulário, convertendo a quantidade para a unidade das preferências. Não grava o abastecimento.
6. **Salvar** usa o fluxo existente com chave de idempotência e confirma a gravação. Dados parciais não apagam os valores manuais de outros campos.

Cancelar a leitura aborta a chamada do cliente e descarta respostas atrasadas. Falhas mantêm o preenchimento manual disponível. Atualizações automáticas do app ficam suspensas durante a leitura ou enquanto houver alterações pendentes no formulário.

## Serviço

- Nova Edge Function `read-fuel-receipt`, com autenticação e verificação de propriedade do carro antes da chamada paga.
- Reutiliza a chave e o modelo configurados no painel de administração. Consulta o catálogo oficial do OpenRouter para verificar suporte a imagens e saídas estruturadas. Se o modelo não for compatível, retorna uma mensagem e mantém a entrada manual; não troca o modelo silenciosamente.
- Limite independente de 10 leituras por usuário/dia. Erros de inferência, respostas inválidas e fotos sem valores legíveis tentam devolver a cota. Falha no serviço de cotas bloqueia a inferência.
- Upload original de até 12 MiB, imagem decodificada de até 40 MP, maior dimensão de saída de 2048 px e imagem enviada de até 2 MiB. O servidor limita também o corpo real da requisição e valida a assinatura do formato.
- Aceita somente imagem inline. Não busca URLs enviadas pelo cliente, não guarda imagens no banco ou Storage e não registra a imagem ou a resposta bruta do provedor nos logs da função. A retenção pelo provedor segue a política do modelo/provedor escolhido.
- Saída restrita a quatro campos, com validação no servidor e cliente. O prompt trata o texto da imagem como dados e instrui a não inventar valores ausentes, moeda ou tipo de galão.

## Evidências

- `revisao-mobile.png`: revisão com extração sintética de USD 35,90 e 10 US gal; Salvar ainda desabilitado.
- `valores-preenchidos-mobile.png`: valores aplicados ao formulário, antes de gravar.
- `abastecimento-salvo-mobile.png`: confirmação e resumo mensal atualizado no ambiente simulado.
- `foto-320.png`: seleção e entrada manual em 320 px, sem transbordamento horizontal.
- `bootstrap-sql.json` e `processing-sql.json`: contratos PostgreSQL em banco isolado. Incluem cota independente, teto, devolução e bloqueio do RPC para o usuário comum.

O navegador usou uma imagem sintética sem dados pessoais. A compressão e o preenchimento passaram pelo código real do cliente; a resposta de IA e o cadastro foram simulados pelo harness local. Não foi executada uma inferência paga nem validada a câmera do Android físico. Os testes do handler usam respostas simuladas do provedor.

## Publicação futura

Somente quando solicitada pelo usuário:

1. Aplicar as migrações pendentes do pacote anterior e `20261030220000_fuel_receipt_quota.sql`.
2. Publicar `read-fuel-receipt`, incluindo seus módulos compartilhados.
3. Verificar no ambiente de destino a compatibilidade do modelo configurado e executar uma leitura consentida com foto de teste.
4. Publicar o cliente. A seleção por câmera/galeria usa controles web; não foi introduzido novo plugin nativo ou permissão Android.

Main/dev e seus remotos continuam no commit publicado `f243ac42d5cf022f59abcfb628b665f59532b0de`.
