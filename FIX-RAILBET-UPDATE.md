# Atualização RailBET — 19 outubro 2026

Este pacote contém os ficheiros alterados a partir do commit 80a011b do repositório dtoAndre/RailBET. É uma atualização para sobrepor ao projeto existente, não um projeto completo. Não contém chaves nem altera automaticamente o site publicado.

## 1. Copiar os ficheiros

Extrai o ZIP para uma pasta temporária. Copia o conteúdo para `C:\Users\andre\Desktop\railbet-vercel`, substituindo os ficheiros com o mesmo nome. Mantém as subpastas, incluindo `.github/workflows`. Não substituas nem publiques o teu `.env.local`.

Se fizeste alterações ao código depois do commit indicado, compara os ficheiros antes de os substituir.

## 2. Atualizar a base de dados

No Supabase → SQL Editor, abre uma nova query e cola TODO o conteúdo de:

`supabase/migrations/003_live_observations.sql`

Executa a query. Este projeto já usa as migrações 001 e 002; não voltes a executar essas migrações. A 003 acrescenta os campos e funções para observações e preserva apostas, saldos e resultados existentes.

## 3. Corrigir os links de confirmação

No Supabase → Authentication → URL Configuration:

- Site URL: `https://rail-bet.vercel.app`
- Redirect URLs: acrescenta `https://rail-bet.vercel.app/auth/callback`
- Para desenvolvimento local, podes manter também `http://localhost:3000/auth/callback` na lista permitida. O Site URL de produção deve continuar a ser o endereço público.

Se personalizaste o template de confirmação de conta, verifica que o link utiliza `{{ .ConfirmationURL }}` e não um endereço localhost escrito manualmente.

No Vercel → projeto RailBET → Settings → Environment Variables, acrescenta em Production:

```dotenv
SITE_URL=https://rail-bet.vercel.app
```

Mantém as variáveis existentes `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` e `TRAIN_ARCHIVE_API_KEY`. A chave Train Archive é privada e não deve receber o prefixo NEXT_PUBLIC. A service-role key fica apenas nos secrets do GitHub para estes workflows; não é necessária no frontend.

O novo deploy tem de incluir esta variável. Links antigos já enviados podem conservar o destino antigo. Se a conta já está confirmada, entra diretamente no site; para verificar o novo fluxo, solicita um novo email. Esta alteração corrige o destino dos links, não os limites de envio de emails do Supabase.

## 4. Instalar e enviar para GitHub

No PowerShell, dentro do projeto, com Node.js 24:

```powershell
cd C:\Users\andre\Desktop\railbet-vercel
npm ci
npm run build
git check-ignore .env.local
git ls-files .env.local
```

O primeiro comando Git deve mostrar `.env.local`; o segundo não deve mostrar nada. Se o segundo mostrar esse ficheiro, retira-o do Git com `git rm --cached .env.local` e confirma que `.gitignore` contém `.env.local`. Se as chaves já foram publicadas num commit, substitui as chaves privadas expostas; retirar o ficheiro não apaga o histórico.

Adiciona apenas os ficheiros da atualização:

```powershell
git add -- .env.example package.json package-lock.json app/api/auth/route.ts app/api/game/route.ts app/archive-panel.tsx app/archive-panel.module.css app/auth/callback/route.ts app/railbet.css app/railbet.tsx lib/archive-journeys.ts lib/market-status.ts lib/site-url.ts lib/train-live.ts lib/train-archive.ts lib/types.ts scripts/sync_timetable.py scripts/sync_live.mjs .github/workflows/sync-live.yml supabase/migrations/003_live_observations.sql tests/history-live.test.mjs FIX-RAILBET-UPDATE.md
git diff --cached --stat
git commit -m "Fix train updates, history and confirmation redirects"
git push origin main
```

Se o Vercel continua ligado a este repositório, o push inicia o deploy. Aguarda o estado Ready e verifica que o deployment usa este commit e a variável SITE_URL.

## 5. Executar as sincronizações

No GitHub → RailBET → Actions, na branch main:

1. Executa **Sync future trains** → Run workflow. Aguarda o resultado.
2. Executa **Sync train observations** → Run workflow. Este workflow é novo.

Ambos usam os mesmos três secrets em Settings → Secrets and variables → Actions:

