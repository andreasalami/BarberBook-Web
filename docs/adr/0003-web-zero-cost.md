# ADR 0003: copia web a costo zero

- Stato: accettato
- Data: 2026-11-18
- Decisione di: Andrea ("una copia del progetto che ricalchi in tutto e per tutto quello originale ma che sia a costo zero e via web", 2026-11-18). Le scelte tecniche sotto sono valori predefiniti proposti da Claude, da confermare.
- Contesto: [ADR 0001](0001-supabase-multi-shop.md), [ADR 0002](0002-apple-google-sign-in.md)

## Contesto

L'app iPhone costa: Apple Developer Program (99 €/anno) per Sign in with Apple e la distribuzione, e il README raccomanda Supabase Pro (25 $/mese) per clienti veri. Serve la stessa app usabile dal browser, senza costi.

## Decisione

- **Pagina statica senza dipendenze né build** (HTML, CSS, moduli JavaScript), ospitata su **GitHub Pages** in un repository pubblico.
- **Stesso backend Supabase** (piano Free, stesso progetto, stesso schema): RLS, trigger e vincoli restano l'unica autorità. Web e iPhone vedono gli stessi negozi.
- **Client scritto a mano su `fetch`** (porting di `Supabase.swift`) invece di `@supabase/supabase-js`: nessuna dipendenza da verificare, nessun CDN.
- **Solo Google** come accesso (Apple sul web è a pagamento).
- **Promemoria come file `.ics`** con allarme a −1 h.
- **QR come link web** `?shop=CODICE`, generato da un encoder QR scritto qui e verificato col lettore di macOS.
- Sessione nel `localStorage`, protetta da una Content Security Policy restrittiva.

## Alternative

| Opzione | Esito |
|---|---|
| SDK `supabase-js` da CDN | Scartata: dipendenza esterna eseguita nella pagina con i token, per ~150 righe già scritte in Swift |
| Framework (React, Vue) con build | Scartata: strumenti e dipendenze in più per ~10 schermate |
| Cloudflare Pages / Netlify | Valide e gratuite, ma richiedono un account nuovo; GitHub Pages è già in uso |
| Nuovo progetto Supabase separato | Possibile e gratuito (`config.js` + CSP); scartata come default per non duplicare configurazione Google e negozi |
| Web Push per i promemoria | Scartata: serve un server che invii le notifiche (costi o gestione) |

## Conseguenze

- Costo zero, ma con i limiti del piano Free (pausa dopo 7 giorni senza traffico, nessun backup).
- GitHub diventa un fornitore (solo file statici, nessun dato di prenotazione).
- Il codice è pubblico: va bene perché non contiene segreti, ma ogni futura chiave segreta deve restare fuori.
- Due client (Swift e JavaScript) sullo stesso schema: una modifica allo schema va provata su entrambi.
