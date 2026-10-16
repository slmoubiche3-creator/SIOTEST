# TODO

## À faire par l'assistant

## En attente de l'utilisateur
- [ ] Supprimer sur GitHub la dernière branche autre que main, qui finit par « systeme-message-triage-tool-vmd9bc » (déjà incluse dans main ; page Branches → icône corbeille) | maintenant | ajouté 2026-10-16
- [ ] n8n, workflow « Inbox Triage – Intake », nœud « Send To Inbox Triage » : remplacer l'URL d'exemple par l'adresse publique de l'outil (`https://…/api/messages`) | quand l'outil a une adresse publique | ajouté 2026-10-16

## Conditionnel
- [ ] Mettre une clé OpenAI valide (avec crédit) dans n8n → Credentials → « OpenAI account », puis reconnecter n8n dans Settings ⚙ (URL + secret) | quand tu as 5 minutes | ajouté 2026-10-16
- [ ] Tester le moteur IA (Anthropic ou n8n dans Settings ⚙, puis `npm run eval -- data/holdout.csv`) | quand un moteur IA est connecté | ajouté 2026-10-16
- [ ] Tester une vraie alerte Slack | quand un webhook Slack de test est disponible | ajouté 2026-10-16
- [ ] Essayer le workflow d'entrée n8n (déjà publié) de bout en bout (un vrai message → n8n → outil), puis brancher Gmail ou un chat devant | quand l'URL ci-dessus est mise | ajouté 2026-10-16