- `TRAIN_ARCHIVE_API_KEY`: token privado da conta Train Archive.
- `SUPABASE_URL`: URL do projeto Supabase.
- `SUPABASE_SERVICE_ROLE_KEY`: chave service_role desse projeto, nunca a publishable/anon.

Não são necessárias novas chaves. O workflow de observações fica agendado a cada 15 minutos; o GitHub pode atrasar execuções. O painel relê a base de dados a cada minuto enquanto está visível. O administrador também pode usar **Consultar observações agora** ou atualizar uma viagem. Os outros jogadores recebem os dados sincronizados, sem acesso às chaves.

O log apresenta `Targets`, `matched` e `newer observations saved`. Zero observações novas não significa necessariamente erro: pode não haver dados mais recentes para os comboios selecionados. Um erro HTTP ou uma migração em falta aparece explicitamente. O botão administrativo está sujeito ao limite existente de consultas; evita clicar repetidamente.

## O que mudou

- Atualizar observações deixa de chamar a antiga consulta IP e passa a consultar ficheiros TripUpdate do Train Archive. Os horários e as observações têm workflows separados.
- Cada viagem mostra a previsão de atraso no destino, a data da observação e um aviso quando tem mais de 30 minutos. O código não interpreta o fim do horário previsto como confirmação de chegada.
- O histórico agrupa todas as paragens de uma viagem antes de aplicar limites. Mostra `121` em vez de `121_20251214`; o identificador completo fica disponível nos detalhes técnicos.
- A linha principal apresenta o atraso no destino. Ao expandir, aparece um gráfico e um esquema interativo das paragens com a evolução dos atrasos. O esquema não é um mapa geográfico nem uma posição GPS.
- Dados em falta, cancelamentos, ordem ambígua e atrasos propagados são assinalados. Não se substitui um atraso final em falta pelo máximo das estações anteriores.
- A confirmação por email usa o endereço público configurado. A configuração de URLs no Supabase continua a ser necessária.

## Apostas: o que está validado e o que é manual

A base de dados verifica a identidade, saldo, montante de 10 a 500 créditos em múltiplos de 10, palpite de 0 a 360 minutos, uma aposta por utilizador/viagem e fecho 10 minutos antes da partida. Uma indicação de supressão bloqueia novas apostas. Débitos e registos são feitos na mesma transação; repetir um pedido igual não debita duas vezes.

**A confirmação do resultado continua manual.** O administrador confirma o atraso efetivo no destino, com fonte e justificação, ou anula a viagem. Depois dessa confirmação, o cálculo e a distribuição são automáticos: 90% do total para os palpites mais próximos, repartidos proporcionalmente ao valor apostado em caso de empate; 10% para a casa. Viagens anuladas ou com menos de dois participantes devolvem as apostas sem comissão. O sistema impede repetir o pagamento.

As observações do Train Archive podem ser previsões ou valores propagados. Esta atualização não as transforma automaticamente numa chegada comprovada nem paga prémios apenas porque passou a hora prevista.

## Verificação e limites

- Compilação de produção concluída; 30 testes Node e 10 testes Python passaram.
- Testes incluem as migrações numa base PostgreSQL local, permissões, atualização sem alterar os termos das apostas, prevenção de duplicados e distribuição dos créditos.
- Leitura de dados reais de 18/10/2026 verificada: 789 viagens agrupadas; comboio 121 Lisboa Santa Apolónia → Porto Campanhã, atraso publicado de 13 minutos no destino.
- Não foi executado um deploy na tua conta nem a sincronização autenticada com a tua chave. A verificação final é executar os dois workflows e consultar o painel após instalar a migração.
- Não foi possível concluir a verificação visual num navegador neste ambiente.
- O histórico mantém o acesso administrativo existente. A cobertura e a frescura dos dados dependem do Train Archive. São consultados os três ficheiros recentes de hoje e de ontem, ou o ficheiro diário compactado quando existe; isto não recupera automaticamente toda a história de mercados antigos.
- Para mercados antigos sem código da estação terminal, a associação só é preenchida se a versão original do horário e o nome do destino coincidirem. Se não coincidirem, mantém-se sem dados até uma verificação específica; não se altera uma aposta existente para outra viagem.

Documentação da fonte: https://www.train-archive.eu/connect
Configuração de redirects: https://supabase.com/docs/guides/auth/redirect-urls
