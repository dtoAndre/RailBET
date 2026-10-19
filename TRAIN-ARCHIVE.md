# Instalar a integração Train Archive

Este pacote acrescenta consulta autenticada do arquivo diário CP à Gestão de viagens. Usa CSV.gz, sem bibliotecas adicionais. A chave fica no servidor. Apenas administradores podem consultar, com o controlo de frequência já existente no Supabase.

## 1. Atualizar o repositório local

O ZIP contém apenas ficheiros novos/alterados, nas pastas corretas. Copia o conteúdo da pasta railbet-vercel para a raiz do teu repositório (onde está package.json). Substitui os ficheiros indicados; se editaste app/railbet.tsx entretanto, integra apenas o import de ArchivePanel e a inclusão de <ArchivePanel/> no início da área admin. Não substituas .env.local.

Ficheiros: .env.example, app/railbet.tsx, app/archive-panel.tsx, app/api/archive/route.ts, lib/train-archive.ts, tests/archive.test.mjs e este guia. Não altera package.json nem package-lock.json.

## 2. Configurar localmente

Acrescenta ao .env.local, mantendo os valores Supabase existentes:

```dotenv
TRAIN_ARCHIVE_API_KEY=COLOCA_A_TUA_CHAVE_AQUI
```

Não uses NEXT_PUBLIC_ nesta variável. Não coloques a chave no Git ou em mensagens. Reinicia o servidor após alterar o ficheiro.

```powershell
npm test
npm run build
npm run dev
```

Entra em http://localhost:3000 com a tua conta administradora. Em Gestão de viagens, procura Train Archive — consultar atrasos. Escolhe uma data concluída, por exemplo 2026-10-10, e consulta sem identificador. Depois copia um trip_id da tabela para filtrar exatamente essa viagem. O número comercial do comboio não é necessariamente igual ao trip_id. São apresentados até 300 registos e até 500 sugestões; podes escrever qualquer identificador exato.

## 3. Supabase

Não é necessária nenhuma nova migração, bucket ou chave service-role. Mantém a migração original do RailBET e a conta administradora já configuradas. São reutilizadas railbet_state (autorização) e railbet_import_gate (limite de consultas). A consulta do arquivo não escreve resultados, apostas ou saldos na base de dados.

## 4. GitHub

Na raiz do teu repositório:

```powershell
git status
git add .env.example app/railbet.tsx app/archive-panel.tsx app/api/archive/route.ts lib/train-archive.ts tests/archive.test.mjs TRAIN-ARCHIVE.md
git diff --cached --stat
git commit -m "Add authenticated Train Archive lookup"
git push
```

Confirma que .env.local não aparece nos ficheiros preparados para commit. O .gitignore original já o exclui. Não precisas de criar outro repositório.

## 5. Vercel

No projeto existente, abre Settings → Environment Variables. Adiciona TRAIN_ARCHIVE_API_KEY com a chave para Production e, se usares, Preview e Development. Mantém as duas variáveis públicas do Supabase. Faz um novo deploy depois de adicionar a variável. Não é necessário alterar vercel.json nem configurar cron. O endpoint /api/archive é uma função Node com limite de 30 segundos.

## O que esta versão faz

- Consulta os ficheiros diários de https://data.train-archive.eu/daily/provider=pt-cp/service=TripUpdate/date=AAAA-MM-DD.csv.gz com X-Api-Key.
- Mostra estação, hora programada, atraso e delay_source, incluindo valores propagated.
- Preserva campos em falta; não converte atraso desconhecido em zero.
- Rejeita datas inválidas, erros de autenticação, CSV inesperado e respostas excessivas. Não segue redirecionamentos com a chave.

## O que ainda depende de validação

Esta integração consulta dias concluídos; não substitui a importação de horários futuros pela IP. Os ficheiros intradiários em Parquet não são consumidos nesta versão. Um 404 pode significar que o dia ainda não foi consolidado ou não tem dados.

O arquivo descreve atrasos finais, mas pode propagar valores de estações anteriores. Por isso não existe liquidação automática: valida a identidade da viagem, destino e significado do registo antes de confirmar manualmente no painel existente. Quando não houver confirmação, usa a anulação/reembolso prevista no jogo. Não abras apostas em viagens históricas cujo resultado já é conhecido.

Testes locais usam respostas simuladas (CSV/gzip e erros HTTP). A consulta autenticada real precisa de ser validada com a tua chave no teu ambiente. Documentação da fonte: https://www.train-archive.eu/connect .
