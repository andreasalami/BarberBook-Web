# BarberBook Web: profilo del progetto

- Scopo: copia web a costo zero dell'app iPhone BarberBook (`../BarberBook`), stesse funzioni e stesso backend.
- Stack: HTML, CSS, moduli JavaScript senza dipendenze né build; Supabase (Postgres + Auth, UE, piano Free) via `fetch`; hosting previsto GitHub Pages.
- Stato (2026-11-18): implementata e verificata in locale (demo completa) e sul Supabase reale (lato cliente). Pubblicata su https://andreasalami.github.io/BarberBook-Web/ (repository pubblico `andreasalami/BarberBook-Web`, GitHub Pages da `main`), verificata online in demo e su `PROVA2`.
- Origine: porting di BarberBook al commit `1602628` (branch `multi-shop-supabase`); `supabase/` è una copia identica.

## Documenti proprietari

- Uso, costi, differenze, deploy, privacy, limiti, concetti: [README.md](../README.md)
- Decisioni: [docs/adr/](../docs/adr/) (0001 e 0002 copiate dall'app, 0003 per la copia web)
- Interventi: [.forge/changes/](changes/)
- Apprendimento: [docs/learning/learning-register.md](../docs/learning/learning-register.md)

## Approvazioni

- 2026-11-18: Andrea chiede la copia web a costo zero (obiettivo di sessione). Scelte tecniche dell'ADR 0003 applicate come valori predefiniti, da confermare.
- 2026-11-18: Andrea approva "Pubblica su GitHub Pages" (repository pubblico, commit iniziale su `main`, push, Pages).

## Debito e rischi aperti

- Redirect URL `https://andreasalami.github.io/BarberBook-Web/` da aggiungere su Supabase (Authentication → URL Configuration) per completare l'accesso Google dal sito.
- Accesso Google e parte titolare non verificati sul server reale.
- CAPTCHA (Turnstile) sull'accesso anonimo da valutare prima dell'apertura al pubblico.
- Schema condiviso con l'app iPhone: ogni migrazione va provata su entrambi i client.
