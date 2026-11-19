# ADR 0004: aspetto proprio per il sito

- Stato: accettato
- Data: 2026-11-19
- Decisione di: Andrea, dopo il confronto di quattro direzioni grafiche (A iOS rifinito, B barberia moderna, C editoriale caldo, D streetwear): "la variante D cambiandone però i colori, il tasto prenota diventa del colore della A"; menu da icona uniforme; tema chiaro e scuro con pulsante.
- Contesto: [ADR 0003](0003-web-zero-cost.md) (copia che ricalca l'app iPhone)

## Contesto

La copia web riprendeva l'aspetto iOS dell'app: corretto, ma anonimo, con l'aspetto di una schermata di impostazioni più che di una barberia. Il menu in alto a destra era diverso da schermata a schermata.

## Decisione

- **Stile D "streetwear"**: linee da 1,5 px nel colore dell'inchiostro, angoli retti, titoli Oswald maiuscoli; colori dell'icona dell'app: blu notte `#2c3b5e` per le selezioni, rosso `#d93a3a` per l'azione principale ("Prenota →").
- **Due temi**: chiaro (bianco e nero) e scuro (`#111214` e crema `#f1ece2`); seguono il sistema, oppure la scelta fatta dal menu.
- **Menu unico**: un'icona in alto a destra in ogni schermata, che apre un menu a tendina (`popover` nativo) con le voci adatte alla schermata e la scelta del tema.
- **Font copiato nel sito** invece di Google Fonts: la CSP resta `default-src 'self'` e nessun dato va a Google.

## Alternative

| Opzione | Esito |
|---|---|
| Tenere l'aspetto iOS (A) | Scartata da Andrea: troppo poco caratterizzante |
| B barberia moderna, C editoriale caldo | Mostrate, non scelte |
| Font da Google Fonts | Scartata: richiede di aprire la CSP e manda l'IP dei visitatori a Google |
| Solo font di sistema stretti | Scartata come default: l'aspetto cambia da un dispositivo all'altro; resta come riserva in `--display` |
| Tema solo automatico | Scartata da Andrea: vuole anche la scelta manuale |

## Conseguenze

- Il sito non è più graficamente identico all'app iPhone; funzioni, testi e regole sì. Se un giorno l'app adotta lo stesso stile, i colori sono in `style.css` (variabili `--…`).
- Il menu richiede il supporto di `popover` (browser dal 2024).
- Un file in più da mantenere: `fonts/oswald-500.woff2` (licenza SIL OFL in `fonts/OFL.txt`).
