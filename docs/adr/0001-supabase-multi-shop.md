# ADR 0001: più negozi in una sola app con Supabase (UE)

- Stato: accettato
- Data: 2026-11-16
- Decisione di: Andrea ("Supabase EU", 2026-11-16), piano concreto approvato fornendo progetto e chiave lo stesso giorno

## Contesto

La prima versione usava CloudKit con un solo negozio per container. Serviva: titolari che creano da soli il proprio negozio, clienti che scelgono il loro negozio e ci tornano direttamente, il minimo di dati personali.

CloudKit nel database pubblico assegna i permessi per **tipo di record**, non per negozio. Il ruolo `Owner` avrebbe dato a ogni titolare accesso alle prenotazioni di tutti, e i ruoli si assegnano solo a mano dalla Console.

## Opzioni valutate

| Opzione | Esito |
|---|---|
| A. CloudKit con più negozi | Scartata: isolamento solo parziale (nomi da cifrare lato client, il titolare non può annullare le prenotazioni dei clienti), solo Apple |
| B. Supabase (Postgres + RLS), regione UE | **Scelta** |
| C. Server proprio | Scartata per ora: controllo massimo, ma manutenzione e sicurezza a nostro carico |

## Decisione

- Database Supabase in UE; isolamento per negozio con Row Level Security (`supabase/schema.sql`).
- Clienti: accesso anonimo, nessun dato oltre al nome scritto alla prenotazione.
- Titolari: Sign in with Apple senza email né nome; un negozio per titolare.
- Scelta del negozio: codice di 6 caratteri o QR (`barberbook://shop/<CODICE>`), salvato sul telefono come predefinito. Nessun elenco pubblico dei negozi.
- Doppie prenotazioni impedite da un vincolo di esclusione del database.
- Client scritto a mano su `URLSession` (circa 200 righe) invece dell'SDK `supabase-swift`, che porta circa 10 pacchetti in più (tra cui `swift-syntax`).
- Conservazione: prenotazioni cancellate 30 giorni dopo l'appuntamento; utenti anonimi senza prenotazioni dopo 30 giorni.

## Conseguenze

- Un fornitore in più (Supabase): DPA da firmare, regione UE da verificare, piano Pro per l'uso reale.
- La sicurezza dipende dalle policy SQL: ogni modifica deve passare `supabase/tests/rls.sql`.
- Prima della pubblicazione su App Store va aggiunta la revoca del token Apple alla cancellazione dell'account.
- In futuro sono possibili client Android o web sullo stesso backend.
