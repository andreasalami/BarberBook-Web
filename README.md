# BarberBook Web

Copia web, **a costo zero**, dell'app iPhone [BarberBook](../BarberBook/README.md): stesse schermate, stesse regole, stesso backend. Si apre da qualsiasi browser (iPhone, Android, computer) e si può aggiungere alla schermata Home come un'app.

- **Cliente**: inquadra il QR del negozio con la fotocamera del telefono (si apre direttamente la pagina del negozio) oppure scrive il codice di 6 caratteri. Sceglie servizio, operatore e giorno, vede solo gli orari liberi, prenota, aggiunge l'appuntamento al calendario con un promemoria un'ora prima, può disdire. Non serve un account: solo il nome che scrive. Dal menu Account può accedere con Google per ritrovare le prenotazioni su un altro dispositivo.
- **Titolare**: accede con Google, crea il negozio e riceve codice e QR da condividere o stampare. Gestisce l'agenda dei prossimi 5 giorni (su schermo largo una colonna per giorno; su telefono la striscia dei 5 giorni e poi i giorni uno sotto l'altro), gli appuntamenti al banco o al telefono, orari di apertura, operatori e servizi. Può eliminare account e negozio.

## Costo: zero

| Pezzo | Servizio | Costo |
|---|---|---|
| Pagine (HTML, CSS, JavaScript) | GitHub Pages, repository pubblico | Gratis |
| Database, accessi, regole | Supabase, piano Free (stesso progetto dell'app iPhone) | Gratis |
| Accesso Google | Google Auth Platform (client OAuth già creato) | Gratis |
| Dominio | `andreasalami.github.io/BarberBook-Web/` | Gratis |
| Librerie | Nessuna: zero dipendenze, nessuna build | — |

Nessun Apple Developer Program (99 €/anno), nessun App Store, nessun piano Pro.

## Differenze rispetto all'app iPhone

Tutto il resto è identico: stesse tabelle, stesse regole RLS e trigger lato server, stessi testi, stesso ordine dei menu, stessa modalità demo.

| App iPhone | Copia web | Perché |
|---|---|---|
| Accedi con Apple o Google | Solo **Google** | Sign in with Apple sul web richiede l'Apple Developer Program (a pagamento) |
| Promemoria locale un'ora prima | **"Aggiungi al calendario"**: file `.ics` con avviso un'ora prima (alla conferma e dal menu ⋯ della prenotazione) | Il browser non può programmare una notifica a pagina chiusa; il calendario del telefono sì |
| QR `barberbook://shop/CODICE` (serve l'app installata) | QR `https://…/BarberBook-Web/?shop=CODICE` | Lo apre qualsiasi fotocamera, senza installare nulla |
| Sessione nel Keychain | Sessione nel `localStorage` del browser (token e id utente, nient'altro) | È l'archivio disponibile sul web; vedi Sicurezza |
| Eliminazione operatore/servizio con swipe | Pulsante "Elimina" con conferma | Sul web non c'è lo swipe; la conferma evita i clic sbagliati |
| Demo con `-demo YES` in Xcode | Demo aprendo il sito con `?demo` | Stessi dati: Barberia Demo, codice **BARBA2** |

## File

| File | Contenuto | Corrisponde a |
|---|---|---|
| `index.html` | Pagina unica, regole di sicurezza (CSP) | — |
| `app.js` | Stato, operazioni e schermate | `Store.swift`, `BarberBookApp.swift`, `BookingViews.swift`, `OwnerViews.swift` |
| `api.js` | Client minimo senza SDK: sessione anonima o Google, rinnovo token, chiamate REST | `Supabase.swift` |
| `logic.js` | Logica pura: orari liberi, prezzi, formati italiani, file calendario | `Scheduling.swift`, `Service.cents` |
| `qr.js` | Generatore di QR (nessuna libreria) | Core Image |
| `config.js` | URL e chiave pubblica del progetto Supabase | Costanti in `Supabase.swift` |
| `style.css` | Aspetto stile iOS, chiaro e scuro, layout largo | — |
| `manifest.webmanifest`, `icon-512.png`, `apple-touch-icon.png` | Installazione sulla schermata Home, icona del palo da barbiere | `AppIcon` |
| `checks/checks.mjs` | Self-check di orari, prezzi, file calendario e QR | `Checks/main.swift` |
| `checks/qr-decode.swift` | Legge i QR generati con il lettore di macOS | — |
| `supabase/` | Schema, migrazioni e test: copia identica di quelli dell'app | `supabase/` |

## Provarla subito

```bash
python3 -m http.server 8787 --bind 127.0.0.1 --directory ~/Desktop/Claude-Code/Projects/BarberBook-Web
```

Poi apri <http://localhost:8787/?demo>. Come cliente usa il codice **BARBA2**; come titolare tocca "Entra nella demo". I dati demo sono in memoria e si azzerano ricaricando la pagina. Il server risponde solo da questo Mac (`127.0.0.1`); si ferma con Ctrl+C.

Senza `?demo` la pagina usa il Supabase vero: <http://localhost:8787/?shop=PROVA2> apre il negozio di prova.

## Controlli

```bash
TZ=Europe/Rome node checks/checks.mjs /tmp/barberbook-qr.txt
```

```bash
xcrun swift checks/qr-decode.swift /tmp/barberbook-qr.txt
```

Il primo verifica orari liberi, prezzi, file calendario e la struttura dei QR; il secondo fa leggere i QR (versioni 1, 4 e 10) al lettore di sistema di macOS e confronta il testo. I test del database sono quelli dell'app: `zsh supabase/tests/run-local.sh`.

## Metterla online (GitHub Pages)

1. Crea su GitHub il repository **pubblico** `BarberBook-Web` (Pages è gratis solo per i repository pubblici) e carica questa cartella.
2. Repository → Settings → Pages → *Deploy from a branch* → `main` / `/ (root)` → Save. Dopo un minuto il sito è su `https://andreasalami.github.io/BarberBook-Web/`.
3. **Supabase** → Authentication → URL Configuration → Redirect URLs: aggiungi `https://andreasalami.github.io/BarberBook-Web/` (e `http://localhost:8787/` per le prove locali). È l'indirizzo a cui Supabase rimanda dopo Google; quelli non in elenco vengono rifiutati e l'accesso finisce sul *Site URL*.
4. Nient'altro su Google: il redirect autorizzato resta quello di Supabase (`…supabase.co/auth/v1/callback`).

Il repository pubblico espone solo codice e la chiave pubblica di Supabase, fatta apposta per stare nelle app e nelle pagine web: non dà permessi, decidono le regole RLS. **Mai** mettere la chiave `service_role` / `sb_secret_…` in questi file.

Per usare un progetto Supabase separato (anch'esso gratuito): crealo in UE, esegui `supabase/schema.sql` e `supabase/tests/rls.sql`, configura i provider come descritto nel README dell'app, poi cambia URL e chiave in `config.js` **e** l'indirizzo in `connect-src` dentro `index.html`.

## Sicurezza

- **Content Security Policy** (`index.html`): la pagina esegue solo i propri file, nessuno script inline o esterno, e parla solo con Supabase. Riduce il danno di un eventuale XSS, che è il rischio principale di tenere i token nel `localStorage`.
- Tutto il testo arriva nella pagina come testo (`textContent`), mai come HTML: un nome cliente come `<script>` resta una scritta.
- Nessuna libreria di terze parti, nessun CDN, nessun analytics: il browser contatta solo GitHub Pages (le pagine) e Supabase (i dati); Google solo per chi sceglie di accedere.
- Le regole che contano sono sul server e sono le stesse dell'app: isolamento tra negozi (RLS), niente doppie prenotazioni (vincolo di esclusione), servizio e orari validi, massimo 4 prenotazioni future per cliente e negozio.

## Privacy

Stessi dati e stesse regole dell'app iPhone (tabella completa nel [README dell'app](../BarberBook/README.md#privacy)). Differenze:

| Dato | Dove | Conservazione | Cancellazione |
|---|---|---|---|
| Sessione (token di accesso e rinnovo, id utente, se anonimo) | `localStorage` di questo browser | Finché non si esce o si eliminano i dati | "Esci dall'account", "Elimina i miei dati", o cancellando i dati del sito nel browser |
| Ruolo, codice del negozio, ultimo nome usato | `localStorage` di questo browser | Come sopra | "Elimina i miei dati" o dati del sito |
| Verifica PKCE durante l'accesso Google | `sessionStorage` della scheda | Fino al ritorno da Google | Automatica |
| Indirizzo IP e richieste delle pagine | GitHub (hosting) | Secondo le regole di GitHub | — |

GitHub Pages diventa un fornitore in più: serve solo i file statici, non riceve dati delle prenotazioni.

## Limiti noti

Oltre a quelli dell'app iPhone (fuso orario fisso, un negozio per titolare, una fascia oraria al giorno, nessuna notifica al titolare, limite di 4 prenotazioni aggirabile ricreando utenti anonimi):

- **Piano gratuito di Supabase**: il progetto va in pausa dopo 7 giorni senza traffico (si riattiva dalla dashboard) e non ha backup. È il prezzo del costo zero.
- **Abuso dell'accesso anonimo**: sul web è più facile creare utenti anonimi in serie. Contromisura gratuita da valutare: CAPTCHA Cloudflare Turnstile sull'accesso anonimo (Supabase → Authentication → Attack Protection), richiede un account Cloudflare gratuito.
- **Promemoria**: il file `.ics` va aggiunto al calendario a mano; se poi si disdice, l'evento resta nel calendario e va tolto a mano.
- **Accesso con Google dall'icona sulla schermata Home (iPhone)**: iOS può completare l'accesso in Safari invece che nell'icona, e l'accesso non si chiude. In quel caso si accede dalla pagina in Safari. La prenotazione da cliente non ne risente.
- **Cliente senza account**: le prenotazioni sono legate a questo browser. Cambiando browser o cancellando i dati del sito non le vede più (restano valide in negozio). Con Google le ritrova.
- Il pulsante Google è testuale: prima di aprire l'accesso a tutti va usato lo stile ufficiale Google e pubblicato il client OAuth (oggi in modalità *Testing*, solo utenti di test).
- Agenda aggiornata ogni 2 minuti mentre è aperta, e quando si torna sulla pagina.

## Verifica eseguita (18/11/2026)

- `checks/checks.mjs`: passa. `checks/qr-decode.swift`: i 3 QR vengono letti dal lettore di macOS; il QR mostrato nella pagina viene letto anche dal lettore del browser e porta a `?shop=BARBA2`.
- Demo nel browser integrato, 375 px (telefono) e 1100 px (schermo largo), tema chiaro e scuro: scelta ruolo, codice BARBA2, prenotazione con conferma e sparizione dell'orario, "Le mie", disdetta, menu Account, passaggio a titolare con nuova richiesta di accesso, agenda (striscia e colonne), dettaglio appuntamento, appuntamento al banco, orari con controllo apertura/chiusura, eliminazione operatore con conteggio degli appuntamenti, nuovo servizio con prezzo "12,5". Nessun errore in console, nessuno scorrimento orizzontale.
- Supabase reale, negozio di prova `PROVA2`: apertura dal link del QR, sessione anonima creata (nel browser solo token e id), orari dal server, prenotazione accettata dalle regole del server, file calendario corretto (18:30 ora di Roma = 17:30 UTC, avviso a −1 h), "Le mie" con prezzo e negozio, avvio dell'accesso Google fino alla pagina di Google (provider e collegamento account attivi), "Elimina i miei dati". Controllo SQL in sola lettura: nessuna prenotazione e nessun utente anonimo di prova rimasti.
- **Non verificato**: accesso Google completato e parte titolare sul server reale (richiede il tuo account Google e il redirect configurato su Supabase), pubblicazione su GitHub Pages, file `.ics` aperto su iPhone/Android veri.

## Concetti nuovi

**GitHub Pages**: hosting gratuito di file statici direttamente da un repository GitHub.
- **Modello mentale**: ogni push sul branch scelto pubblica i file così come sono; non c'è un server che esegue codice, quindi niente da aggiornare o mettere in sicurezza lato server.
- **Perché qui**: l'app non ha bisogno di un server proprio (la logica protetta è in Supabase); lo usi già per `andreasalami.github.io`.
- **Alternative**: Cloudflare Pages o Netlify (gratuiti, servono account in più), Vercel.
- **Costo e limiti**: gratis per repository pubblici; 1 GB di sito e 100 GB di traffico al mese, ampiamente sufficienti.
- **Disattivazione**: Settings → Pages → *Unpublish*, oppure rendere privato o eliminare il repository.
- **Esercizio**: dopo la pubblicazione, apri Settings → Pages e trova l'indirizzo del sito e lo stato dell'ultima pubblicazione nella scheda *Actions*.

**PWA (Progressive Web App)**: una pagina web con un `manifest.webmanifest` (nome, icona, colori) che il telefono può aggiungere alla schermata Home e aprire a schermo intero, come un'app. Su iPhone: Condividi → *Aggiungi alla schermata Home*. Qui non c'è un *service worker* (funzionamento offline): servirebbe solo a mostrare dati vecchi senza rete.

**Content Security Policy (CSP)**: elenco, dichiarato nella pagina, di cosa il browser può caricare ed eseguire e con chi può parlare. Se qualcuno riuscisse a inserire uno script nella pagina, il browser lo rifiuterebbe. Esercizio: in `index.html` togli `https://mhhajacrybeuqilyqjhe.supabase.co` da `connect-src`, ricarica `?shop=PROVA2` e leggi l'errore nella console del browser; poi rimettilo.

**`localStorage` e `sessionStorage`**: archivi chiave-valore del browser, separati per sito. Il primo resta finché non viene cancellato; il secondo vive solo nella scheda aperta. Non sono cifrati né protetti come il Keychain: per questo la pagina tiene solo i token (che scadono) e usa la CSP.

**OAuth con PKCE nel browser**: come nell'app, ma la pagina lascia il posto a Google e poi Supabase la riapre con `?code=…`. Il `code_verifier` resta nel `sessionStorage` della scheda durante il giro; senza di esso il codice è inutile. Per questo l'indirizzo di ritorno deve essere nella lista dei Redirect URLs di Supabase.

**File `.ics` (iCalendar)**: formato standard di testo per gli eventi, letto da Calendario di Apple, Google Calendar e Outlook. Il blocco `VALARM` con `TRIGGER:-PT1H` è l'avviso un'ora prima.
