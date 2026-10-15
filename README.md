# AeroLog

Carnet de vols auto-hébergé, inspiré de [perdian/flightlog](https://github.com/perdian/flightlog), pensé pour le personnel navigant comme pour les passagers, avec **import des trajectoires réelles Flightradar24 (KML/CSV)**.

## Fonctionnalités

- Vols en tant que **passager**, **équipage** (fonction à bord libre : CDB, OPL, CCP, PNC…) ou **MEP**
- Autocomplétion aéroports (IATA / OACI / ville), compagnies, types d'avion — base OpenFlights embarquée, aucun service externe requis pour les données
- Heures prévues et réelles en **heure locale** de chaque aéroport ; durée calculée avec les fuseaux horaires (changements d'heure inclus)
- **Import KML Flightradar24** : trace colorée par altitude, profil altitude/vitesse interactif (survol = position sur la carte), distance réellement parcourue
- **Pré-remplissage** depuis le KML : aéroports (point le plus proche du 1er/dernier point), date, heures, n° de vol / indicatif (nom du fichier FR24 « AF1234/AFR1234 »), compagnie
- **Import groupé** de KML : un vol créé par fichier
- Cartes vectorielles **MapLibre GL + OpenFreeMap** (Sombre, Fiord, Clair, Liberty, Bright) avec **vue globe**, sélecteur de fond sur chaque carte
- Tableau de bord avec carte de tous les vols, filtres par rôle et par année
- Statistiques : années (ventilées par rôle), saisonnalité, aéroports, compagnies, liaisons, types, immatriculations, pays, fonctions, classes, records
- **Import depuis FlightLog** (perdian/flightlog) : exports JSON et XML (menu *Export*), y compris vols équipage (motif CREW → rôle Équipage)
- Export / import **JSON** (sauvegarde complète avec traces) et **CSV**
- Mot de passe d'accès optionnel, base **SQLite** unique (`/data/aerolog.db`)

## Application mobile (Android)

AeroLog est une PWA installable : dans Chrome Android, ouvrir l'adresse de l'app puis menu ⋮ → **Installer l'application** (ou le bouton « Installer l'app » en haut de page).

- Icône sur l'écran d'accueil, plein écran, barre d'onglets en bas
- Consultation hors connexion des pages déjà ouvertes
- **Partage direct** : depuis le gestionnaire de fichiers ou le navigateur, *Partager* un fichier KML/CSV → **AeroLog** ouvre le formulaire pré-rempli
- Raccourcis (appui long sur l'icône) : *Nouveau vol*, *Mes vols*

⚠️ L'installation exige **HTTPS** : exposez l'app via un nom de domaine dans RunTipi (ou un tunnel). En `http://IP:port` sur le réseau local, Chrome ne propose qu'un simple raccourci, sans hors-ligne ni partage.

## Récupérer un KML sur Flightradar24

Sur la page historique d'un vol (*Data → Flights → Playback*), bouton **KML** (ou CSV). Un abonnement FR24 peut être nécessaire selon l'ancienneté du vol.

## Démarrage rapide

```bash
docker compose up -d --build      # http://localhost:8080
```

ou sans Docker (Node ≥ 22.13) :

```bash
npm ci && npm start
```

## Variables d'environnement

| Variable | Défaut | Rôle |
|---|---|---|
| `PORT` | `8080` | Port d'écoute |
| `AEROLOG_DATA_DIR` | `/data` (Docker) | Dossier de la base SQLite |
| `AEROLOG_PASSWORD` | *(vide)* | Mot de passe d'accès ; vide = pas d'authentification |
| `AEROLOG_MAP_STYLE` | `dark` | Fond par défaut : `dark`, `fiord`, `positron`, `liberty`, `bright` ou URL d'un style MapLibre |
| `AEROLOG_SECRET` | généré et stocké en base | Clé de signature des sessions |

## Déploiement sur RunTipi

1. Pousser ce dossier dans un dépôt GitHub (ex. `aerolog`), puis créer un tag : `git tag v1.0.0 && git push --tags`.
   Le workflow `.github/workflows/docker.yml` publie l'image `ghcr.io/<compte>/aerolog:1.0.0` (amd64 + arm64).
2. Dans GitHub → *Packages* → `aerolog` → *Package settings*, passer la visibilité en **Public** (sinon RunTipi ne peut pas la télécharger).
3. Utiliser le dossier `runtipi-appstore` fourni (voir son README) comme app store personnel.

**Variante sans registre** : sur la machine RunTipi, `docker build -t ghcr.io/<compte>/aerolog:1.0.0 .` — l'image locale sera utilisée directement.

## API

`GET/POST /api/flights`, `GET/PUT/DELETE /api/flights/:id`, `PUT/DELETE /api/flights/:id/track` (corps `{filename, content}`), `POST /api/track/parse`, `GET /api/stats`, `GET /api/export.json|csv`, `POST /api/import?mode=append|replace`.

## Crédits

Données aéroports/compagnies/avions : [OpenFlights](https://openflights.org/data.html) (ODbL). Cartographie : MapLibre GL JS, fonds [OpenFreeMap](https://openfreemap.org) © OpenMapTiles, données © OpenStreetMap. Logos compagnies : pics.avs.io.
