# Padelagenda (PWA)

Gedeelde padelagenda die iedereen als app op de telefoon kan zetten. Iedereen met de link ziet de matchen; wijzigen kan met een bewerkingscode.

## 1. Lokaal testen

```
EDIT_CODE=mijncode node server.js
```
Open daarna http://localhost:3000. Opties: `PORT` (standaard 3000), `DATA_DIR` (standaard `./data`, hier staat `matches.json`).

## 2. Op GitHub zetten

Maak een **private** repository en upload alle bestanden uit deze map (de map `data/` zit niet in de repo, zie `.gitignore`).

## 3. Op Render zetten

Via Blueprint: Render → New → Blueprint → kies de repository (leest `render.yaml`). Vul `EDIT_CODE` in wanneer erom gevraagd wordt.

Of handmatig: New → Web Service → runtime Node, build `npm install`, start `node server.js`, environment variable `EDIT_CODE`, `DATA_DIR=/var/data`, en voeg een Disk toe op `/var/data`.

> **Belangrijk:** het gratis Render-plan heeft een tijdelijk bestandssysteem. Na elke herstart/uitrol of na inactiviteit zijn de matchen dan weg. Een Disk vereist een betaald plan (`render.yaml` gebruikt `starter`). Maak regelmatig een back-up (zie hieronder).

Logs: Render → je service → **Logs** (en **Events** voor uitrollen).

## 3b. Installeren op telefoons

- Android (Chrome): knop "Installeren" in de app, of menu → Toevoegen aan startscherm.
- iPhone (Safari): Deel-icoon → "Zet op beginscherm".

## 4. Eerste keer vullen

Klik op "Matchen uploaden" en kies je xlsx/CSV/JSON. Geef de bewerkingscode in wanneer gevraagd.

## 5. Bewerkingscode

Iedereen met de link kan kijken. Matchen toevoegen, wijzigen, verwijderen of uploaden vraagt de code (wordt onthouden op dat toestel). Na 10 foute pogingen in 10 minuten wordt dat IP tijdelijk geblokkeerd.

## 6. Back-up

Open `https://jouw-app.onrender.com/api/backup?code=JOUWCODE`. Het gedownloade JSON-bestand kan je terugzetten via "Matchen uploaden".
