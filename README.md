# Aquecimento de hoje

App web (feito primeiro para celular) que controla o aquecimento diário das contas de **Instagram** e **TikTok** de cada app.
O login é por e-mail e tudo fica salvo no **Supabase**, então o celular e o computador mostram sempre os mesmos dados ("Sincronizado ✓").

São arquivos estáticos (HTML, CSS e JS), sem etapa de build:

| Arquivo | O que é |
|---|---|
| `index.html` / `styles.css` / `app.js` | o app |
| `config.js` | URL e chave pública do Supabase |
| `supabase/schema.sql` | tabelas, regras de segurança (RLS) e tempo real |
| `manifest.webmanifest`, `icon.svg` | para "Adicionar à tela inicial" |

## 1. Criar o banco no Supabase

1. Crie um projeto em https://supabase.com (o plano gratuito basta).
2. Abra **SQL Editor → New query**, cole o conteúdo de `supabase/schema.sql` e clique em **Run**.
3. Em **Authentication → Sign In / Providers**, deixe o **Email** ativado.
4. Em **Authentication → URL Configuration**, coloque o endereço onde o app vai ficar publicado
   (ex.: `https://seu-usuario.github.io/meu-app/`) em **Site URL** e em **Redirect URLs**.
5. *(Opcional, ajuda quem usa o app instalado na tela inicial)* Em **Authentication → Emails → Magic Link**,
   inclua `{{ .Token }}` no modelo. Assim o e-mail traz também um código de 6 dígitos, que você pode digitar no app.

## 2. Configurar o app

Em **Project Settings → API**, copie a *Project URL* e a chave *anon / publishable* para o `config.js`:

```js
export const CONFIG = {
  SUPABASE_URL: 'https://xxxx.supabase.co',
  SUPABASE_ANON_KEY: 'eyJ...',
};
```

A chave anon pode ficar pública: as regras RLS garantem que cada pessoa só lê e altera os próprios dados.
Com o `config.js` vazio, o app roda em **modo local**: salva só no aparelho, sem login.

## 3. Publicar

Qualquer hospedagem estática serve, por exemplo:
- **GitHub Pages:** Settings → Pages → *Deploy from a branch* → `main` / root.
- **Netlify / Vercel / Cloudflare Pages:** importe o repositório, sem comando de build.

Para testar no computador: `python3 -m http.server 8000` e abra http://localhost:8000.

## Apps iniciais

Os apps começam como `App 1` … `App 4` (a lista `DEFAULT_APPS` fica no início do `app.js`). Para trocar o nome, toque nele.

## Como funciona

- **Timer por timestamp:** cada conta guarda o tempo acumulado (`ms`) e a hora em que a rodada atual começou (`start`).
  Por isso a contagem continua certa com a tela bloqueada ou o app fechado, e até em outro aparelho.
- **Só um timer por vez:** ao iniciar um timer, o que estiver rodando pausa.
- **Tela acesa:** usa a Wake Lock API enquanto um timer roda (Chrome/Android e Safari iOS 16.4+).
- **Ao terminar:** o timer para, toca um sinal sonoro, vibra (em aparelhos com suporte) e mostra "Feita ✓".
  Se a tela estava bloqueada, o sinal toca quando você voltar ao app.
- **Sincronização:** salva no Supabase cerca de 0,3 s depois de cada mudança e recebe as mudanças dos outros aparelhos em tempo real.
  Em caso de conflito, vale a alteração mais recente de cada conta. Sem internet, salva no aparelho e envia quando a conexão voltar.
- **Virada do dia:** à meia-noite, o dia é fechado (um timer que estava rodando para às 00:00) e vai para o histórico
  se teve atividade. O dia novo começa zerado.
