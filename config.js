// Configuração do Supabase.
// Copie a "Project URL" e a "anon public key" em:
// Supabase → Project Settings → API (ou "Data API" / "API Keys").
// A chave "anon"/"publishable" é pública por design: a segurança vem das
// regras RLS criadas em supabase/schema.sql.
//
// Enquanto estes campos estiverem vazios, o app funciona em "modo local"
// (salva só neste aparelho, sem login e sem sincronização).
export const CONFIG = {
  SUPABASE_URL: '',
  SUPABASE_ANON_KEY: '',
};
