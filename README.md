# Funil de Tráfego — EPN (Meta Ads)

Dashboard estático (GitHub Pages) que cruza **duas planilhas Google** e se reconstrói
sozinho **100% na nuvem** a cada 2 h. Nada roda no seu PC.

- **URL pública:** https://adryonv.github.io/Funil-EPN/
- **Somente leitura** nas planilhas (export CSV) — nunca escreve nelas.

## Como funciona

1. `build.mjs` (Node, sem dependências) roda no GitHub Actions:
   - lê a planilha de **anúncios** (aba *Meta Ads*) e a de **vendas** (aba *Vendas Geral (Hotmart)*);
   - filtra as vendas pelo **produto** (coluna *Produto*): core **"Efeito Próximo Nível"**
     e order bump **"Case de Promoção"**;
   - o **order bump** é somado como **receita** ao pedido do core do mesmo comprador
     (1 pedido = 1 venda — o bump não conta como venda nova);
   - atribui cada venda ao anúncio pela coluna **Detalhe UTM** (SCK do Meta:
     `conjunto | campanha | placement | ANÚNCIO` — o anúncio é o último segmento);
   - grava `public/data.json` **agregado, sem PII** (nomes/e-mails/telefones ficam fora).
2. A conta de anúncios é em **dólar (USD)**. O gasto vai **cru em US$** no
   `data.json`; o build busca o **câmbio USD→BRL ao vivo** (open.er-api.com) e o
   dashboard multiplica por `meta.fx` **antes de todas as métricas** (CPM, CPC,
   CAC, ROAS, etc.), exibindo tudo em **Real (BRL)**. **Sem imposto** (`meta.tax = 1`).
   A **receita** das vendas já está em BRL (coluna *Valor bruto (BRL)*), não converte.
3. O workflow publica `public/` na branch **gh-pages** (método à prova de OIDC).
4. `index.html` busca `data.json?v=<BUILD_ID>&t=<timestamp>` com `cache:no-store`
   (**cache-bust** duplo) — o navegador sempre pega a versão nova.

## Gatilhos do build

- `schedule` a cada 2 h (backup) · `workflow_dispatch` (botão manual) ·
  `repository_dispatch type=rebuild` (cron-job.org) · `push` na `main`.

### cron-job.org (a cada 2 h)

- **Method:** `POST`
- **URL:** `https://api.github.com/repos/adryonV/Funil-EPN/dispatches`
- **Headers:**
  - `Accept: application/vnd.github+json`
  - `Authorization: Bearer <SEU_TOKEN>`
  - `X-GitHub-Api-Version: 2022-11-28`
  - `User-Agent: cron-job`
- **Body:** `{"event_type":"rebuild"}`

O token vive **só** no cron-job.org, nunca neste repositório.
