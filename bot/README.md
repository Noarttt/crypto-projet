# Bot DeFi – phase 1 : enregistrement

Le bot **ne trade pas** et ne détient aucune clé de wallet. Il observe et enregistre :

- **Solana** : chaque migration pump.fun → PumpSwap (flux gratuit PumpPortal), puis
  - instantanés prix / capitalisation / liquidité / volume / transactions de +1 à +120 min (DexScreener) ;
  - concentration du top 10 des détenteurs hors pools, autorités de mint et de gel (RPC Solana) à +1 et +10 min ;
  - flux d'achats et de ventes sur la courbe juste avant la migration : acheteurs distincts, flux net, part des 5 plus gros acheteurs ;
  - bougies de 15 s pendant BOOST, puis bougies 1 min sur 2 h 30 (GeckoTerminal).
- **Base** : chaque nouveau pool coté en WETH ou USDC (GeckoTerminal), avec instantanés de +5 à +120 min. Le suivi détaillé ne porte que sur les pools assez actifs, pour aider à calibrer le futur déclencheur Base.

Après 2 h 30, il calcule pour chaque jeton :

- le résultat selon les définitions de la stratégie : succès = +50 % en 2 h sans passer d'abord par −25 %, échec = −50 % en 30 min ;
- les métriques BOOST : survivant ou non, volume conservé, creux plus hauts ;
- trois entrées possibles après BOOST : immédiate, sur repli de 10 à 15 %, au creux plus haut ;
- pour chaque entrée, la simulation des règles de sortie validées, frais PumpSwap réels compris : stop −20 %, vente de 55 % à +30 % puis stop remonté à +8 %, vente de 35 % à +80 %, moonbag de 10 % gardée seulement après +80 %, sortie au temps à 60 ou 90 min.

Tous les paramètres sont dans [`config.json`](config.json), que le bot relit toutes les 60 s. Aucun paramètre n'est modifié sans ta validation.

## Installation sur le serveur (Hetzner, Ubuntu 24.04)

Toutes les commandes se lancent en `root` sur le serveur.

```bash
# 1. Node 22 et git
apt update && apt install -y git curl
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs
node --version   # doit afficher v22.x

# 2. Utilisateur dédié, sans droits administrateur
useradd --system --create-home --home-dir /home/defibot --shell /bin/bash defibot
mkdir -p /opt/crypto-projet && chown defibot:defibot /opt/crypto-projet

# 3. Clé de déploiement GitHub (pour publier les bilans sur la branche bot-data)
sudo -u defibot ssh-keygen -t ed25519 -N "" -f /home/defibot/.ssh/id_ed25519 -C defi-bot
cat /home/defibot/.ssh/id_ed25519.pub
```

Ajoute la clé affichée sur GitHub : dépôt **crypto-projet** → *Settings* → *Deploy keys* → *Add deploy key*, coche **Allow write access**.

```bash
# 4. Récupérer le dépôt
sudo -u defibot ssh -o StrictHostKeyChecking=accept-new -T git@github.com || true
sudo -u defibot git clone git@github.com:Noarttt/crypto-projet.git /opt/crypto-projet

# 5. Secrets (à remplir toi-même, jamais dans le chat ni sur GitHub)
cd /opt/crypto-projet/bot
sudo -u defibot cp .env.example .env
sudo -u defibot nano .env          # colle ta clé Helius après HELIUS_API_KEY=
chmod 600 .env
sudo -u defibot mkdir -p data

# 6. Vérifier
sudo -u defibot npm test

# 7. Services : bot, publication toutes les 6 h, récupération de la config toutes les 5 min
cp systemd/*.service systemd/*.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now defi-bot.service defi-bot-publish.timer defi-bot-sync.timer
```

## Suivi

```bash
journalctl -u defi-bot -f                                     # logs en direct
sudo -u defibot node /opt/crypto-projet/bot/scripts/summary.js # bilan immédiat
cat /opt/crypto-projet/bot/data/summary/latest.md
systemctl start defi-bot-publish.service                      # publier tout de suite
```

Les bilans et le journal compressé sont publiés sur la branche **`bot-data`** du dépôt. C'est là que Claude les lit pour faire les points.

## Mettre en pause

Passer `"paused": true` dans `config.json` sur `main` : le serveur récupère la config en 5 min au plus. Pour un arrêt immédiat, lance `systemctl stop defi-bot`. Après une mise à jour du code, lance `systemctl restart defi-bot`.

## Coûts

| Poste | Coût |
|---|---|
| Serveur Hetzner, plus petit modèle | ~4 €/mois |
| PumpPortal (flux des migrations) | gratuit |
| DexScreener, GeckoTerminal | gratuits, avec des débits limités dans `config.json` |
| Helius, offre gratuite | 0 |

## Limites connues de la v1

- Les bougies font une minute : quand le stop et un objectif tombent dans la même bougie, le stop est compté en premier (hypothèse prudente).
- Les 300 derniers trades de la courbe couvrent surtout la fin du bonding. La part des snipers sur tout le lancement et le comportement du créateur viendront avec un module dédié.
- Le barème des frais PumpSwap au-delà de 34 380 SOL de capitalisation reste fixé à 0,75 % par côté, ce qui est prudent.
- La veille sociale (Telegram, LunarCrush, X, Reddit) n'est pas encore branchée.
- Le format exact des messages PumpPortal est vérifié au démarrage : les 20 premiers messages bruts sont journalisés (`pumpportal_brut`).
