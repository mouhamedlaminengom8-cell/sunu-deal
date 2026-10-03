# Sunu Deal — version prête pour déploiement

Marketplace sénégalaise en Node.js + Express + SQLite.

## Déploiement recommandé

Le projet est préparé pour un hébergement Docker avec **disque persistant**. Le disque est important car SQLite, les sessions et les photos des annonces sont conservés dans `/data`.

### Option Render

1. Mets le projet dans un dépôt GitHub.
2. Sur Render, crée un nouveau service depuis le dépôt.
3. Le `Dockerfile` et `render.yaml` sont déjà présents.
4. Utilise un disque persistant monté sur `/data`.
5. La variable `SESSION_SECRET` doit être un secret aléatoire long. `render.yaml` peut la générer automatiquement.
6. Après le déploiement, Render fournit une URL publique.

## Variables d'environnement

Voir `.env.example`.

En production :
- `NODE_ENV=production`
- `SESSION_SECRET` obligatoire
- `DATA_DIR=/data`
- `DB_PATH=/data/sunu-deal.db`
- `UPLOADS_DIR=/data/uploads`

## Lancer localement

```bash
npm install
npm start
```

Puis ouvre `http://localhost:3000`.

## Sécurité déjà ajoutée

- secret de session obligatoire en production
- cookies `secure` en HTTPS
- Helmet
- limitation de débit globale
- sessions stockées dans SQLite plutôt que dans le MemoryStore Express
- limite d'upload à 5 Mo
- types d'images limités à JPEG/PNG/WebP
- serveur écoutant sur `0.0.0.0`
- stockage configurable pour base, sessions et photos

## À prévoir avant une vraie audience

- modération et signalement des annonces
- vérification plus stricte des données utilisateur
- protection CSRF adaptée à l'architecture finale
- sauvegardes automatiques
- stockage objet pour les images à grande échelle
- PostgreSQL si le trafic devient important
- système de paiement uniquement après intégration d'un prestataire adapté au Sénégal
