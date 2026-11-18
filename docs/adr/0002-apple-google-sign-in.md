# ADR 0002: accesso con Apple e Google, facoltativo per i clienti

- Stato: accettata (2026-11-16)
- Contesto: [ADR 0001](0001-supabase-multi-shop.md). Andrea vuole che titolari e clienti possano accedere con Apple e Google; l'email classica è rimandata.

## Decisione

- Titolari: Apple o Google, obbligatorio (serve un'identità stabile per possedere un negozio).
- Clienti: restano anonimi per prenotare. Accedere con Apple o Google è facoltativo e serve a ritrovare le prenotazioni su un altro telefono. L'identità viene **collegata** all'utente anonimo, quindi le prenotazioni restano sue.
- Google senza SDK: OAuth con PKCE gestito da Supabase, pagina in `ASWebAuthenticationSession`.

## Alternative

- **Login obbligatorio per i clienti**: più semplice da gestire, ma raccoglie l'email di tutti e allontana chi vuole solo prenotare. Scartato per minimizzazione dei dati.
- **SDK GoogleSignIn**: pulsante nativo, ma introduce una dipendenza e la sua telemetria per un caso coperto da un'API di sistema.
- **Email e password**: rimandato da Andrea. Richiede un servizio SMTP (es. Brevo), modelli di email e il recupero password.

## Conseguenze

- Con Google, Supabase conserva email, nome e foto dell'account Google (tabelle interne di Auth, mai lette dall'app né visibili ai negozi). È documentato nella tabella privacy del README.
- Apple richiede ancora l'Apple Developer Program; Google funziona anche con il Personal Team.
- Prima della pubblicazione: pubblicare il client OAuth Google (branding), usare il pulsante Google ufficiale e aggiungere la revoca del token Apple.
