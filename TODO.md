# TODO

## À faire par l'assistant

## En attente de l'utilisateur
- [ ] Vérifier que le recruteur peut ouvrir le dépôt (public, ou accès donné) | avant d'envoyer le DM | ajouté 2026-10-16
- [ ] Supprimer l'ancienne branche de travail sur GitHub (page Branches → icône corbeille) | maintenant | ajouté 2026-10-16
- [ ] n8n, workflow « Inbox Triage – Intake » : sur le webhook, remplacer l'identifiant « Header Auth account » (celui du workflow IA) par un nouveau Header Auth (nom `X-Intake-Secret`, valeur = un long secret) | avant de publier ce workflow | ajouté 2026-10-16
- [ ] n8n, même workflow : sur « Send To Inbox Triage », créer un Header Auth (nom `X-Ingest-Token`, valeur = l'`INGEST_TOKEN` de l'outil) et mettre l'adresse publique de l'outil (`https://…/api/messages`) | quand l'outil a une adresse publique | ajouté 2026-10-16

## Conditionnel
- [ ] Mettre une clé OpenAI valide (avec crédit) dans n8n → Credentials → « OpenAI account », puis reconnecter n8n dans Settings ⚙ (URL + secret) | quand tu as 5 minutes | ajouté 2026-10-16
- [ ] Tester le moteur IA (Anthropic ou n8n dans Settings ⚙, puis `npm run eval -- data/holdout.csv`) | quand un moteur IA est connecté | ajouté 2026-10-16
- [ ] Tester une vraie alerte Slack | quand un webhook Slack de test est disponible | ajouté 2026-10-16
- [ ] Publier le workflow d'entrée n8n et l'essayer de bout en bout (un vrai message → n8n → outil), puis brancher Gmail ou un chat devant | quand l'outil a une adresse publique et les deux identifiants ci-dessus | ajouté 2026-10-16
