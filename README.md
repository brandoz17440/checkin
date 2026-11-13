# Check-in

A two-person check-in app: a roster-aware schedule, guided check-ins, an appreciation jar and an ideas board.

This repo holds the app code only. Your data lives in a JSON file in a separate private repo, which the app reads and writes through the GitHub API with a fine-grained access token. Each phone keeps a copy, so it works offline and syncs when it can. When both phones edit at once, the app merges item by item and the newest edit to each item wins.

## Set up

1. **Pages.** In this repo: Settings > Pages > Source: Deploy from a branch > `main` / `(root)` > Save.
2. **Token.** Settings > Developer settings > Personal access tokens > Fine-grained tokens > Generate new token. Repository access: only the private data repo. Permissions: Contents, Read and write.
3. **First phone.** Open the Pages site, tap the gear, fill in GitHub sync and tap Save and sync. Pick who is using the phone.
4. **Second phone.** On the first phone, Setup > Copy setup code, and send it privately. On the second phone, paste it under Setup > Paste a setup code.

On iPhone, add the site to the Home Screen first (Share > Add to Home Screen), open it from the icon, then set it up there. The Home Screen app keeps its own storage, separate from Safari.

## Privacy

GitHub Pages sites are public, so nothing personal goes in this repo. The token sits in each phone's browser storage, and anyone holding it can read and write the data repo. Revoke it on GitHub if a phone is lost.

## Fonts

Atkinson Hyperlegible (Braille Institute) and Bricolage Grotesque, both under the SIL Open Font License. Licence texts are in `fonts/`.
